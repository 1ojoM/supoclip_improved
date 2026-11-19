"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Scissors, Loader2, Download, Sparkles, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/auth-client";
import { validateVideoSourceUrl } from "@/lib/video-upload";
import { fetchVideoSplitState, initialSplitRanges, videoTime, type SplitRange, type VideoSplit } from "@/lib/video-splits";
import { SplitTimeline } from "@/components/split-timeline";

export default function VideoSplitPage() {
  const t = useTranslations("home.videoSplit");
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id;
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<{ duration: number; title: string } | null>(null);
  const [ranges, setRanges] = useState<SplitRange[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [splits, setSplits] = useState<VideoSplit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    const data = await fetchVideoSplitState();
    setSplits(data.splits);
    setReady(data.ready);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = () => refresh().catch(() => { if (!cancelled) setError(t("loadError")); });
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [userId, refresh, t]);

  async function inspect() {
    if (validateVideoSourceUrl(url).error) { setError(t("invalidUrl")); return; }
    setInspecting(true);
    setError(null);
    try {
      const response = await fetch("/api/video-splits/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : t("inspectError"));
      setSource(body);
      setRanges(initialSplitRanges(body.duration, Math.max(1, Math.ceil(body.duration / 5400))));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("inspectError")); }
    finally { setInspecting(false); }
  }

  async function cancel(id: string) {
    setCancelling(id);
    setError(null);
    try {
      const response = await fetch(`/api/video-splits/${id}/cancel`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(typeof body.detail === "string" ? body.detail : t("cancelError"));
      }
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("cancelError")); }
    finally { setCancelling(null); }
  }

  async function deletePart(id: string) {
    setDeleting(id);
    setError(null);
    try {
      const response = await fetch(`/api/video-splits/parts/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(t("deleteError"));
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("deleteError")); }
    finally { setDeleting(null); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!source) { await inspect(); return; }
    if (!ranges.length) { setError(t("emptySelection")); return; }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/video-splits", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), title: source.title, source_duration: source.duration, ranges }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(typeof body.detail === "string" ? body.detail : t("submitError"));
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("submitError"));
    } finally { setBusy(false); }
  }

  return <AppShell><main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-8 md:py-10">
    <header><div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-muted"><Scissors className="size-5" /></div>
      <h1 className="font-display text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-2 text-muted-foreground">{t("description")}</p>
    </header>
    {isPending ? <p role="status">{t("loading")}</p> : !session?.user ? <Link href="/sign-in" className="underline">{t("signIn")}</Link> : <>
      <form onSubmit={submit} className="space-y-4 rounded-2xl border bg-background p-4 sm:p-6">
        {loaded && !ready && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{t("updatePending")}</p>}
        <div className="space-y-2"><label htmlFor="split-url" className="text-sm font-medium">{t("url")}</label>
          <Input id="split-url" type="url" value={url} onChange={(event) => { setUrl(event.target.value); setSource(null); setRanges([]); }} placeholder="https://www.youtube.com/watch?v=…" required disabled={busy || inspecting} />
        </div>
        {!source ? <Button type="submit" disabled={!ready || inspecting || busy || !url.trim()}>{inspecting && <Loader2 className="mr-2 size-4 animate-spin" />}{t("loadVideo")}</Button> : <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0"><p className="break-words text-sm font-medium">{source.title}</p><p className="text-xs tabular-nums text-muted-foreground">{videoTime(source.duration)}</p></div>
            <div className="flex items-center gap-2"><label htmlFor="split-count" className="text-sm font-medium">{t("partCount")}</label>
              <select id="split-count" className="h-10 rounded-lg border bg-background px-3 text-sm" value={ranges.length} disabled={busy} onChange={(event) => setRanges(initialSplitRanges(source.duration, Number(event.target.value)))}>
                {!ranges.length && <option value="0" disabled>{t("selectParts")}</option>}
                {Array.from({ length: Math.min(40, Math.floor(source.duration)) }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
              </select>
            </div>
          </div>
          <SplitTimeline duration={source.duration} ranges={ranges} disabled={busy} onChange={setRanges} />
          <p className="text-sm text-muted-foreground">{t("kept", { duration: videoTime(ranges.reduce((sum, part) => sum + part.end - part.start, 0)) })}</p>
          <Button type="submit" disabled={!ready || busy || !ranges.length}>{busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Scissors className="mr-2 size-4" />}{t("start")}</Button>
        </>}
        <p className="text-xs text-muted-foreground">{t("encodingNote")}</p>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error} <button onClick={() => { setError(null); void refresh().catch(() => setError(t("loadError"))); }} className="underline">{t("retry")}</button></p>}
      <section aria-label={t("results")} className="space-y-4">
        <h2 className="text-lg font-semibold">{t("results")}</h2>
        {!loaded && !error && <p role="status" className="text-muted-foreground">{t("loading")}</p>}
        {loaded && !splits.length && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
        {splits.map((split) => <article key={split.id} className="overflow-hidden rounded-xl border bg-background">
          <div className="space-y-2 p-4"><p className="break-all text-sm font-medium">{split.title}</p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">{["queued", "processing", "cancelling"].includes(split.status) && <Loader2 className="size-4 animate-spin" />}<span>{t(`status.${split.status}`)}</span></div>
            {split.status === "processing" && <div role="progressbar" aria-label={t("status.processing")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={split.progress} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground transition-all" style={{ width: `${split.progress}%` }} /></div>}
            {ready && ["queued", "processing", "error"].includes(split.status) && <Button type="button" variant="outline" size="sm" disabled={cancelling === split.id} onClick={() => void cancel(split.id)}>{cancelling === split.id && <Loader2 className="mr-1 size-3.5 animate-spin" />}{t("cancel")}</Button>}
            {split.status === "cancelled" && <p className="text-xs text-muted-foreground">{t("cancelledNote")}</p>}
            {split.error && <p role="alert" className="text-sm text-destructive">{split.error}</p>}
          </div>
          {!["cancelling", "cancelled"].includes(split.status) && split.parts.map((part) => <div key={part.id} className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <div><p className="text-sm font-medium">{t("part", { number: part.part_number })}</p><p className="text-xs tabular-nums text-muted-foreground">{videoTime(part.start_seconds)} – {videoTime(part.start_seconds + part.duration_seconds)}</p></div>
            <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><a href={`/api/video-splits/parts/${part.id}/file`}><Download className="mr-1 size-3.5" />{t("download")}</a></Button>
              <Button asChild size="sm"><Link href={`/?splitPart=${part.id}`}><Sparkles className="mr-1 size-3.5" />{t("generate")}</Link></Button>
              <Button type="button" size="sm" variant="outline" disabled={!ready || deleting === part.id} aria-label={t("deletePart", { number: part.part_number })} onClick={() => void deletePart(part.id)}>{deleting === part.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}</Button></div>
          </div>)}
        </article>)}
      </section>
    </>}
  </main></AppShell>;
}
