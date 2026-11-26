import { expect, test } from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';

const updateTitle = /^(系统更新|System Update)$/i;
const updatePage = '/system-tools/update';
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const updateEndpoints = [
  '/maintenance',
  '/api/console/v1/deployment',
  '/api/console/v1/system/update',
];

test('开发环境的系统更新入口显示真实构建与不可执行的维护动作', async ({ page }, info) => {
  const access = readPreviewAccess();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login?returnTo=%2Fworkspace');
  await page.getByLabel(/^(邮箱|Email)$/i).fill(access.username);
  await page.getByLabel(/^(密码|Password)$/i).fill(access.password);
  await page.getByRole('button', { name: /^(登录|Sign in)$/i }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  const gateway = await page.request.head('/maintenance');
  expect(gateway.headers()['x-clouddrive-maintenance']).toBeUndefined();
  const build = await page.request.get('/management/build');
  expect(build.ok()).toBe(true);
  const { version } = (await build.json()) as { version: string };
  expect(version).toBeTruthy();

  const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const updateWrite =
      url.origin === access.origin &&
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
  await expect(main.getByText(version, { exact: true }).first()).toBeVisible();
  const developmentNotice =
    process.platform === 'win32'
      ? /Windows 本地开发环境|local Windows development environment/i
      : /本地开发环境|local development environment/i;
  await expect(main.getByRole('status').filter({ hasText: developmentNotice })).toBeVisible();
  for (const name of [
    /^(检查更新|Check for updates)$/i,
    /^(升级|Upgrade)$/i,
    /^(回退|Roll back)$/i,
    /^(恢复|Restore)$/i,
  ]) {
    const action = main.getByRole('button', { name });
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
  }
  await expect(main.locator('a[href="/maintenance"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('system-update-development.png') });
  expect(blocked).toEqual([]);
});
