/**
 * Unit checks for plain-text font ink height (no canvas).
 * Run: node --experimental-strip-types tests/font-ink.test.ts
 * or: npx tsx tests/font-ink.test.ts
 */
import { inkHeightFromMetrics, inkBounds } from "../src/lib/fontMatch.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// Caps / no-descender: ascent only — never invent 20% descent
{
  const probe = 100;
  const ascent = 80;
  const h = inkHeightFromMetrics(ascent, 0, probe);
  assert(h === 80, `expected 80 for zero descent, got ${h}`);
  const oldBug = ascent + probe * 0.2;
  assert(h < oldBug, "must not pad zero descent");
}

// Residual cap descent (e.g. J bowl) ignored
{
  const h = inkHeightFromMetrics(72, 2, 100);
  assert(h === 72, `expected 72 ignoring residual descent, got ${h}`);
}

// Real descenders kept
{
  const h = inkHeightFromMetrics(70, 20, 100);
  assert(h === 90, `expected 90, got ${h}`);
}

// Missing metrics → fallback
{
  const h = inkHeightFromMetrics(0, 0, 100);
  assert(h === 80, `expected probe*0.8 fallback, got ${h}`);
}

// inkBounds finds tight rect
{
  const w = 5;
  const h = 5;
  const mask = new Uint8Array(w * h);
  // ink at (1,2) and (3,3)
  mask[2 * w + 1] = 1;
  mask[3 * w + 3] = 1;
  const b = inkBounds(mask, w, h);
  assert(b != null, "bounds");
  assert(b!.x === 1 && b!.y === 2 && b!.w === 3 && b!.h === 2, `got ${JSON.stringify(b)}`);
}

console.log("font-ink tests ok");
