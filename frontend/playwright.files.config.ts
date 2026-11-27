import { defineConfig } from '@playwright/test';
import { readPreviewAccess } from './file-tests/reading-fixture';

const access = readPreviewAccess();
// 所有用例使用同一份已验证的隔离预览凭据绝对路径。
process.env.NEOCLOUD_FILE_TEST_ACCESS = access.path;
export default defineConfig({
  testDir: './file-tests',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: access.origin,
    browserName: 'chromium',
    locale: 'zh-CN',
    ignoreHTTPSErrors: Boolean(process.env.NEOCLOUD_TEST_WEB_HTTPS_ORIGIN),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results/files',
});
