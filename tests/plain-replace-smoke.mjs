/**
 * Open plain-replace-harness.html via Vite + Playwright, save a screenshot.
 * Run: node tests/plain-replace-smoke.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const outDir = "/opt/cursor/artifacts/screenshots";
mkdirSync(outDir, { recursive: true });

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5199"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

function waitReady() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("vite timeout")), 30000);
    const onData = (d) => {
      const s = String(d);
      process.stdout.write(s);
      if (/Local:\s+http:\/\/127\.0\.0\.1:5199/.test(s) || /ready in/i.test(s)) {
        clearTimeout(t);
        resolve();
      }
    };
    vite.stdout.on("data", onData);
    vite.stderr.on("data", onData);
    vite.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`vite exited ${code}`));
    });
  });
}

try {
  await waitReady();
  // Give Vite a beat after "ready"
  await new Promise((r) => setTimeout(r, 500));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  page.on("pageerror", (e) => console.error("pageerror", e));
  page.on("console", (m) => console.log("console", m.type(), m.text()));

  await page.goto("http://127.0.0.1:5199/tests/plain-replace-harness.html", {
    waitUntil: "networkidle",
    timeout: 120000,
  });
  await page.waitForFunction(
    () => window.__RESULT__ && (window.__RESULT__.url || window.__RESULT__.error),
    null,
    { timeout: 120000 },
  );
  const result = await page.evaluate(() => window.__RESULT__);
  if (result.error) throw new Error(result.error);

  const outPath = join(outDir, "plain-replace-brezskrbno-smoke.png");
  await page.locator("#preview").screenshot({ path: outPath });
  console.log("wrote", outPath, JSON.stringify(result.changes));
  await browser.close();
} finally {
  vite.kill("SIGTERM");
}
