import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174/tests/pill-row/harness.html",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
