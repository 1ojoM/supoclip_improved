"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { MAX_SPLIT_SECONDS, moveSplitBoundary, parseVideoTime, videoTime, type SplitRange } from "@/lib/video-splits";

const COLORS = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#db2777", "#0891b2"];

function TimeInput({ value, label, disabled, onChange }: { value: number; label: string; disabled: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(videoTime(value));
  useEffect(() => setText(videoTime(value)), [value]);
  function commit() {
    const seconds = parseVideoTime(text);
    if (seconds !== null) onChange(seconds);
    setText(videoTime(value));
  }
  return <Input aria-label={label} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)}
    onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }}
    className="h-9 w-28 font-mono text-xs tabular-nums" placeholder="00:00:00" />;
}

export function SplitTimeline({ duration, ranges, disabled, onChange }: {
  duration: number; ranges: SplitRange[]; disabled: boolean; onChange: (ranges: SplitRange[]) => void;
}) {
  const t = useTranslations("home.videoSplit");
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; edge: "start" | "end" | "move"; anchor: number; original: SplitRange } | null>(null);
  function position(clientX: number) {
    const bounds = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - bounds.left) / bounds.width * duration));
  }
  function begin(event: React.PointerEvent<HTMLButtonElement>, index: number, edge: "start" | "end" | "move") {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { index, edge, anchor: position(event.clientX), original: { ...ranges[index] } };
  }
  function move(event: React.PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const value = position(event.clientX);
    if (active.edge !== "move") onChange(moveSplitBoundary(ranges, active.index, active.edge, value, duration));
    else {
      const length = active.original.end - active.original.start;
      const low = ranges[active.index - 1]?.end ?? 0;
      const high = (ranges[active.index + 1]?.start ?? duration) - length;
      const start = Math.max(low, Math.min(high, Math.round(active.original.start + value - active.anchor)));
      onChange(ranges.map((part, i) => i === active.index ? { start, end: start + length } : part));
    }
  }
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("timelineHint")}</p>
    <div className="overflow-x-auto px-4 pb-2">
      <div style={{ minWidth: Math.max(560, ranges.length * 64) }}>
        <div ref={track} className="relative my-9 h-3 rounded-full bg-muted" aria-label={t("timeline")}>
          {ranges.map((part, index) => <div key={index}>
            <button type="button" disabled={disabled} aria-label={t("movePart", { number: index + 1 })}
              onPointerDown={(event) => begin(event, index, "move")} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
              className="absolute top-0 h-3 touch-none rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50"
              style={{ left: `${part.start / duration * 100}%`, width: `${(part.end - part.start) / duration * 100}%`, backgroundColor: COLORS[index % COLORS.length] }}>
              <span className="absolute -top-7 left-1/2 -translate-x-1/2 rounded px-1.5 text-xs font-semibold text-foreground">{index + 1}</span>
            </button>
            {(["start", "end"] as const).map((edge) => <button key={edge} type="button" role="slider" disabled={disabled}
              aria-label={t(edge === "start" ? "startHandle" : "endHandle", { number: index + 1 })}
              aria-valuemin={edge === "start" ? Math.max(ranges[index - 1]?.end ?? 0, part.end - MAX_SPLIT_SECONDS) : part.start + 1}
              aria-valuemax={edge === "start" ? part.end - 1 : Math.min(ranges[index + 1]?.start ?? duration, part.start + MAX_SPLIT_SECONDS)}
              aria-valuenow={part[edge]} aria-valuetext={videoTime(part[edge])}
              onPointerDown={(event) => begin(event, index, edge)} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const value = event.key === "Home" ? 0 : event.key === "End" ? duration : part[edge] + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1);
                onChange(moveSplitBoundary(ranges, index, edge, value, duration));
              }}
              className="absolute z-10 h-7 w-4 -translate-x-1/2 touch-none rounded border-2 bg-background shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              style={{ left: `${part[edge] / duration * 100}%`, top: edge === "start" ? -15 : 1, borderColor: COLORS[index % COLORS.length] }} />)}
          </div>)}
        </div>
        <div className="flex justify-between font-mono text-xs text-muted-foreground"><span>00:00:00</span><span>{videoTime(duration)}</span></div>
      </div>
    </div>
    <div className="space-y-2">{ranges.map((part, index) => <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <span className="mr-auto text-sm font-medium" style={{ color: COLORS[index % COLORS.length] }}>{t("part", { number: index + 1 })}</span>
      <TimeInput label={t("startTime", { number: index + 1 })} value={part.start} disabled={disabled} onChange={(value) => onChange(moveSplitBoundary(ranges, index, "start", value, duration))} />
      <span aria-hidden>–</span><TimeInput label={t("endTime", { number: index + 1 })} value={part.end} disabled={disabled} onChange={(value) => onChange(moveSplitBoundary(ranges, index, "end", value, duration))} />
      <span className="w-20 text-right font-mono text-xs text-muted-foreground">{videoTime(part.end - part.start)}</span>
      <button type="button" disabled={disabled} aria-label={t("deletePart", { number: index + 1 })} title={t("deletePart", { number: index + 1 })} onClick={() => onChange(ranges.filter((_, i) => i !== index))} className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"><Trash2 className="size-4" /></button>
    </div>)}</div>
  </div>;
}
