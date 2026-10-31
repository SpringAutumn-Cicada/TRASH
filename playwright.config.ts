import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:22224", trace: "retain-on-failure" },
  webServer: {
    command: "node --import tsx tests/start-e2e-server.ts",
    url: "http://127.0.0.1:22224",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
