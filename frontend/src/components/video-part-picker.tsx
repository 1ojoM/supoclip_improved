"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { fetchVideoSplits, videoTime, type SelectedVideoPart } from "@/lib/video-splits";

export function VideoPartPicker({ selectedId, requestedId, disabled, onSelect }: {
  selectedId?: string;
  requestedId: string | null;
  disabled: boolean;
  onSelect: (part: SelectedVideoPart | null) => void;
}) {
  const t = useTranslations("home.videoSplit");
  const [open, setOpen] = useState(Boolean(requestedId));
  const [parts, setParts] = useState<SelectedVideoPart[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    fetchVideoSplits(controller.signal).then((splits) => {
      const available = splits.filter((split) => !["cancelling", "cancelled"].includes(split.status)).flatMap((split) => split.parts.map((part) => ({ ...part, title: split.title })));
      setParts(available);
      if (requestedId) {
        const part = available.find((part) => part.id === requestedId);
        if (part) onSelect(part);
        else setError(true);
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, requestedId, onSelect]);

  return <div className="mt-4 space-y-2 text-sm">
    <button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)} className="text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50">{t("choosePart")}</button>
    {open && <div className="space-y-2 rounded-xl border bg-background p-3">
      <label htmlFor="split-part" className="block font-medium">{t("choosePart")}</label>
      <select id="split-part" value={selectedId ?? ""} disabled={disabled || loading} onChange={(event) => onSelect(parts.find((part) => part.id === event.target.value) ?? null)} className="h-10 w-full min-w-0 rounded-lg border bg-background px-2">
        <option value="">{loading ? t("loading") : t("noSelection")}</option>
        {parts.map((part) => <option key={part.id} value={part.id}>{t("part", { number: part.part_number })} · {videoTime(part.duration_seconds)} · {part.title}</option>)}
      </select>
      {error && <p role="alert" className="text-destructive">{t("loadError")}</p>}
      {!loading && !parts.length && !error && <p className="text-muted-foreground">{t("emptyParts")}</p>}
      <Link href="/split" className="inline-block underline underline-offset-4">{t("title")}</Link>
    </div>}
  </div>;
}
