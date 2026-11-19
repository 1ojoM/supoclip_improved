"""Persistent split jobs and reusable, account-owned source parts."""

import asyncio
import errno
import logging
import os
import shutil
import signal
import sys
from copy import copy
import tempfile
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text

from ..config import get_config
from ..database import AsyncSessionLocal
from ..local_volume import volume_id
from ..media.source_limits import probe_media_duration
from ..media.video_split import encode_part, split_ranges, validate_ranges, keyframe_ranges
from ..media_storage import MediaStorage, owner_key
from ..runtime_settings import load_runtime_settings_cache
from ..utils.async_helpers import run_in_thread

logger = logging.getLogger(__name__)


async def list_splits(db, user_id: str) -> list[dict]:
    rows = (await db.execute(text("""
        SELECT * FROM video_splits WHERE user_id = :owner ORDER BY created_at DESC LIMIT 100
    """), {"owner": user_id})).mappings().all()
    results = [dict(row) | {"parts": []} for row in rows]
    if results:
        parts = (await db.execute(text("""
            SELECT p.* FROM video_split_parts p JOIN video_splits s ON s.id = p.split_id
            WHERE s.user_id = :owner AND s.id = ANY(CAST(:ids AS text[]))
            ORDER BY p.part_number
        """), {"owner": user_id, "ids": [r["id"] for r in results]})).mappings()
        by_id = {row["id"]: row for row in results}
        for part in parts:
            by_id[part["split_id"]]["parts"].append(dict(part))
    return results


async def owned_part(db, user_id: str, part_id: str):
    return (await db.execute(text("""
        SELECT p.*, s.title FROM video_split_parts p JOIN video_splits s ON s.id = p.split_id
        WHERE p.id = :id AND s.user_id = :owner AND s.status NOT IN ('cancelling', 'cancelled')
    """), {"id": part_id, "owner": user_id})).mappings().first()


async def _update(db, split_id: str, status: str, progress: int, error: str | None = None):
    result = await db.execute(text("""
        UPDATE video_splits SET status = :status, progress = :progress, error = :error, updated_at = NOW()
        WHERE id = :id AND status IN ('queued', 'processing')
    """), {"id": split_id, "status": status, "progress": progress, "error": error})
    await db.commit()
    if not result.rowcount:
        raise SplitCancelled()


class SplitCancelled(Exception):
    pass


