export interface VideoPart {
  id: string;
  part_number: number;
  start_seconds: number;
  duration_seconds: number;
  video_path: string;
}

export interface VideoSplit {
  id: string;
  source_url: string;
  title: string;
  part_minutes: number;
  status: "queued" | "processing" | "cancelling" | "cancelled" | "completed" | "error";
  selected_ranges?: SplitRange[] | null;
  progress: number;
  error: string | null;
  parts: VideoPart[];
}

export type SelectedVideoPart = VideoPart & { title: string };

export async function fetchVideoSplitState(signal?: AbortSignal): Promise<{ splits: VideoSplit[]; ready: boolean }> {
  const response = await fetch("/api/video-splits", { cache: "no-store", signal });
  if (!response.ok) throw new Error("Could not load video parts");
  const data = await response.json();
  return { splits: Array.isArray(data?.splits) ? data.splits : [], ready: data?.capabilities?.stream_copy === true };
}

export async function fetchVideoSplits(signal?: AbortSignal): Promise<VideoSplit[]> {
  return (await fetchVideoSplitState(signal)).splits;
}

export function videoTime(seconds: number): string {
  const total = Math.round(seconds);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((value) => String(value).padStart(2, "0")).join(":");
}

export interface SplitRange { start: number; end: number }
export const MAX_SPLIT_SECONDS = 90 * 60;

export function initialSplitRanges(duration: number, count: number): SplitRange[] {
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * duration / count);
    return { start, end: Math.min(Math.floor((index + 1) * duration / count), start + MAX_SPLIT_SECONDS) };
  });
}

export function moveSplitBoundary(ranges: SplitRange[], index: number, edge: "start" | "end", value: number, duration: number): SplitRange[] {
  const part = ranges[index];
  const low = edge === "start" ? Math.max(ranges[index - 1]?.end ?? 0, part.end - MAX_SPLIT_SECONDS) : part.start + 1;
  const high = edge === "start" ? part.end - 1 : Math.min(ranges[index + 1]?.start ?? duration, part.start + MAX_SPLIT_SECONDS);
  return ranges.map((range, i) => i === index ? { ...range, [edge]: Math.max(low, Math.min(high, Math.round(value))) } : range);
}

export function parseVideoTime(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
