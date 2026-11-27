import { defineConfig } from '@playwright/test';
import { readNeoCloudEnv } from './apps/web/runtime/environment.mjs';
const managedWebUrl = readNeoCloudEnv('TEST_WEB_URL');
export default defineConfig({
  testDir: './integration',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: managedWebUrl ?? 'http://127.0.0.1:4185',
    browserName: 'chromium',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results/integration',
  ...(!managedWebUrl
    ? {
        webServer: {
          command: 'pnpm --filter @neocloud/web exec next dev --hostname 127.0.0.1 --port 4185',
          url: 'http://127.0.0.1:4185/login',
          timeout: 120_000,
          reuseExistingServer: false,
          env: {
            NEXT_DIST_DIR: '.next/integration',
            NEXT_PUBLIC_NEOCLOUD_AUTH_MODE: 'backend',
            NEXT_PUBLIC_NEOCLOUD_AUTH_API_BASE_URL: '/api/console/v1',
            NEOCLOUD_BACKEND_URL: 'http://127.0.0.1:8088',
          },
        },
      }
    : {}),
});
