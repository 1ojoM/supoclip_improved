import { expect, it } from "vitest";
import { draft } from "./document.test-fixture";
import { formatHookEditorText, prepareTextDraft, textEditorLayout, hookTitleLayout, textLayerBounds } from "./render";

function context() {
  return {
    font: "10px sans-serif",
    measureText(this: { font: string }, text: string) {
      const px = Number.parseFloat(this.font);
      return { width: text.length * px * .5, fontBoundingBoxAscent: px * .9, fontBoundingBoxDescent: px * .3 };
    },
  } as unknown as CanvasRenderingContext2D;
}

it.each(["hook", "captions"] as const)("uses the canvas font-height correction for the %s native caret", layer => {
  const layout = textEditorLayout(context(), { ...draft, hookTitle: "Editable title" }, 1080, 1920, .2, layer);
  const assPixels = layer === "hook" ? 44 : 54;
  expect(layout.fontSize).toBeCloseTo(assPixels / 1.2);
  expect(layout.lineHeight).toBeCloseTo(assPixels * 1.2);
});

it("keeps original word timings and highlights in an unchanged editing draft", () => {
  const before = structuredClone(draft);
  const scratch = prepareTextDraft(draft, .2, "captions", "Hello world today");
  expect(scratch.captionWords).toEqual(draft.words);
  expect(prepareTextDraft(draft, .2, "captions", "A revised phrase").captionWords?.map(word => word.text)).toEqual(["A", "revised", "phrase"]);
  expect(draft).toEqual(before);
});

it("balances hook editor lines without changing stored casing or eating a typed space", () => {
  const text = "Mixed Case Äpfel remain editable while typing ";
  const formatted = formatHookEditorText({ ...draft, captions: { ...draft.captions, uppercase: true } }, 1080, 1920, text);
  expect(formatted.replace(/\s+/g, " ")).toBe(text);
  expect(prepareTextDraft(draft, .2, "hook", formatted).hookText).toBe(text.trim());
});


it("uses independent hook font size and casing while subtitle edits leave its layout intact", () => {
  const doc = { ...draft, hookTitle: "My title", hookStyle: { enabled: true, font: "THEBOLDFONT" as const, size: 72, color: "#FF0000", accent: "#00FF00", uppercase: true, background: true } };
  const layout = hookTitleLayout(doc, 1080, 1920);
  expect(layout.px).toBe(72);
  expect(layout.lines.join(" ")).toBe("MY TITLE");
  const changed = { ...doc, captions: { ...draft.captions, size: 132, uppercase: false, color: "#0000FF", font: "Poppins-ExtraBold" as const } };
  expect(hookTitleLayout(changed, 1080, 1920)).toEqual(layout);
  const ctx = context();
  textEditorLayout(ctx, changed, 1080, 1920, .5, "hook");
  expect(ctx.font).toContain("THEBOLDFONT");
  expect(textLayerBounds(ctx, { ...doc, hookStyle: { ...doc.hookStyle, enabled: false } }, 1080, 1920, .5, "hook")).toBeNull();
});
