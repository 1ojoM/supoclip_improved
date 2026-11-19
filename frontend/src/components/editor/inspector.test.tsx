import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "./inspector";
import { draft } from "@/lib/editor/document.test-fixture";
import { captionAt, captionKey, captionTransform, type EditDocument, type EditorState } from "@/lib/editor/document";
import { CAPTION_STYLE_STORAGE_KEY, captureCaptionStyle } from "@/lib/editor/caption-style";

let current: EditDocument;
const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

function Editor({ hidden = false }: { hidden?: boolean }) {
  const initial: EditDocument = { ...draft, captions: { ...draft.captions, wordsPerLine: 1, enabled: !hidden } };
  initial.captionTransforms = { [captionKey(initial, captionAt(initial, .25)!)]: { x: .15, y: -.2, scale: 1, size: 88 } };
  const [doc, setDoc] = useState<EditDocument>(initial);
  current = doc;
  const asset = { status: "ready", duration: 3, width: 1080, height: 1920, fps: 30, hasAudio: true, waveform: [], basis: "basis", draft: { revision: 1, document: doc }, original: draft, jobs: [] } as EditorState;
  return <Inspector doc={doc} asset={asset} tab="captions" setTab={vi.fn()} time={.25} editTime={.25} seek={vi.fn()} update={(change) => setDoc(change)} applyAll={vi.fn()} endpoint="/editor" brollId={null} selectBroll={vi.fn()} />;
}

it("saves placement with the style and applies the current phrase's look to all phrases", () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "Save style" }));
  expect(JSON.parse(saved.get(CAPTION_STYLE_STORAGE_KEY)!)).toMatchObject({ version: 1, transform: { x: .15, y: -.2, size: 88 } });
  fireEvent.click(screen.getByRole("button", { name: "Apply to all phrases" }));
  const transform = captionTransform(current, captionAt(current, 1.25)!);
  expect(transform.x).toBe(.15);
  expect(transform.y).toBe(-.2);
  expect((transform.size ?? current.captions.size) * transform.scale).toBeCloseTo(88);
});

it("Load style replaces position, size and general styling for every phrase", () => {
  const style = captureCaptionStyle({ ...draft, captions: { ...draft.captions, font: "THEBOLDFONT", color: "#FF0000", uppercase: true }, textTransforms: { captions: { x: -.1, y: .05, scale: 1.5 } } }, .25);
  saved.set(CAPTION_STYLE_STORAGE_KEY, JSON.stringify(style));
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "Load style" }));
  expect(current.captions.font).toBe("THEBOLDFONT");
  expect(current.captions.color).toBe("#FF0000");
  expect(current.captions.uppercase).toBe(true);
  for (const time of [.25, 1.25, 2.25]) {
    const transform = captionTransform(current, captionAt(current, time)!);
    expect(transform.x).toBe(-.1);
    expect(transform.y).toBe(.05);
    expect((transform.size ?? current.captions.size) * transform.scale).toBeCloseTo(81);
  }
});


it("restores visible subtitles when applying a style to a hidden clip", () => {
  render(<Editor hidden />);
  expect(current.captions.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Apply to all phrases" }));
  expect(current.captions.enabled).toBe(true);
});


it("offers only title-relevant settings and changes the hook without changing subtitles", () => {
  render(<Editor />);
  const captions = { ...current.captions };
  fireEvent.change(screen.getByLabelText("Hook title"), { target: { value: "A new title" } });
  fireEvent.change(screen.getByLabelText("Title text color"), { target: { value: "#FF0000" } });
  expect(current.hookStyle?.color.toUpperCase()).toBe("#FF0000");
  fireEvent.click(screen.getByRole("switch", { name: "Uppercase title" }));
  expect(current.hookStyle?.uppercase).toBe(true);
  fireEvent.change(screen.getByLabelText("Title start (seconds)"), { target: { value: "0.5" } });
  expect(current.hookTiming?.start).toBe(.5);
  expect(current.captions).toEqual(captions);
  expect(screen.getByRole("slider", { name: "Hook title size" })).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Title horizontal position" })).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Title vertical position" })).toBeInTheDocument();
});
