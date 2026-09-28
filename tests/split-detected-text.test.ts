/**
 * Unit checks for splitDetectedTextBySpaces (no canvas → char weights).
 * Run: npx tsx tests/split-detected-text.test.ts
 */
import {
  canSplitDetectedText,
  splitDetectedTextBySpaces,
  type SplitDetectedText,
} from "../src/lib/splitDetectedText.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function baseItem(overrides: Partial<SplitDetectedText> = {}): SplitDetectedText {
  return {
    id: "t_neo",
    text: "NEO C",
    bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.05 },
    kind: "text",
    container: {
      type: "plain",
      fill: null,
      radiusPxHint: 0,
      padX: 0.45,
      padY: 0.28,
      rect: null,
    },
    layoutGroupId: null,
    textBlockId: null,
    style: {
      color: "#c9a227",
      fontWeight: "bold",
      align: "left",
      fontFamily: "Montserrat",
      fontSizeRel: 0.08,
      scaleX: 1,
    },
    number: null,
    ...overrides,
  };
}

{
  const item = baseItem();
  assert(canSplitDetectedText(item), "NEO C should be splittable");
  assert(
    !canSplitDetectedText(baseItem({ text: "NEO" })),
    "single token not splittable",
  );
}

{
  const item = baseItem();
  const parts = splitDetectedTextBySpaces(item);
  assert(parts != null && parts.length === 2, "expected 2 parts");
  assert(parts![0].text === "NEO" && parts![1].text === "C", "token texts");
  assert(parts![0].id === "t_neo__s0" && parts![1].id === "t_neo__s1", "ids");
  assert(parts![0].bbox.y === item.bbox.y, "y preserved");
  assert(parts![0].bbox.h === item.bbox.h, "h preserved");
  assert(parts![1].bbox.y === item.bbox.y, "y2 preserved");
  assert(parts![1].bbox.h === item.bbox.h, "h2 preserved");
  assert(parts![0].bbox.x >= item.bbox.x - 1e-9, "left inside parent");
  assert(
    parts![1].bbox.x + parts![1].bbox.w <= item.bbox.x + item.bbox.w + 1e-6,
    "right inside parent",
  );
  assert(
    parts![1].bbox.x >= parts![0].bbox.x + parts![0].bbox.w - 1e-9,
    "second box to the right of first (gap may sit between)",
  );
  assert(
    parts![0].bbox.x + parts![0].bbox.w <= parts![1].bbox.x + 1e-9,
    "non-overlapping x-ranges",
  );
  assert(parts![0].container.type === "plain", "child0 plain");
  assert(parts![1].container.type === "plain", "child1 plain");
}

{
  const pill = baseItem({
    text: "A B C",
    container: {
      type: "pill",
      fill: "#ff0000",
      radiusPxHint: 8,
      padX: 0.4,
      padY: 0.3,
      rect: { x: 0.05, y: 0.18, w: 0.5, h: 0.08 },
    },
  });
  const parts = splitDetectedTextBySpaces(pill);
  assert(parts != null && parts.length === 3, "three tokens");
  assert(
    parts!.every((p) => p.container.type === "plain" && p.container.rect == null),
    "pill demoted to plain",
  );
}

{
  assert(splitDetectedTextBySpaces(baseItem({ text: "alone" })) == null, "null");
}

console.log("split-detected-text tests ok");
