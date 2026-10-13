/**
 * Canvas right-margin helper for plain-text / pill growth.
 * Run: npx tsx tests/plain-right-margin.test.ts
 */
import {
  PLAIN_RIGHT_MARGIN_FRAC,
  plainCanvasRightMax,
} from "../src/lib/plainMargin.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(PLAIN_RIGHT_MARGIN_FRAC === 0.03, "margin frac is 3%");
assert(plainCanvasRightMax(1000) === 970, "1000 → rightMax 970");
assert(plainCanvasRightMax(560) === 560 * 0.97, "560 banner");

const imgW = 560;
const boxX = 120;
const maxW = plainCanvasRightMax(imgW) - boxX;
assert(maxW === 560 * 0.97 - 120, "available width respects margin");
assert(boxX + maxW <= imgW * 0.97 + 1e-9, "ink ends at/before 97%");

console.log("plain-right-margin: ok");
