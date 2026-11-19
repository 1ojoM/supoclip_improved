"""Fast cuts by copying compressed streams. No encoders or model calls."""

import asyncio
from bisect import bisect_left, bisect_right
import math
from pathlib import Path
import subprocess

MAX_PART_SECONDS = 90 * 60
MAX_PARTS = 40


def split_ranges(duration: float, part_minutes: int) -> list[tuple[float, float]]:
    if type(part_minutes) is not int or not 1 <= part_minutes <= 90:
        raise ValueError("Part length must be a whole number from 1 to 90 minutes")
    if not math.isfinite(duration) or duration <= 0 or duration > 24 * 3600:
        raise ValueError("Video must have a known length of at most 24 hours")
    seconds = part_minutes * 60
    return [(float(start), min(seconds, duration - start))
            for start in range(0, math.ceil(duration), seconds)]


def validate_ranges(value, duration: float) -> list[tuple[float, float]]:
    if not isinstance(duration, (float, int)) or isinstance(duration, bool) or not math.isfinite(duration) or not 0 < duration <= 86400:
        raise ValueError("Video must have a known length of at most 24 hours")
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PARTS:
        raise ValueError("Choose between 1 and 40 parts")
    ranges = []
    previous_end = 0
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("Each part needs a start and end")
        start, end = item.get("start"), item.get("end")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (start, end)):
            raise ValueError("Part boundaries must be finite numbers")
        if start < previous_end or end > duration + .1 or not 1 <= end - start <= MAX_PART_SECONDS:
            raise ValueError("Parts must be ordered, must not overlap, and must last between 1 second and 90 minutes")
        ranges.append((float(start), float(end - start)))
        previous_end = end
    return ranges


def keyframe_ranges(source: Path, ranges: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-skip_frame", "nokey", "-select_streams", "v:0",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(source),
    ], capture_output=True, text=True, check=True, timeout=600)
    points = {0.0, duration}
    for line in result.stdout.splitlines():
        try:
            timestamp = float(line.split(",")[0])
        except ValueError:
            continue
        if math.isfinite(timestamp) and 0 <= timestamp <= duration:
            points.add(timestamp)
    points = sorted(points)
    def nearest(value):
        index = bisect_left(points, value)
        return min(points[max(0, index - 1):index + 1], key=lambda p: abs(p - value))
    snapped = []
    for start, length in ranges:
        first, last = nearest(start), nearest(start + length)
        # Copied B-frame/AAC packets may extend the container slightly past
        # the cut. Leave room under the generator's 90-minute source limit.
        if last - first > MAX_PART_SECONDS - 2:
            last = points[max(0, bisect_right(points, first + MAX_PART_SECONDS - 2) - 1)]
        if last <= first:
            raise ValueError("A selected part is shorter than the distance between keyframes. Widen the selection.")
        snapped.append((first, last - first))
    return snapped


async def encode_part(source: Path, output: Path, start: float, duration: float) -> None:
    # Retain the public helper name for callers; this only remuxes packets.
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", str(start), "-i", str(source), "-t", str(duration),
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(output),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=3600)
        if process.returncode:
            raise RuntimeError(f"Stream copy failed: {stderr.decode(errors='replace')[-1000:]}")
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("Stream copy produced an empty file")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
