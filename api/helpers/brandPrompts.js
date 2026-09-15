/**
 * Shared brand-removal prompts (used by Vercel API routes).
 */

/** Slovenian/English bear mascot phrases in filename targets. */
const BEAR_TARGET_RE =
  /\b(medved|medo|bear)\b|maskot[a]?\s*(medved|medveda)|medveda\s*maskot/i;

/**
 * @param {string} raw
 */
function describeTargetForPrompt(raw) {
  const trimmed = raw.trim();
  const quoted = `“${trimmed.replace(/"/g, "'")}”`;
  if (BEAR_TARGET_RE.test(trimmed)) {
    return `${quoted} (remove the brand’s white polar bear mascot — the full cartoon bear character on the packaging, including bow tie and pose; do not remove unrelated people or animals)`;
  }
  return quoted;
}

const PRODUCT_FRAMING = [
  "Composition: keep the exact same camera angle, scale, perspective, and crop as the source image.",
  "The complete packaging must remain fully visible — all corners, edges, lid, base, and sides of the box, tub, or wrap in frame with comfortable margin. Never zoom in, reframe, rotate, or trim off any part of the product.",
].join(" ");

const PRODUCT_BACKGROUND = [
  "Background: keep a clean pure white studio seamless background (#FFFFFF), matching the original packshot.",
  "Never replace the background with black, dark gray, or colored backdrops.",
].join(" ");

/**
 * @param {string[]} targets
 * @param {"flat_2d" | "product_3d"} scene
 */
export function buildBrandEditPrompt(targets, scene) {
  const list = targets
    .map((t) => t.trim())
    .filter(Boolean)
    .map(describeTargetForPrompt)
    .join(", ");

  if (!list) {
    return [
      "Remove all visible brand logos, wordmarks, and promotional text from this image.",
      PRODUCT_FRAMING,
      PRODUCT_BACKGROUND,
      "Do not add new text or logos.",
    ].join(" ");
  }

  if (scene === "product_3d") {
    return [
      "Edit this product or packaging photograph.",
      `Remove every instance of the following brands, text, logos, mascots, and graphic marks: ${list}.`,
      "Search the entire frame including edges, side panels, top and bottom flaps, shrink wrap, stickers, embossed or printed labels on curved surfaces, and partial text at the image border.",
      PRODUCT_FRAMING,
      "Preserve the product shape, materials, lighting, soft shadows on white, and perspective.",
      "Fill removed areas with realistically continued packaging artwork or seamless white background — no empty brown or gray placeholder blocks.",
      PRODUCT_BACKGROUND,
      "Do not add any new text, logos, mascots, or watermarks.",
    ].join(" ");
  }

  return [
    "Edit this flat 2D graphic or illustration.",
    `Remove every instance of the following brands, text, logos, mascots, and graphic marks: ${list}.`,
    "Match fills to the surrounding flat artwork, gradients, and colors.",
    "Do not add any new text, logos, or watermarks.",
  ].join(" ");
}

export const VISION_CLASSIFY_PROMPT = `Classify this image for brand-removal editing.

Return JSON only with:
- scene: "flat_2d" if it is a flat illustration, graphic, mascot art, logo sheet, or 2D design with little depth.
- scene: "product_3d" if it is a photograph or render of a physical product, packaging, box, bottle, bag, or studio packshot with perspective.

Also include confidence (0-1) and a short rationale.`;