def _publish_local(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(source, target)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        shutil.copyfile(source, target)
    with target.open("rb+") as handle:
        os.fsync(handle.fileno())


def _publish_remote(storage, source: Path, key: str):
    # A single streaming PUT leaves no unfinished multipart upload when the
    # process is terminated. Parts used for generation obey the upload cap.
    if source.stat().st_size > min(storage.config.max_video_upload_bytes, 5_000_000_000):
        raise ValueError("This part is too large. Select a shorter section.")
    with source.open("rb") as body:
        storage.client.put_object(Bucket=storage.bucket, Key=key, Body=body, ContentType="video/mp4")
    return storage.reference(key)


def _reuse_shared_source(url: str, config) -> Path | None:
    from ..youtube_utils import get_youtube_video_id
    from ..youtube_source import cached_full_media
    output_root = os.getenv("VIDEO_SPLIT_OUTPUT_DIR")
    if not output_root:
        return None
    shared = copy(config)
    shared.temp_dir = output_root
    cached = cached_full_media(get_youtube_video_id(url), config=shared)
    if cached is None:
        return None
    private = Path(config.temp_dir) / "source.mp4"
    try:
        os.link(cached, private)
    except OSError:
        return None
    return private


async def _heartbeat(split_id: str):
    while True:
        await asyncio.sleep(30)
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(text("UPDATE video_splits SET updated_at = NOW() WHERE id = :id AND status = 'processing'"), {"id": split_id})
                await db.commit()
        except Exception:
            logger.warning("Split heartbeat failed for %s", split_id, exc_info=True)


async def recover_video_splits(ctx: dict):
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE video_splits SET status = 'error',
                error = 'Video splitting was interrupted. Submit the link again to retry. Finished parts remain available.'
            WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '15 minutes'
        """))
        await db.commit()
        interrupted_cancellations = (await db.execute(text("SELECT id FROM video_splits WHERE status = 'cancelling' AND updated_at < NOW() - INTERVAL '15 minutes'"))).scalars().all()
    for split_id in interrupted_cancellations:
        await cleanup_split(split_id)


async def stop_split_process(process):
    if process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()


async def process_video_split(ctx: dict, split_id: str):
    # A separate process group makes downloads, provider threads and FFmpeg
    # stoppable together. Its TEMP_DIR is private to this one job.
    async with AsyncSessionLocal() as db:
        status = (await db.execute(text("SELECT status FROM video_splits WHERE id = :id"), {"id": split_id})).scalar()
    if status not in {"queued", "processing"}:
        return
    root = Path(get_config().temp_dir)
    work = root / "split-work" / split_id
    work.mkdir(parents=True, exist_ok=True)
    process = None
    heartbeat = asyncio.create_task(_heartbeat(split_id))
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "src.workers.split_runner", split_id,
            env={**os.environ, "TEMP_DIR": str(work), "VIDEO_SPLIT_OUTPUT_DIR": str(root)},
            start_new_session=True,
        )
        waiter = asyncio.create_task(process.wait())
        while process.returncode is None:
            await asyncio.wait({waiter}, timeout=1)
            async with AsyncSessionLocal() as db:
                status = (await db.execute(text("SELECT status FROM video_splits WHERE id = :id"), {"id": split_id})).scalar()
            if status in {"cancelling", "cancelled"}:
                await stop_split_process(process)
                await cleanup_split(split_id)
                return
            if status in {None, "error"}:
                await stop_split_process(process)
                return
        async with AsyncSessionLocal() as db:
            status = (await db.execute(text("SELECT status FROM video_splits WHERE id = :id"), {"id": split_id})).scalar()
            if status in {"cancelling", "cancelled"}:
                await cleanup_split(split_id)
            elif process.returncode and status != "error":
                await _update(db, split_id, "error", 0, "Video splitting stopped unexpectedly. Please try again.")
    except BaseException:
        if process:
            await stop_split_process(process)
        async with AsyncSessionLocal() as db:
            status = (await db.execute(text("SELECT status FROM video_splits WHERE id = :id"), {"id": split_id})).scalar()
            if status == "cancelling":
                await cleanup_split(split_id)
            elif status not in {"completed", "cancelled", "error"}:
                await _update(db, split_id, "error", 0, "Video splitting was interrupted. Please try again.")
        raise
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        await run_in_thread(shutil.rmtree, work, True)


async def _remove_unreferenced_part_file(db, storage, url: str):
    from ..repositories.media_repository import queue_delete
    referenced = (await db.execute(text("SELECT EXISTS(SELECT 1 FROM sources s JOIN tasks t ON t.source_id = s.id WHERE s.url = :url)"), {"url": url})).scalar()
    if referenced:
        return
    session = (await db.execute(text("SELECT storage_reference FROM media_upload_sessions WHERE video_path = :url"), {"url": url})).first()
    if url.startswith("upload://s3/"):
        await queue_delete(db, storage.source_reference(url))
    else:
        await queue_delete(db, str(Path(get_config().temp_dir) / "uploads" / url.removeprefix("upload://")))
    if session and session.storage_reference:
        await queue_delete(db, session.storage_reference)
    await db.execute(text("DELETE FROM media_upload_sessions WHERE video_path = :url"), {"url": url})


async def delete_split_part(db, user_id: str, part_id: str) -> bool:
    from ..repositories.media_repository import source_guard
    from ..workers.media_cleanup import drain_deletions
    part = await owned_part(db, user_id, part_id)
    if part is None:
        return False
    url = part["video_path"]
    storage = MediaStorage()
    async with source_guard(db, url):
        # Generation creation rechecks this row under the same source lock.
        part = await owned_part(db, user_id, part_id)
        if part is None:
            return False
        await db.execute(text("DELETE FROM video_split_parts WHERE id = :id"), {"id": part_id})
        await _remove_unreferenced_part_file(db, storage, url)
        await db.commit()
    await drain_deletions(db, storage)
    return True


async def cleanup_split(split_id: str):
    from ..repositories.media_repository import source_guard
    from ..workers.media_cleanup import drain_deletions
    storage = MediaStorage()
    async with AsyncSessionLocal() as db:
        row = (await db.execute(text("SELECT * FROM video_splits WHERE id = :id"), {"id": split_id})).mappings().first()
        if row is None or row["status"] not in {"cancelling", "cancelled"}:
            return
        parts = (await db.execute(text("SELECT * FROM video_split_parts WHERE split_id = :id"), {"id": split_id})).mappings().all()
        paths = {part["video_path"] for part in parts}
        # Deterministic destinations also cover a worker killed between an
        # upload/copy and the transaction that publishes the part.
        plan = row["selected_ranges"]
        count = len(plan) if plan else len(split_ranges(row["source_duration"], row["part_minutes"])) if row["source_duration"] else 0
        for number in range(1, count + 1):
            if storage.enabled:
                paths.add(f"upload://s3/{owner_key(row['user_id'])}/split-{split_id}/part-{number:03d}.mp4")
            else:
                paths.add(f"upload://split-{split_id}-{number:03d}.mp4")
        await db.commit()
        for url in paths:
            async with source_guard(db, url):
                await db.execute(text("DELETE FROM video_split_parts WHERE split_id = :id AND video_path = :url"), {"id": split_id, "url": url})
                await _remove_unreferenced_part_file(db, storage, url)
                await db.commit()
        await db.execute(text("UPDATE video_splits SET status = 'cancelled', progress = 0, error = NULL, updated_at = NOW() WHERE id = :id"), {"id": split_id})
        await db.commit()
        await drain_deletions(db, storage, limit=max(100, len(paths) * 2))


async def _process_video_split(ctx: dict, split_id: str):
    # A deterministic ARQ job id prevents duplicate submissions. Completed
    # parts live in Postgres and the media store, and survive worker restarts.
    from .video_service import VideoService
    from ..stream_source import download_stream_video
    from ..youtube_proxy import ByteBudget

    async with AsyncSessionLocal() as db:
        row = (await db.execute(text("SELECT * FROM video_splits WHERE id = :id"), {"id": split_id})).mappings().first()
        if row is None or row["status"] not in {"queued", "processing"}:
            return
        await load_runtime_settings_cache(db)
        await _update(db, split_id, "processing", 1)
        try:
            config = get_config()
            storage = MediaStorage()
            source_type = VideoService.determine_source_type(row["source_url"])
            if source_type == "youtube":
                source = await run_in_thread(_reuse_shared_source, row["source_url"], config)
                if source is None:
                    source = await VideoService.download_video(
                        row["source_url"], task_id=split_id,
                        budget=ByteBudget(config.video_split_max_download_bytes),
                    )
            else:
                source = await run_in_thread(download_stream_video, row["source_url"], None, split_id)
            if not source:
                raise RuntimeError("Source download failed")
            duration = await run_in_thread(probe_media_duration, Path(source))
            if duration is None:
                raise RuntimeError("Video duration could not be read")
            requested = validate_ranges(row["selected_ranges"], duration) if row["selected_ranges"] else split_ranges(duration, row["part_minutes"])
            ranges = await run_in_thread(keyframe_ranges, Path(source), requested, duration)
            await db.execute(text("UPDATE video_splits SET source_duration = :duration WHERE id = :id"), {"id": split_id, "duration": duration})
            await db.commit()
            output_root = Path(os.getenv("VIDEO_SPLIT_OUTPUT_DIR") or config.temp_dir)
            await _update(db, split_id, "processing", 10)
            for index, (start, length) in enumerate(ranges, 1):
                existing = (await db.execute(text("""
                    SELECT 1 FROM video_split_parts WHERE split_id = :id AND part_number = :number
                """), {"id": split_id, "number": index})).first()
                await db.commit()
                if existing:
                    continue
                part_id = str(uuid4())
                with tempfile.TemporaryDirectory(prefix="part-", dir=config.temp_dir) as temporary:
                    output = Path(temporary) / f"part-{index:03d}.mp4"
                    await encode_part(Path(source), output, start, length)
                    actual_duration = await run_in_thread(probe_media_duration, output)
                    if actual_duration is None or abs(actual_duration - length) > 2:
                        raise RuntimeError("Copied part has an unexpected duration")
                    size = output.stat().st_size
                    reference = None
                    if storage.enabled:
                        relative = f"{owner_key(row['user_id'])}/split-{split_id}/part-{index:03d}.mp4"
                        reference = await run_in_thread(_publish_remote, storage, output, storage.key("sources", relative))
                        video_path = f"upload://s3/{relative}"
                    else:
                        name = f"split-{split_id}-{index:03d}.mp4"
                        await run_in_thread(_publish_local, output, output_root / "uploads" / name)
                        video_path = f"upload://{name}"
                    await db.execute(text("""
                        INSERT INTO media_upload_sessions (id, user_id, size, state, video_path, storage_reference, staging_volume)
                        VALUES (:id, :owner, :size, 'completed', :path, :reference, :volume)
                    """), {"id": part_id, "owner": row["user_id"], "size": size,
                           "path": video_path, "reference": reference,
                           "volume": None if storage.enabled else volume_id(str(output_root))})
                    await db.execute(text("""
                        INSERT INTO video_split_parts (id, split_id, part_number, start_seconds, duration_seconds, video_path)
                        VALUES (:id, :split, :number, :start, :duration, :path)
                    """), {"id": part_id, "split": split_id, "number": index, "start": start,
                           "duration": actual_duration, "path": video_path})
                    await _update(db, split_id, "processing", 10 + int(index / len(ranges) * 89))
            await _update(db, split_id, "completed", 100)
        except SplitCancelled:
            await db.rollback()
            return
        except BaseException as exc:
            await db.rollback()
            logger.exception("Video split %s failed", split_id)
            try:
                message = str(exc) if isinstance(exc, ValueError) else "Video splitting was interrupted or failed. Please try again."
                await _update(db, split_id, "error", 0, message)
            except SplitCancelled:
                return
            raise
