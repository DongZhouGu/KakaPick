import { defineConfig, devices } from "@playwright/test";

const token = "0123456789abcdef".repeat(4);
const port = Number(process.env.BURSTPICK_E2E_PORT ?? 43_110);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm build && env -u NO_COLOR BURSTPICK_E2E_TOKEN=${token} BURSTPICK_E2E_PORT=${port} ./node_modules/.bin/tsx tests/e2e/server.ts`,
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
