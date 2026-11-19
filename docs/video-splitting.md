# Select and split long videos

Open **Split video**, paste a finished YouTube, Twitch or Kick recording link,
and choose **Load video**. After the duration is read, select the number of
parts (1–40). The initial selections are spread across the source, each up to
90 minutes. Drag each numbered part's start/end handles on the shared timeline,
drag a coloured part to move it, or enter its boundaries as `HH:MM:SS`.
Use the trash button to remove any selection. Finished parts also have individual delete buttons. Uncoloured gaps are discarded. Selections must not overlap. Sources up to
24 hours are supported; live broadcasts are not supported.

Splitting uses FFmpeg stream copy (`-c copy`), preserving the compressed video
and audio without re-encoding or AI calls. Boundaries snap to nearby video
keyframes, so they can shift by a few seconds. A very short selection without
usable keyframe boundaries must be widened. Output is MP4; a source with
codecs that cannot be copied into MP4 is reported as failed. Downloading a
multi-hour source can still take time.

**Cancel and clear** stops a queued/running split and clears its work. Every
new job runs in a separate process group with a private scratch directory;
cancellation terminates downloading, provider threads, and FFmpeg together.
Committed parts and destinations not yet published in the database are cleaned
through the media deletion outbox. Failed remote deletions remain queued for
retry. Parts already used by another generation remain available to that
generation. Interrupted cancellations are recovered by the cron worker.

Download a finished part or select **Generate clips** beside it. Create also
has **Choose a split video part**. The selected part goes through the normal
generation workflow, including its existing duration, upload-size and billing
limits. PostgreSQL holds jobs, selections, statuses and part metadata. With
object storage enabled, outputs are copied to the media bucket. With local
storage, API and worker must share the uploads volume.

`VIDEO_SPLIT_MAX_DOWNLOAD_BYTES` defaults to 20 GB for YouTube downloads in this
mode. Twitch and Kick retain their existing provider size limits, including
`YOUTUBE_DOWNLOAD_MAX_BYTES`. The ordinary generator's byte budget is unchanged.

Deploy API, video worker, cron worker and frontend together after active jobs
finish. Backend startup applies `20261118_0001_video_splits.sql` and
`20261118_0002_video_split_ranges.sql`. The legacy `part_minutes` API field still
works for consecutive automatic splits. New requests send `ranges` (an array
of `{start, end}` values in seconds) and `source_duration`.
