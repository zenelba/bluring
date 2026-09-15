/**
 * Shared brand-removal prompts (used by Vercel API routes).
 */

/**
 * @param {string[]} targets
 * @param {"flat_2d" | "product_3d"} scene
 */
export function buildBrandEditPrompt(targets, scene) {
  const list = targets
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `“${t.replace(/"/g, "'")}”`)
    .join(", ");

  if (!list) {
    return "Remove all visible brand logos, wordmarks, and promotional text from this image. Do not add new text or logos.";
  }

  if (scene === "product_3d") {
    return [
      "Edit this product or packaging photograph.",
      `Remove every instance of the following brands, text, logos, mascots, and graphic marks: ${list}.`,
      "Search the entire frame including edges, side panels, top and bottom flaps, shrink wrap, stickers, embossed or printed labels on curved surfaces, and partial text at the image border.",
      "Preserve the product shape, materials, lighting, shadows, and perspective.",
      "Fill removed areas with realistic continuation of the packaging or background.",
      "Do not add any new text, logos, or watermarks.",
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
