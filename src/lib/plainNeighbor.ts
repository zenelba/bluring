/**
 * Right-neighbor helpers for plain-text erase / width caps in text replace.
 */

export type NeighborBBox = { x: number; y: number; w: number; h: number };

export type NeighborItem = {
  id: string;
  kind: string;
  bbox: NeighborBBox;
};

/**
 * True right-hand placeholder (e.g. "mesec" beside a price).
 * Ignores detections that start inside this word — those used to mid-cut erase
 * and shrink replacements like neomejeno → brezskrbno down to ~6px.
 */
export function isExteriorRightNeighbor(
  item: NeighborItem,
  other: NeighborItem,
): boolean {
  if (other.id === item.id) return false;
  if (other.kind === "logo") return false;
  // Start at/after ~90% of this box — not in the word interior.
  if (other.bbox.x < item.bbox.x + item.bbox.w * 0.9) return false;
  const pad = Math.max(item.bbox.h, other.bbox.h) * 0.15;
  return (
    item.bbox.y - pad < other.bbox.y + other.bbox.h &&
    other.bbox.y - pad < item.bbox.y + item.bbox.h
  );
}
