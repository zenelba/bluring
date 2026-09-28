import { expect, test } from "@playwright/test";

type Result = {
  count: number;
  offsets: number[];
  sortedOffsets: number[];
  strip: { width: number; height: number; hasUrl: boolean } | null;
  downloadButtons: number;
};

test("series strip stacks −min…+max and each result has Download", async ({
  page,
}) => {
  await page.goto("/tests/pill-row/series-strip-harness.html");
  await page.waitForFunction(
    () => (window as unknown as { __RESULT__?: unknown }).__RESULT__,
    null,
    { timeout: 90_000 },
  );
  const r = await page.evaluate(
    () => (window as unknown as { __RESULT__: Result }).__RESULT__,
  );

  expect(r.count).toBe(5);
  expect(r.offsets).toEqual([-2, -1, 0, 1, 2]);
  expect(r.sortedOffsets).toEqual([-2, -1, 0, 1, 2]);
  expect(r.strip).not.toBeNull();
  expect(r.strip!.hasUrl).toBe(true);
  expect(r.strip!.height).toBeGreaterThan(r.strip!.width);
  // strip + 5 variants
  expect(r.downloadButtons).toBe(6);

  await expect(page.getByTestId("series-strip")).toBeVisible();
  await expect(page.getByTestId("series-strip").locator("img")).toBeVisible();
  for (const offset of [-2, -1, 0, 1, 2]) {
    await expect(page.getByTestId(`download-${offset}`)).toBeVisible();
    await expect(page.getByTestId(`variant-${offset}`)).toBeVisible();
  }

  await page.getByTestId("strip-download").click();
  const stripClicked = await page.evaluate(
    () => (window as unknown as { __STRIP_CLICKED__?: boolean }).__STRIP_CLICKED__,
  );
  expect(stripClicked).toBe(true);
});
