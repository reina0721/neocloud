import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from './preview-test';
import { readPreviewAccess } from './reading-fixture';

const files = '/api/console/v1/native/files';

async function login(page: Page) {
  const access = readPreviewAccess();
  await page.goto('/login?returnTo=%2Fhome');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createFiles(page: Page) {
  const name = '界面验收-' + randomUUID().slice(0, 8);
  return page.evaluate(
    async ({ files, name }) => {
      const { token } = (await (await fetch('/api/console/v1/auth/csrf')).json()) as {
        token: string;
      };
      const create = async (path: string, data: object) => {
        const response = await fetch(files + path, {
          method: 'POST',
          body: JSON.stringify(data),
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        });
        if (!response.ok) throw new Error('Fixture creation HTTP ' + response.status);
        return (await response.json()) as { id: string };
      };
      const folder = await create('/folders', { name, parentId: '' });
      for (let index = 1; index <= 12; index++) {
        await create('/text', {
          name: '报告-' + String(index).padStart(2, '0') + '.txt',
          parentId: folder.id,
          text: 'review',
          key: crypto.randomUUID(),
        });
      }
      return { ...folder, name };
    },
    { files, name },
  );
}

test('文件布局以紧凑清单提供首屏结果并保留网格选择', async ({ page }, info) => {
  await login(page);
  const folder = await createFiles(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/home?parent=' + folder.id);
  await expect(page.locator('[data-workspace-header]')).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: folder.name, exact: true });
  const selectView = async (name: string) => {
    await toolbar.getByRole('button', { name: '视图', exact: true }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
    await expect(page.getByRole('menu', { name: '视图', exact: true })).toHaveCount(0);
  };
  const initial = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const value = (await response.json()) as { revision?: number; defaults?: { view: string } };
    return { revision: value.revision, view: value.defaults?.view };
  }, files + '/preferences');
  if (initial.revision === 0) {
    expect(initial.view).toBe('list');
    await expect(page.getByRole('table', { name: folder.name })).toBeVisible();
  }
  await selectView('列表');
  const rows = page.getByRole('table', { name: folder.name }).locator('[data-file-item]');
  await expect(rows).toHaveCount(12);
  await page.reload();
  await expect(rows).toHaveCount(12);
  await expect.poll(async () => (await rows.first().boundingBox())?.y).toBeLessThanOrEqual(160);
  expect((await rows.first().boundingBox())?.height).toBe(44);
  await page.setViewportSize({ width: 1280, height: 800 });
  const eight = await rows.nth(7).boundingBox();
  const viewport = await page.locator('[data-file-scroll-region]').boundingBox();
  expect(eight!.y + eight!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
  await page.screenshot({
    path: info.outputPath('files-compact-1280.png'),
    animations: 'disabled',
  });

  const beforeSelection = (await rows.first().boundingBox())!.y;
  const currentDirectory = page.url();
  await rows.first().getByRole('cell').nth(2).click();
  await expect(page).toHaveURL(currentDirectory);
  await expect(rows.first().getByRole('checkbox')).toBeChecked();
  await expect(toolbar.getByRole('region', { name: '选择操作' })).toBeVisible();
  expect(Math.abs((await rows.first().boundingBox())!.y - beforeSelection)).toBeLessThanOrEqual(2);
  await toolbar.getByRole('button', { name: '取消选择', exact: true }).click();
  await expect(toolbar.getByRole('region', { name: '选择操作' })).toHaveCount(0);
  expect(Math.abs((await rows.first().boundingBox())!.y - beforeSelection)).toBeLessThanOrEqual(2);
  await rows.first().getByRole('checkbox').check();
  await selectView('网格');
  await expect(page.getByRole('checkbox', { name: '选择 报告-01.txt' })).toBeChecked();
  const items = page.locator('[data-file-item]');
  const colCount = () =>
    items.evaluateAll((nodes) => {
      const top = nodes[0]?.getBoundingClientRect().top;
      return nodes.filter((node) => node.getBoundingClientRect().top === top).length;
    });
  await expect.poll(colCount).toBe(6);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(colCount).toBe(2);
  await page.reload();
  await expect(page.getByRole('table', { name: folder.name })).toHaveCount(0);
  await selectView('列表');
});

test('文件阅读成功与操作通知在真实路由中各出现一次', async ({ page }, info) => {
  await login(page);
  const folder = await createFiles(page);
  await page.goto('/home?parent=' + folder.id);
  await page.getByRole('button', { name: '报告-01.txt', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '报告-01.txt', exact: true });
  await expect(preview.locator('[data-file-text-preview] pre')).toHaveText('review');
  await expect(page.getByText('此文件或阅读应用当前不可用。', { exact: true })).toHaveCount(0);
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(preview).toHaveCount(0);

  await page.getByRole('button', { name: '报告-02.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
  await dialog.getByRole('textbox', { name: '名称' }).fill('已改名.txt');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '已改名.txt', exact: true })).toBeVisible();
  const done = page.getByText('操作完成', { exact: true });
  await expect(done).toHaveCount(1);
  await page.getByRole('link', { name: '连接与挂载', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接与挂载', exact: true })).toBeVisible();
  await expect(done).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('files-feedback-scope.png'),
    animations: 'disabled',
  });
});

test('文件个人管理共享顶栏且窄屏身份操作可达', async ({ page }, info) => {
  await login(page);
  const destinations = [
    ['/home', '我的文件', 'files'],
    ['/settings', '外观', 'personal'],
    ['/workspace', '管理概览', 'admin'],
  ] as const;
  for (const width of [1440, 1280, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [path, title, area] of destinations) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeAttached();
      const header = page.locator('[data-workspace-header]');
      await expect(header).toHaveCount(1);
      await expect(header.getByRole('button', { name: '当前用户' })).toBeVisible();
      await expect(header.getByRole('button', { name: /^通知/ })).toBeVisible();
      expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      if (area !== 'files')
        await expect(header.getByRole('link', { name: '返回我的文件', exact: true })).toBeVisible();
      if (width === 390 || width === 1440)
        await page.screenshot({
          path: info.outputPath(area + '-' + width + '.png'),
          animations: 'disabled',
        });
    }
  }
  await page
    .locator('[data-workspace-header]')
    .getByRole('link', { name: '返回我的文件', exact: true })
    .press('Enter');
  await expect(page).toHaveURL(/\/home$/);
});

test('管理清单返回时读回筛选并按选择显示批量操作', async ({ page }) => {
  await login(page);
  const { username } = readPreviewAccess();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/users');
  const search = page.getByRole('searchbox', { name: '搜索用户', exact: true });
  await search.fill(username);
  await search.press('Enter');
  await expect(page).toHaveURL(/q=/);
  const grid = page.getByRole('grid', { name: '用户目录', exact: true });
  const record = grid.getByRole('row').filter({ hasText: username });
  await expect(record).toHaveCount(1);
  await expect(page.getByRole('button', { name: '批量启用' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '选择当前页', exact: true }).check();
  await expect(page.getByRole('button', { name: '批量启用' })).toBeEnabled();
  await record.getByRole('link').click();
  const back = page.getByRole('link', { name: '返回用户列表', exact: true });
  await expect(back).toHaveAttribute('href', /\/users\?q=/);
  await back.click();
  await expect(search).toHaveValue(username);
  await expect(record).toHaveCount(1);
  await expect(page.getByRole('button', { name: '批量启用' })).toHaveCount(0);
});
