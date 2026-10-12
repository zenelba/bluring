/**
 * Unit checks for isExteriorRightNeighbor (plain erase / width clear edge).
 * Run: npx tsx tests/plain-right-neighbor.test.ts
 */
import { isExteriorRightNeighbor } from "../src/lib/plainNeighbor.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function item(
  id: string,
  bbox: { x: number; y: number; w: number; h: number },
  kind = "text",
) {
  return { id, kind, bbox };
}

const neo = item("neo", { x: 0.2, y: 0.4, w: 0.25, h: 0.05 });

// Mid-word / interior overlap must NOT count (caused tiny "brezskrbno" + leftover "mejeno")
const interior = item("frag", { x: 0.28, y: 0.4, w: 0.15, h: 0.05 });
assert(
  !isExteriorRightNeighbor(neo, interior),
  "interior overlap must not be a right neighbor",
);

// Slightly past left edge but still inside the word
const early = item("early", { x: 0.21, y: 0.4, w: 0.05, h: 0.05 });
assert(
  !isExteriorRightNeighbor(neo, early),
  "box starting just inside left edge must not count",
);

// True right-hand placeholder (mesec / next column), starts at/after 90% of box
const mesec = item("mesec", { x: 0.46, y: 0.4, w: 0.1, h: 0.04 });
assert(
  isExteriorRightNeighbor(neo, mesec),
  "exterior right placeholder must count",
);

// Same row but left of neo — never a right neighbor
const left = item("left", { x: 0.05, y: 0.4, w: 0.1, h: 0.05 });
assert(!isExteriorRightNeighbor(neo, left), "left box must not count");

// Different row — no vertical overlap
const below = item("below", { x: 0.5, y: 0.7, w: 0.1, h: 0.05 });
assert(!isExteriorRightNeighbor(neo, below), "different row must not count");

console.log("plain-right-neighbor: ok");
