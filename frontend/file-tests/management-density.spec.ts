import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from './preview-test';
import { readPreviewAccess } from './reading-fixture';

async function login(page: Page) {
  const { username, password } = readPreviewAccess();
  await page.goto('/login?returnTo=%2Fworkspace');
  await page.getByLabel('邮箱', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  return username;
}

async function top(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
}

async function expectButtonHit(target: Locator) {
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const control = element.closest('label') ?? element;
        const { left, top, width, height } = control.getBoundingClientRect();
        return control.contains(document.elementFromPoint(left + width / 2, top + height / 2));
      }),
    )
    .toBe(true);
}

test('管理概览与用户首行优先呈现，批量操作复用工具区', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const username = await login(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('管理概览');
  const group = main.getByRole('heading', { name: '文件与协作', exact: true });
  const groupTop = await top(group);
  expect(groupTop).toBeLessThanOrEqual(160);
  const usersEntry = main.getByRole('link', { name: /^用户管理/ });
  await expect(usersEntry).toHaveAttribute('href', '/users');
  await page.screenshot({
    path: info.outputPath('admin-overview-1440.png'),
    animations: 'disabled',
  });
  await usersEntry.click();
  await expect(page).toHaveURL(/\/users$/);
  const title = main.getByRole('heading', { level: 1, name: '用户管理', exact: true });
  const region = main.getByRole('region', { name: '用户管理', exact: true });
  await expect(title).toBeVisible();
  await expect(region).toBeVisible();
  await expect(region.getByRole('heading', { name: '用户目录', exact: true })).toHaveCount(0);
  const row = region.getByRole('grid', { name: '用户目录', exact: true }).getByRole('row').filter({
    hasText: username,
  });
  const rowTop = await top(row);
  await info.attach('admin-metrics.json', {
    body: JSON.stringify({ groupTop, rowTop }),
    contentType: 'application/json',
  });
  expect(rowTop).toBeLessThanOrEqual(240);
  const enable = region.getByRole('button', { name: '批量启用', exact: true });
  const disable = region.getByRole('button', { name: '批量停用', exact: true });
  const selectable = region.getByRole('checkbox', { name: '选择当前页', exact: true });
  const columnSettings = region.getByRole('button', { name: '列设置', exact: true });
  const exportMenu = region.getByRole('button', { name: '导出用户数据', exact: true });
  await expect(enable).toHaveCount(0);
  await expect(disable).toHaveCount(0);
  await expectButtonHit(columnSettings);
  await expectButtonHit(exportMenu);
  await page.screenshot({
    path: info.outputPath('admin-users-1440.png'),
    animations: 'disabled',
  });

  await selectable.press('Space');
  await expect(selectable).toBeChecked();
  await expect(selectable).toBeFocused();
  await expect(columnSettings).toHaveCount(0);
  await expectButtonHit(disable);
  await disable.click();
  const confirmation = page.getByRole('alertdialog', {
    name: '确认批量修改账号状态',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(disable).toBeFocused();
  await expect(selectable).toBeChecked();
  await exportMenu.click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^导出所选/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('users-selection.csv');
  const path = await download.path();
  if (!path) throw new Error('未收到所选用户 CSV');
  expect(await readFile(path, 'utf8')).toContain(username);
  await selectable.press('Space');
  await expect(disable).toHaveCount(0);
  await expect(columnSettings).toBeVisible();

  const commandTrigger = page.getByRole('button', { name: '按 Ctrl K 搜索', exact: true });
  await commandTrigger.focus();
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: '快速跳转', exact: true });
  const commandInput = command.getByRole('combobox', { name: '搜索命令', exact: true });
  await expect(commandInput).toBeFocused();
  await commandInput.press('Escape');
  await expect(command).toHaveCount(0);
  await expect(commandTrigger).toBeFocused();
});

test('窄屏与暗色保留真实用户结果和返回筛选', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const username = await login(page);
  await page.goto('/users');
  const main = page.getByRole('main');
  const cards = main.getByRole('list', { name: '用户目录', exact: true });
  const card = cards.getByRole('listitem').filter({ hasText: username });
  await info.attach('admin-mobile-metrics.json', {
    body: JSON.stringify({ firstCardTop: await top(card) }),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('admin-users-390.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const search = main.getByRole('searchbox', { name: '搜索用户', exact: true });
  await search.fill(username);
  await search.press('Enter');
  await expect(page).toHaveURL(/\/users\?q=/);
  await expect(card).toBeVisible();
  await expect(main.getByRole('combobox', { name: '每页条数', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('admin-users-390-dark.png'),
    animations: 'disabled',
  });
  for (const width of [320, 713, 800]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(() =>
        page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    const exportMenu = main.getByRole('button', { name: '导出用户数据', exact: true });
    await expectButtonHit(exportMenu);
    await expectButtonHit(main.getByRole('checkbox', { name: '选择当前页', exact: true }));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByRole('link').click();
  const back = main.getByRole('link', { name: '返回用户列表', exact: true });
  await expect(back).toHaveAttribute('href', /\/users\?q=/);
  await back.click();
  await expect(search).toHaveValue(username);
  await expect(card).toBeVisible();
});
