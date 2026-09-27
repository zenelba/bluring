import { expect, test } from "@playwright/test";

type Rgb = { r: number; g: number; b: number };
type Result = {
  width: number;
  height: number;
  out: number[];
  src: number[];
  pillRows: Array<{
    T1: number;
    H1: number;
    pills: Array<{
      text: string;
      newText: string;
      mode: string;
      rect: { x: number; y: number; w: number; h: number };
      newRect: { x: number; y: number; w: number; h: number };
    }>;
  }>;
};

const isYellow = (c: Rgb) => c.g > 180 && c.r > 140 && c.b < 120 && c.g >= c.r - 20;
const isPink = (c: Rgb) => c.r > 160 && c.b > 80 && c.g < c.r * 0.7 && c.r > c.g + 40;
const isBlue = (c: Rgb) => c.b > 170 && c.r < 120;

function px(data: number[], w: number, x: number, y: number): Rgb {
  const i = (y * w + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

async function render(page: import("@playwright/test").Page, text: string): Promise<Result> {
  await page.goto(`/tests/pill-row/harness.html?text=${encodeURIComponent(text)}`);
  await page.waitForFunction(() => (window as unknown as { __RESULT__?: unknown }).__RESULT__, null, {
    timeout: 60_000,
  });
  return page.evaluate(() => (window as unknown as { __RESULT__: Result }).__RESULT__);
}

for (const text of ["SUPER CENA", "BJUUUUTIFUL CENA"]) {
  test(`badge row rebuilt from source pixels: ${text}`, async ({ page }) => {
    const r = await render(page, text);
    expect(r.pillRows.length).toBe(1);
    const row = r.pillRows[0];

    // Measured procedure values
    expect(Math.abs(row.T1 - 61)).toBeLessThanOrEqual(2);
    expect(Math.abs(row.H1 - 45)).toBeLessThanOrEqual(2);
    expect(row.pills.map((p) => p.text)).toEqual(["ENOTNA CENA", "2 LETI"]);

    const [yellow, pink] = row.pills;
    expect(yellow.newText).toBe(text);
    expect(yellow.mode).toBe("stretch");
    expect(yellow.newRect.x).toBe(yellow.rect.x);
    expect(yellow.newRect.h).toBe(yellow.rect.h);
    expect(yellow.newRect.w).toBeGreaterThanOrEqual(yellow.rect.w);
    expect(pink.newRect.h).toBe(pink.rect.h);
    expect(pink.newRect.x).toBeGreaterThan(yellow.newRect.x + yellow.newRect.w);

    // No blue band inside the new yellow pill (the reported failure)
    const ny = yellow.newRect;
    let blue = 0;
    let total = 0;
    for (let y = ny.y + 2; y < ny.y + ny.h - 2; y++) {
      for (let x = ny.x + Math.ceil(ny.h / 2); x < ny.x + ny.w - Math.ceil(ny.h / 2); x++) {
        total++;
        if (isBlue(px(r.out, r.width, x, y))) blue++;
      }
    }
    expect(blue / total).toBeLessThan(0.01);

    // No original plate remnants outside the new pills in the badge band
    const inside = (x: number, y: number) =>
      row.pills.some(
        (p) =>
          x >= p.newRect.x - 1 &&
          x <= p.newRect.x + p.newRect.w &&
          y >= p.newRect.y - 1 &&
          y <= p.newRect.y + p.newRect.h,
      );
    let remnants = 0;
    for (let y = 40; y < 110; y++) {
      for (let x = 0; x < 440; x++) {
        const c = px(r.out, r.width, x, y);
        if ((isYellow(c) || isPink(c)) && !inside(x, y)) remnants++;
      }
    }
    expect(remnants).toBeLessThan(20);

    // Unchanged pink "2 LETI" is the original pixels, only shifted
    const dx = pink.newRect.x - pink.rect.x;
    let diff = 0;
    let n = 0;
    const cap = Math.ceil(pink.rect.h / 2);
    for (let y = pink.rect.y; y < pink.rect.y + pink.rect.h; y++) {
      for (let x = pink.rect.x + cap; x < pink.rect.x + pink.rect.w - cap; x++) {
        const a = px(r.src, r.width, x, y);
        const b = px(r.out, r.width, x + dx, y);
        diff += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        n++;
      }
    }
    expect(diff / n).toBeLessThan(1);
  });
}
