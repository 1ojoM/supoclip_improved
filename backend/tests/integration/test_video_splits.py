from unittest.mock import AsyncMock
from uuid import uuid4
import subprocess

import pytest
from sqlalchemy import text

from src.api.routes import video_splits
from src.services.video_split_service import list_splits
from tests.fixtures.factories import create_user


@pytest.fixture
async def split_owner(db_session):
    await create_user(db_session, user_id="user-1")
    await db_session.execute(text("DELETE FROM video_splits WHERE user_id = 'user-1'"))
    await db_session.commit()


@pytest.mark.asyncio
async def test_link_is_queued_and_listed_for_its_owner(client, auth_headers, split_owner, db_session):
    response = await client.post("/video-splits", headers=auth_headers, json={
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "part_minutes": 90,
    })
    assert response.status_code == 202
    listed = await client.get("/video-splits", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json()["splits"][0]["id"] == response.json()["id"]
    assert listed.json()["splits"][0]["parts"] == []
    assert await list_splits(db_session, "another-owner") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("minutes", [True, 0, 91, 1.5, "90"])
async def test_invalid_split_length_is_rejected(client, auth_headers, split_owner, minutes):
    response = await client.post("/video-splits", headers=auth_headers, json={
        "url": "https://youtu.be/dQw4w9WgXcQ", "part_minutes": minutes,
    })
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_queue_failure_marks_job_failed(client, app, auth_headers, split_owner, db_session):
    old = app.state.queue_adapter
    class BrokenQueue:
        enqueue_job = AsyncMock(side_effect=RuntimeError("offline"))
    app.state.queue_adapter = BrokenQueue
    try:
        response = await client.post("/video-splits", headers=auth_headers, json={"url": "https://youtu.be/dQw4w9WgXcQ"})
    finally:
        app.state.queue_adapter = old
    assert response.status_code == 503
    assert (await list_splits(db_session, "user-1"))[0]["status"] == "error"


@pytest.mark.asyncio
async def test_third_active_split_is_rejected(client, auth_headers, split_owner):
    for _ in range(2):
        assert (await client.post("/video-splits", headers=auth_headers, json={"url": "https://youtu.be/dQw4w9WgXcQ"})).status_code == 202
    assert (await client.post("/video-splits", headers=auth_headers, json={"url": "https://youtu.be/dQw4w9WgXcQ"})).status_code == 429


@pytest.mark.asyncio
async def test_part_download_requires_ownership(client, auth_headers, split_owner, db_session, monkeypatch):
    split_id, part_id = str(uuid4()), str(uuid4())
    await create_user(db_session, user_id="split-other-owner")
    await db_session.execute(text("""
        INSERT INTO video_splits (id, user_id, source_url, title, part_minutes)
        VALUES (:id, 'split-other-owner', 'https://youtu.be/dQw4w9WgXcQ', 'Private source', 90)
    """), {"id": split_id})
    await db_session.execute(text("""
        INSERT INTO video_split_parts VALUES (:id, :split, 1, 0, 60, 'upload://private.mp4')
    """), {"id": part_id, "split": split_id})
    await db_session.commit()
    storage = AsyncMock()
    monkeypatch.setattr(video_splits, "MediaStorage", storage)
    response = await client.get(f"/video-splits/parts/{part_id}/file", headers=auth_headers)
    assert response.status_code == 404
    assert (await client.delete(f"/video-splits/parts/{part_id}", headers=auth_headers)).status_code == 404
    storage.assert_not_called()
    assert (await client.post(f"/video-splits/{split_id}/cancel", headers=auth_headers)).status_code == 404
    response = await client.post("/tasks/", headers=auth_headers, json={
        "source": {"url": "upload://private.mp4", "split_part_id": part_id},
    })
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_anonymous_split_is_rejected(client):
    assert (await client.get("/video-splits")).status_code == 401


@pytest.mark.asyncio
async def test_split_parts_can_be_downloaded_and_used_for_generation(
    client, app, auth_headers, split_owner, db_session, monkeypatch, tmp_path,
):
    from src.services.video_service import VideoService
    from src.services.video_split_service import _process_video_split as process_video_split
    from src.workers.media_cleanup import _upload_still_unreferenced

    source = tmp_path / "recording.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=2:duration=65",
        "-c:v", "libx264", "-g", "2", "-bf", "0", str(source),
    ], check=True, capture_output=True)
    monkeypatch.setattr(app.state.config, "temp_dir", str(tmp_path))
    monkeypatch.setattr(VideoService, "download_video", AsyncMock(return_value=source))
    analysis = AsyncMock(side_effect=AssertionError("Splitting must not call AI"))
    monkeypatch.setattr(VideoService, "analyze_transcript", analysis)
    created = await client.post("/video-splits", headers=auth_headers, json={
        "url": "https://youtu.be/dQw4w9WgXcQ", "source_duration": 65, "ranges": [{"start": 10, "end": 20}, {"start": 40, "end": 65}],
    })
    assert created.status_code == 202
    await process_video_split({}, created.json()["id"])
    split = (await client.get("/video-splits", headers=auth_headers)).json()["splits"][0]
    assert split["status"] == "completed"
    assert len(split["parts"]) == 2
    part = split["parts"][0]
    assert abs(part["duration_seconds"] - 10) < .1
    assert abs(part["start_seconds"] - 10) <= 1
    assert abs(split["parts"][1]["start_seconds"] - 40) <= 1
    download = await client.get(f"/video-splits/parts/{part['id']}/file", headers=auth_headers)
    assert download.status_code == 200
    assert download.headers["content-type"] == "video/mp4"
    assert download.content
    # Saved split parts remain protected even before a generation references them.
    assert not await _upload_still_unreferenced(db_session, part["video_path"])
    generated = await client.post("/tasks/", headers=auth_headers, json={
        "source": {"url": part["video_path"], "split_part_id": part["id"]},
    })
    assert generated.status_code in {200, 202}, generated.text
    urls = (await db_session.execute(text("""
        SELECT s.url FROM sources s JOIN tasks t ON t.source_id = s.id WHERE t.user_id = 'user-1'
    """))).scalars().all()
    assert part["video_path"] in urls
    analysis.assert_not_called()
    # A generation that already references a part must survive cleanup.
    from src.services.video_split_service import cleanup_split
    from src.media.upload_ingest import local_upload_path
    saved = local_upload_path(part["video_path"])
    other = split["parts"][1]
    other_file = local_upload_path(other["video_path"])
    assert (await client.delete(f"/video-splits/parts/{other['id']}", headers=auth_headers)).status_code == 204
    assert not other_file.exists()
    assert saved.is_file()
    assert (await client.delete(f"/video-splits/parts/{part['id']}", headers=auth_headers)).status_code == 204
    assert saved.is_file()
    assert (await client.get(f"/video-splits/parts/{part['id']}/file", headers=auth_headers)).status_code == 404
    await db_session.execute(text("UPDATE video_splits SET status = 'cancelling' WHERE id = :id"), {"id": split["id"]})
    await db_session.commit()
    await cleanup_split(split["id"])
    assert saved.is_file()
    assert (await db_session.execute(text("SELECT COUNT(*) FROM media_upload_sessions WHERE video_path = :url"), {"url": part["video_path"]})).scalar() == 1


