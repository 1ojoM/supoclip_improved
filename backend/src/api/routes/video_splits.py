"""Authenticated, queued long-video splitting."""

from uuid import uuid4
import json
import math

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth_headers import resolve_authenticated_user_id
from ...config import get_config
from ...database import get_db
from ...media.upload_ingest import local_upload_path
from ...media_storage import MediaStorage
from ...services.video_split_service import list_splits, owned_part, cleanup_split, delete_split_part
from ...services.video_service import VideoService
from ...utils.async_helpers import run_in_thread
from ...media.video_split import validate_ranges
from ...youtube_utils import async_get_youtube_video_info
from ...stream_source import fetch_stream_info
from ...workers.job_queue import JobQueue

router = APIRouter(prefix="/video-splits", tags=["video-splits"])


@router.get("")
async def get_splits(request: Request, db: AsyncSession = Depends(get_db)):
    owner = await resolve_authenticated_user_id(request, db, get_config())
    return {"splits": await list_splits(db, owner), "capabilities": {"stream_copy": True, "timeline": True, "cancellation": True}}


def source_kind(url):
    try:
        kind = VideoService.determine_source_type(url.strip()) if isinstance(url, str) else None
    except ValueError:
        kind = None
    if kind not in {"youtube", "twitch", "kick"}:
        raise HTTPException(422, "Enter a supported YouTube, Twitch or Kick video link")
    return kind


@router.post("/inspect")
async def inspect_source(request: Request, db: AsyncSession = Depends(get_db)):
    await resolve_authenticated_user_id(request, db, get_config())
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Invalid JSON body") from None
    url = body.get("url") if isinstance(body, dict) else None
    kind = source_kind(url)
    try:
        info = await async_get_youtube_video_info(url.strip()) if kind == "youtube" else await run_in_thread(fetch_stream_info, url.strip())
        duration = info.get("duration") if info else None
        if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or not 1 <= duration <= 86400:
            raise ValueError("A finished recording with a known duration of at most 24 hours is required")
    except Exception:
        raise HTTPException(422, "Could not read this video's duration. Use a finished recording and try again.") from None
    return {"duration": duration, "title": str(info.get("title") or url)[:500]}


@router.post("/{split_id}/cancel", status_code=202)
async def cancel_split(split_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    owner = await resolve_authenticated_user_id(request, db, get_config())
    row = (await db.execute(text("SELECT status FROM video_splits WHERE id = :id AND user_id = :owner FOR UPDATE"), {"id": split_id, "owner": owner})).first()
    if row is None:
        raise HTTPException(404, "Video split not found")
    if row.status == "completed":
        raise HTTPException(409, "This split has already finished")
    if row.status == "cancelled":
        return {"status": "cancelled"}
    immediate = row.status in {"queued", "error"}
    await db.execute(text("UPDATE video_splits SET status = 'cancelling', updated_at = NOW() WHERE id = :id"), {"id": split_id})
    await db.commit()
    if immediate:
        await cleanup_split(split_id)
    return {"status": "cancelled" if immediate else "cancelling"}


@router.post("", status_code=202)
async def create_split(request: Request, db: AsyncSession = Depends(get_db)):
    owner = await resolve_authenticated_user_id(request, db, get_config())
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Invalid JSON body") from None
    if not isinstance(body, dict):
        raise HTTPException(422, "Expected an object")
    url = body.get("url")
    minutes = body.get("part_minutes", 90)
    if type(minutes) is not int or not 1 <= minutes <= 90:
        raise HTTPException(422, "Part length must be a whole number from 1 to 90 minutes")
    source_kind(url)
    selected = body.get("ranges")
    duration = body.get("source_duration")
    if selected is not None:
        try:
            validate_ranges(selected, duration)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
    else:
        duration = None
    # Serialize admission across API instances and bound expensive split jobs.
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 71118))"), {"owner": owner})
    active = (await db.execute(text("""
        SELECT COUNT(*) FROM video_splits WHERE user_id = :owner AND status IN ('queued', 'processing', 'cancelling')
    """), {"owner": owner})).scalar_one()
    if active >= 2:
        raise HTTPException(429, "Wait for an existing split to finish before starting another")
    split_id = str(uuid4())
    await db.execute(text("""
        INSERT INTO video_splits (id, user_id, source_url, title, part_minutes, selected_ranges, source_duration)
        VALUES (:id, :owner, :url, :title, :minutes, CAST(:ranges AS JSONB), :duration)
    """), {"id": split_id, "owner": owner, "url": url.strip(), "title": str(body.get("title") or url.strip())[:500], "minutes": minutes, "ranges": json.dumps(selected) if selected is not None else None, "duration": duration})
    await db.commit()
    try:
        queue = getattr(request.app.state, "queue_adapter", JobQueue)
        await queue.enqueue_job("process_video_split", split_id, _job_id=f"split:{split_id}")
    except Exception:
        await db.execute(text("UPDATE video_splits SET status = 'error', error = 'Could not queue splitting. Please try again.' WHERE id = :id"), {"id": split_id})
        await db.commit()
        raise HTTPException(503, "Could not queue splitting. Please try again.") from None
    return {"id": split_id, "status": "queued"}


@router.delete("/parts/{part_id}", status_code=204)
async def remove_part(part_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    owner = await resolve_authenticated_user_id(request, db, get_config())
    if not await delete_split_part(db, owner, part_id):
        raise HTTPException(404, "Video part not found")
    return Response(status_code=204)


@router.get("/parts/{part_id}/file")
async def download_part(part_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    owner = await resolve_authenticated_user_id(request, db, get_config())
    part = await owned_part(db, owner, part_id)
    if part is None:
        raise HTTPException(404, "Video part not found")
    video_path = part["video_path"]
    filename = f"part-{part['part_number']:03d}.mp4"
    await db.commit()
    storage = MediaStorage()
    if video_path.startswith("upload://s3/"):
        reference = storage.source_reference(video_path)
        return RedirectResponse(await run_in_thread(storage.signed_url, reference, filename, attachment=True))
    path = local_upload_path(video_path)
    if not path.is_file():
        raise HTTPException(404, "Video part is unavailable on this server")
    return FileResponse(path, media_type="video/mp4", filename=filename)
