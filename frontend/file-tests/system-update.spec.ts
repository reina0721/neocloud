import { expect, test, type Page } from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';

const updateTitle = /^(系统更新|System Update)$/i;
const updatePage = '/system-tools/update';
const releaseEndpoint = '/api/host/v1/releases/latest';
const checkRelease = /^(检查 GitHub 正式版|Check GitHub releases)$/i;
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const updateEndpoints = [
  '/maintenance',
  '/api/console/v1/deployment',
  '/api/console/v1/system/update',
  releaseEndpoint,
];
const releaseUrl = 'https://github.com/reina0721/neocloud/releases/tag/v1.2.3';
const downloads = 'https://github.com/reina0721/neocloud/releases/download/v1.2.3/';
const release = {
  version: 'v1.2.3',
  publishedAt: '2026-11-12T09:30:00Z',
  notes: 'Published release notes from the acceptance fixture.',
  releaseUrl,
  assets: [
    {
      name: 'neocloud_1.2.3_windows_amd64.zip',
      sizeBytes: 24305999,
      downloadUrl: downloads + 'neocloud_1.2.3_windows_amd64.zip',
      kind: 'windows-backend',
    },
    {
      name: 'install.sh',
      sizeBytes: 29695,
      downloadUrl: downloads + 'install.sh',
      kind: 'other',
    },
  ],
};

async function observeReleaseChecks(page: Page, origin: string, responses: readonly number[]) {
  const checks: string[] = [];
  const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === releaseEndpoint && request.method() === 'GET') {
      const status = responses[checks.length] ?? 500;
      checks.push(request.method());
      await route.fulfill({ status, json: status === 200 ? release : { code: 'unavailable' } });
      return;
    }
    const updateWrite =
      url.origin === origin &&
      !readMethods.has(request.method()) &&
      updateEndpoints.some((path) => url.pathname === path || url.pathname.startsWith(path + '/'));
    const releaseRequest =
      ['github.com', 'api.github.com'].includes(url.hostname) ||
      url.hostname.endsWith('.githubusercontent.com');
    if (updateWrite || releaseRequest) {
      blocked.push(`${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  return { checks, blocked };
}

async function openSystemUpdate(page: Page, access: ReturnType<typeof readPreviewAccess>) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login?returnTo=%2Fworkspace');
  await page.getByLabel(/^(邮箱|Email)$/i).fill(access.username);
  await page.getByLabel(/^(密码|Password)$/i).fill(access.password);
  await page.getByRole('button', { name: /^(登录|Sign in)$/i }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /^(系统更新|System Update) /i })).toHaveAttribute(
    'href',
    updatePage,
  );
  const openNavigation = page.getByRole('button', { name: /^(打开导航|Open navigation)$/i });
  if (await openNavigation.isVisible()) await openNavigation.click();
  const entry = page.getByRole('link', { name: updateTitle });
  await expect(entry).toHaveAttribute('href', updatePage);
  await entry.click();
  await expect(page).toHaveURL(access.origin + updatePage);
  await expect(main.getByRole('heading', { name: updateTitle })).toBeVisible();
  return main;
}

test('开发环境按需读取 GitHub 正式版，维护动作保持禁用', async ({ page }, info) => {
  const access = readPreviewAccess();
  const { checks, blocked } = await observeReleaseChecks(page, access.origin, [200]);
  const main = await openSystemUpdate(page, access);
  const gateway = await page.request.head('/maintenance');
  expect(gateway.headers()['x-neocloud-maintenance']).toBeUndefined();
  const build = await page.request.get('/management/build');
  expect(build.ok()).toBe(true);
  const { version } = (await build.json()) as { version: string };
  expect(version).toBeTruthy();
  await expect(main.getByText(version, { exact: true }).first()).toBeVisible();
  const developmentNotice =
    process.platform === 'win32'
      ? /Windows 本地开发环境|local Windows development environment/i
      : /本地开发环境|local development environment/i;
  await expect(main.getByRole('status').filter({ hasText: developmentNotice })).toBeVisible();
  const maintenanceActions = [/^(升级|Upgrade)$/i, /^(回退|Roll back)$/i, /^(恢复|Restore)$/i].map(
    (name) => main.getByRole('button', { name }),
  );
  for (const action of maintenanceActions) {
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
  }
  await expect(main.locator('a[href="/maintenance"]')).toHaveCount(0);
  const check = main.getByRole('button', { name: checkRelease });
  const latest = main.getByRole('status').filter({ hasText: release.version });
  await expect(check).toBeEnabled();
  await expect(latest).toHaveCount(0);
  expect(checks).toEqual([]);

  await check.click();
  await expect(latest).toBeVisible();
  await expect(
    main.getByRole('link', { name: /^(在 GitHub 查看发布页|View release on GitHub)$/i }),
  ).toHaveAttribute('href', releaseUrl);
  const notes = main.getByRole('button', { name: /^(发布说明|Release notes)$/i });
  await expect(notes).toHaveAttribute('aria-expanded', 'false');
  await notes.click();
  await expect(main.getByText(release.notes, { exact: true })).toBeVisible();
  for (const asset of release.assets) {
    await expect(main.locator(`a[href="${asset.downloadUrl}"]`)).toBeVisible();
  }
  await expect(main).toContainText(
    /仅 Go 后端，不含 Web Host|(?:Go backend only|only (?:the )?Go backend)[\s\S]*Web Host/i,
  );
  for (const action of maintenanceActions) await expect(action).toBeDisabled();
  await expect(main.locator('a[href="/maintenance"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('system-update-development.png'), fullPage: true });
  expect(checks).toEqual(['GET']);
  expect(blocked).toEqual([]);
});

test('正式版检查失败可显式重试，未发出维护写请求', async ({ page }) => {
  const access = readPreviewAccess();
  const { checks, blocked } = await observeReleaseChecks(page, access.origin, [503, 200]);
  const main = await openSystemUpdate(page, access);
  const check = main.getByRole('button', { name: checkRelease });
  const latest = main.getByRole('status').filter({ hasText: release.version });
  await expect(check).toBeEnabled();
  expect(checks).toEqual([]);

  const error = main.getByRole('status').filter({
    hasText: /暂时无法查询 GitHub 正式版，请重试。|Could not check GitHub releases\. Try again\./i,
  });
  await check.click();
  await expect(error).toBeVisible();
  await expect(latest).toHaveCount(0);
  expect(checks).toEqual(['GET']);

  await check.click();
  await expect(latest).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(checks).toEqual(['GET', 'GET']);
  expect(blocked).toEqual([]);
});
