import { applyCaptionStyle, captureCaptionStyle, parseCaptionStyle } from "./caption-style";
import { captionAt, captionKey, captionTransform } from "./document";
import { draft } from "./document.test-fixture";

function styledDraft() {
  const doc = { ...draft, captions: { ...draft.captions, wordsPerLine: 1, uppercase: true, karaoke: true, template: "podcast" },
    textTransforms: { hook: { x: .1, y: .2, scale: 1.2 }, captions: { x: 0, y: .1, scale: 1 } },
    captionTransforms: {} as Record<string, { x: number; y: number; scale: number; size: number }>,
  };
  doc.captionTransforms[captionKey(doc, captionAt(doc, .25)!)] = { x: .2, y: -.15, scale: 1.5, size: 96 };
  doc.captionTransforms[captionKey(doc, captionAt(doc, 1.25)!)] = { x: -.1, y: .1, scale: .5, size: 24 };
  return doc;
}

it("round-trips all style fields and the current phrase's actual placement and size", () => {
  const source = styledDraft();
  const preset = parseCaptionStyle(JSON.parse(JSON.stringify(captureCaptionStyle(source, .25))))!;
  expect(preset.captions).toEqual(source.captions);
  expect(preset.transform).toEqual({ x: .2, y: -.15, scale: 1.5, size: 96 });
  const result = applyCaptionStyle(source, preset);
  for (const time of [.25, 1.25, 2.25]) {
    const transform = captionTransform(result, captionAt(result, time)!);
    expect(transform.x).toBe(.2);
    expect(transform.y).toBe(-.15);
    expect((transform.size ?? result.captions.size) * transform.scale).toBeCloseTo(144);
  }
  expect(result.captionTransforms).toEqual({});
  expect(result.textTransforms?.hook).toEqual(source.textTransforms.hook);
  expect(result.words).toBe(source.words);
  expect(result.segments).toBe(source.segments);
  expect(source.captionTransforms[captionKey(source, captionAt(source, 1.25)!)]).toEqual({ x: -.1, y: .1, scale: .5, size: 24 });
});

it("loads older saved styles and clears conflicting phrase overrides", () => {
  const preset = parseCaptionStyle(draft.captions)!;
  const result = applyCaptionStyle(styledDraft(), preset);
  expect(result.captions).toEqual(draft.captions);
  expect(result.captionTransforms).toEqual({});
  expect(result.textTransforms?.captions).toEqual({ x: 0, y: 0, scale: 1 });
});

it("preserves extreme phrase sizes across every phrase instead of clamping the appearance", () => {
  const doc = styledDraft();
  const preset = captureCaptionStyle(doc, .25);
  preset.transform = { x: 0, y: .1, size: 528, scale: 4 };
  const result = applyCaptionStyle(doc, preset);
  for (const time of [.25, 1.25, 2.25]) {
    expect(captionTransform(result, captionAt(result, time)!)).toEqual(preset.transform);
  }
});

it.each([null, [], { font: "unknown", size: 54 }, { version: 2, captions: draft.captions, transform: { x: 0, y: 0, scale: 1 } },
  { version: 1, captions: draft.captions, transform: { x: 0, y: 0, scale: Infinity } }])("rejects an invalid saved style", (value) => {
  expect(parseCaptionStyle(value)).toBeNull();
});

it("never propagates a hidden-caption switch when saving or applying a style", () => {
  const hidden = { ...draft, captions: { ...draft.captions, enabled: false } };
  expect(captureCaptionStyle(hidden, .25).captions.enabled).toBe(true);
  const oldPreset = parseCaptionStyle(hidden.captions)!;
  expect(applyCaptionStyle(hidden, oldPreset).captions.enabled).toBe(true);
});