@pytest.mark.asyncio
async def test_queued_cancel_is_immediate_and_idempotent(client, auth_headers, split_owner, db_session):
    result = await client.post("/video-splits", headers=auth_headers, json={"url": "https://youtu.be/dQw4w9WgXcQ"})
    url = f"/video-splits/{result.json()['id']}/cancel"
    assert (await client.post(url, headers=auth_headers)).json()["status"] == "cancelled"
    assert (await client.post(url, headers=auth_headers)).json()["status"] == "cancelled"
    assert (await list_splits(db_session, "user-1"))[0]["status"] == "cancelled"
    from src.services.video_split_service import _update, SplitCancelled
    with pytest.raises(SplitCancelled):
        await _update(db_session, result.json()["id"], "completed", 100)


@pytest.mark.asyncio
async def test_metadata_is_read_before_selection(client, auth_headers, monkeypatch):
    monkeypatch.setattr(video_splits, "async_get_youtube_video_info", AsyncMock(return_value={"title": "Recording", "duration": 18000}))
    response = await client.post("/video-splits/inspect", headers=auth_headers, json={"url": "https://youtu.be/dQw4w9WgXcQ"})
    assert response.status_code == 200
    assert response.json() == {"title": "Recording", "duration": 18000}


@pytest.mark.asyncio
async def test_running_cancel_kills_the_process_and_cleans_published_and_unpublished_parts(
    client, app, auth_headers, split_owner, db_session, tmp_path, monkeypatch,
):
    import asyncio
    import sys
    from src.services import video_split_service as service
    monkeypatch.setattr(app.state.config, "temp_dir", str(tmp_path))
    result = await client.post("/video-splits", headers=auth_headers, json={
        "url": "https://youtu.be/dQw4w9WgXcQ", "source_duration": 120, "ranges": [{"start": 0, "end": 60}, {"start": 90, "end": 120}],
    })
    split_id = result.json()["id"]
    await db_session.execute(text("UPDATE video_splits SET status = 'processing' WHERE id = :id"), {"id": split_id})
    part_id = str(uuid4())
    files = [tmp_path / "uploads" / f"split-{split_id}-{number:03d}.mp4" for number in (1, 2)]
    files[0].parent.mkdir(parents=True)
    for path in files:
        path.write_bytes(b"a completed or interrupted part")
    video_path = f"upload://{files[0].name}"
    await db_session.execute(text("INSERT INTO media_upload_sessions (id, user_id, video_path, state, size) VALUES (:id, 'user-1', :url, 'completed', 20)"), {"id": part_id, "url": video_path})
    await db_session.execute(text("INSERT INTO video_split_parts VALUES (:id, :split, 1, 0, 60, :url)"), {"id": part_id, "split": split_id, "url": video_path})
    await db_session.commit()
    real_launch = asyncio.create_subprocess_exec
    launched = asyncio.Event()
    child = None
    async def launch(*args, **kwargs):
        nonlocal child
        child = await real_launch(sys.executable, "-c", "import time; time.sleep(600)", start_new_session=True)
        launched.set()
        return child
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    job = asyncio.create_task(service.process_video_split({}, split_id))
    await asyncio.wait_for(launched.wait(), 5)
    response = await client.post(f"/video-splits/{split_id}/cancel", headers=auth_headers)
    assert response.status_code == 202
    assert response.json()["status"] == "cancelling"
    await asyncio.wait_for(job, 10)
    assert child.returncode is not None
    assert not any(path.exists() for path in files)
    assert not (tmp_path / "split-work" / split_id).exists()
    split = (await list_splits(db_session, "user-1"))[0]
    assert split["status"] == "cancelled"
    assert split["parts"] == []
    assert (await db_session.execute(text("SELECT COUNT(*) FROM media_upload_sessions WHERE id = :id"), {"id": part_id})).scalar() == 0
