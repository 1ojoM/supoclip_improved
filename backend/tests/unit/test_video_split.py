import asyncio
import json
import shutil
import subprocess

import pytest

from src.media.video_split import encode_part, split_ranges, validate_ranges, keyframe_ranges


@pytest.mark.parametrize("hours,minutes,count,last", [(3, 90, 2, 5400), (4, 90, 3, 3600), (5, 90, 4, 1800), (5, 45, 7, 1800)])
def test_long_sources_have_contiguous_bounded_parts(hours, minutes, count, last):
    ranges = split_ranges(hours * 3600, minutes)
    assert len(ranges) == count
    assert ranges[0][0] == 0
    assert ranges[-1][1] == last
    assert sum(length for _, length in ranges) == hours * 3600
    assert all(length <= minutes * 60 for _, length in ranges)
    assert all(start + length == next_start for (start, length), (next_start, _) in zip(ranges, ranges[1:]))


@pytest.mark.parametrize("minutes", [True, 0, -1, 91, "90", 1.5, None])
def test_invalid_lengths_are_rejected(minutes):
    with pytest.raises(ValueError):
        split_ranges(3600, minutes)


@pytest.mark.parametrize("duration", [0, -1, float("nan"), float("inf"), 86401])
def test_invalid_source_duration_is_rejected(duration):
    with pytest.raises(ValueError):
        split_ranges(duration, 90)


def test_fractional_tail_is_not_lost():
    assert split_ranges(120.25, 1) == [(0.0, 60), (60.0, 60), (120.0, .25)]


@pytest.mark.asyncio
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is required")
async def test_stream_copy_preserves_codecs_and_uses_keyframe_boundaries(tmp_path):
    source = tmp_path / "source.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264",
        "-g", "10", "-bf", "0", "-c:a", "aac", "-shortest", str(source),
    ], check=True, capture_output=True)
    def packet_hashes(path):
        result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
        return set(result.stdout.strip().splitlines())
    original_packets = packet_hashes(source)
    snapped = keyframe_ranges(source, [(0, 1.5), (1.5, 1.5), (3, 1)], 4)
    assert snapped == [(0, 1), (1, 2), (3, 1)]
    for index, (start, length) in enumerate(snapped):
        output = tmp_path / f"part-{index}.mp4"
        await encode_part(source, output, start, length)
        result = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name",
            "-of", "json", str(output),
        ], check=True, capture_output=True, text=True)
        data = json.loads(result.stdout)
        assert abs(float(data["format"]["duration"]) - length) < .25
        assert packet_hashes(output) <= original_packets
        assert {s["codec_type"]: s["codec_name"] for s in data["streams"]} == {"video": "h264", "audio": "aac"}
    assert source.is_file()


@pytest.mark.asyncio
async def test_encoding_cancellation_kills_the_child(monkeypatch, tmp_path):
    class Process:
        returncode = None
        killed = False
        async def communicate(self):
            raise asyncio.CancelledError
        def kill(self):
            self.killed = True
        async def wait(self):
            self.returncode = -9
    process = Process()
    async def launch(*args, **kwargs):
        return process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    with pytest.raises(asyncio.CancelledError):
        await encode_part(tmp_path / "in.mp4", tmp_path / "out.mp4", 0, 10)
    assert process.killed


@pytest.mark.parametrize("value", [[], [{"start": 5, "end": 4}], [{"start": -1, "end": 10}], [{"start": 0, "end": 5401}], [{"start": 0, "end": 10}, {"start": 9, "end": 15}], [{"start": True, "end": 10}], [{"start": 0, "end": float("nan")}], [{"start": 0, "end": 10001}]])
def test_invalid_selections_are_rejected(value):
    with pytest.raises(ValueError):
        validate_ranges(value, 10000)


def test_selections_allow_discarded_gaps():
    assert validate_ranges([{"start": 10, "end": 20}, {"start": 50, "end": 80}], 100) == [(10, 10), (50, 30)]


def test_long_copies_leave_room_for_packet_duration_at_the_generation_limit(monkeypatch):
    from types import SimpleNamespace
    from pathlib import Path
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout="0\n5398\n5400\n7200\n"))
    assert keyframe_ranges(Path("source.mp4"), [(0, 5400)], 7200) == [(0, 5398)]


def test_shared_download_is_reused_without_copying_and_survives_private_cleanup(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from src.services.video_split_service import _reuse_shared_source
    from src import youtube_source
    shared = tmp_path / "shared"
    private = tmp_path / "private"
    shared.mkdir()
    private.mkdir()
    original = shared / "video.mp4"
    original.write_bytes(b"already downloaded video")
    monkeypatch.setenv("VIDEO_SPLIT_OUTPUT_DIR", str(shared))
    monkeypatch.setattr(youtube_source, "cached_full_media", lambda *args, **kwargs: original)
    reused = _reuse_shared_source("https://youtu.be/dQw4w9WgXcQ", SimpleNamespace(temp_dir=str(private)))
    assert reused.stat().st_ino == original.stat().st_ino
    reused.unlink()
    assert original.read_bytes() == b"already downloaded video"
