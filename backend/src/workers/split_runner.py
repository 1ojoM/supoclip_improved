"""Killable process boundary for one long-video download and stream copy."""

import asyncio
import sys

from ..services.video_split_service import _process_video_split
from ..observability import configure_logging, set_trace_id

if __name__ == "__main__":
    configure_logging()
    set_trace_id(f"split-{sys.argv[1]}")
    asyncio.run(_process_video_split({}, sys.argv[1]))
