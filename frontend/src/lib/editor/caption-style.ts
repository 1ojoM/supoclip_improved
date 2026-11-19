import {
  captionAt, captionGroups, captionKey, captionTransform, mappedWords,
  setCaptionVisualSize, textTransform,
  type CaptionStyle, type CaptionTransform, type EditDocument,
} from "./document";

export const CAPTION_STYLE_STORAGE_KEY = "supoclip-caption-style";

export interface CaptionStylePreset {
  version: 1;
  captions: CaptionStyle;
  transform: CaptionTransform;
}

/** Capture the currently visible phrase, including its placement and actual size. */
export function captureCaptionStyle(doc: EditDocument, time: number): CaptionStylePreset {
  const phrase = captionAt(doc, time);
  return {
    version: 1,
    captions: { ...doc.captions, enabled: true },
    transform: { ...(phrase ? captionTransform(doc, phrase) : textTransform(doc, "captions")) },
  };
}

/** Set a shared appearance and remove earlier phrase-specific exceptions. */
export function applyCaptionStyle(doc: EditDocument, preset: CaptionStylePreset): EditDocument {
  const { x, y, scale, size } = preset.transform;
  const visualSize = (size ?? preset.captions.size) * scale;
  const next = setCaptionVisualSize({
    ...doc,
    // Visibility is a separate editor switch. Applying a visual style should
    // display it, even when an older saved preset included enabled: false.
    captions: { ...preset.captions, enabled: true },
    textTransforms: { ...doc.textTransforms, captions: { x, y, scale } },
    captionTransforms: {},
  }, visualSize);
  // Extreme phrase overrides can exceed the shared transform's size range.
  // Keep those exact values on every occurrence instead of silently shrinking.
  if (visualSize < 5 || visualSize > 528) {
    next.captionTransforms = Object.fromEntries(
      captionGroups(mappedWords(next), next.captions.wordsPerLine)
        .map((phrase) => [captionKey(next, phrase), { ...preset.transform }]),
    );
  }
  return next;
}

const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Accept complete presets and the plain CaptionStyle saved by older editors. */
export function parseCaptionStyle(value: unknown): CaptionStylePreset | null {
  if (!record(value)) return null;
  const modern = "captions" in value;
  if (modern && value.version !== 1) return null;
  const style = modern ? value.captions : value;
  if (!record(style)
    || typeof style.font !== "string"
    || !["TikTokSans-Regular", "TikTokSans-Bold", "Poppins-ExtraBold", "THEBOLDFONT"].includes(String(style.font))
    || !finite(style.size, 20, 132) || !Number.isInteger(style.size)
    || !finite(style.y, .1, .9)
    || !finite(style.wordsPerLine, 1, 8) || !Number.isInteger(style.wordsPerLine)
    || typeof style.enabled !== "boolean" || typeof style.background !== "boolean"
    || typeof style.color !== "string" || !/^#[0-9a-f]{6}$/i.test(style.color)
    || typeof style.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(style.accent)
    || (style.uppercase !== undefined && typeof style.uppercase !== "boolean")
    || (style.karaoke !== undefined && typeof style.karaoke !== "boolean")
    || (style.template !== undefined && (typeof style.template !== "string" || !style.template.length || style.template.length > 50))) return null;
  const transform = modern ? value.transform : { x: 0, y: 0, scale: 1 };
  if (!record(transform) || !finite(transform.x, -1, 1) || !finite(transform.y, -1, 1) || !finite(transform.scale, .25, 4)
    || (transform.size != null && !finite(transform.size, 5, 528))) return null;
  return {
    version: 1,
    captions: {
      enabled: style.enabled, font: style.font as CaptionStyle["font"], size: style.size,
      color: style.color, accent: style.accent, y: style.y, background: style.background,
      wordsPerLine: style.wordsPerLine,
      ...(style.uppercase !== undefined ? { uppercase: style.uppercase as boolean } : {}),
      ...(style.karaoke !== undefined ? { karaoke: style.karaoke as boolean } : {}),
      ...(style.template !== undefined ? { template: style.template as string } : {}),
    },
    transform: { x: transform.x, y: transform.y, scale: transform.scale, ...(transform.size != null ? { size: transform.size as number } : {}) },
  };
}
