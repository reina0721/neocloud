import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';
import type { FileApplicationPolicy } from '../surfaces/src/files/file-applications';

async function login(page: Page) {
  const access = readPreviewAccess();
  await page.goto('/login?returnTo=%2Fhome');
  await page.getByLabel('邮箱', { exact: true }).fill(access.username);
  await page.getByLabel('密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function fixture(page: Page, extra = 0, extension = 'txt') {
  return page.evaluate(
    async ({ suffix, extra, extension }) => {
      const base = '/api/console/v1';
      const { token } = (await (await fetch(base + '/auth/csrf')).json()) as { token: string };
      async function create(path: string, body: unknown) {
        const response = await fetch(base + '/native/files' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('Fixture HTTP ' + response.status);
        return (await response.json()) as { id: string; name: string };
      }
      const root = await create('/folders', { parentId: '', name: '阅读会话-' + suffix });
      const next = await create('/folders', { parentId: root.id, name: '另一个目录-' + suffix });
      const file = await create('/text', {
        parentId: root.id,
        name: `迟到的文件-${suffix}.${extension}`,
        text: 'This reader belongs to the previous directory.',
        key: suffix,
      });
      const files = [file];
      for (let index = 1; index <= extra; index++) {
        files.push(
          await create('/text', {
            parentId: root.id,
            name: `阅读会话-${index}.txt`,
            text: `第 ${index} 份文件`,
            key: `${suffix}-${index}`,
          }),
        );
      }
      return { root, next, file, files };
    },
    { suffix: randomUUID(), extra, extension },
  );
}

test('离开目录后，迟到的应用选择响应不能打开旧文件', async ({ page }) => {
  await login(page);
  const { root, next, file } = await fixture(page);
  await page.goto('/home?parent=' + root.id);
  await expect(page.getByRole('button', { name: file.name, exact: true })).toBeVisible();
  let release!: () => void;
  let requested!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route('**/native/files/applications/active', async (route) => {
    const response = await route.fetch();
    requested();
    await gate;
    try {
      await route.fulfill({ response });
    } finally {
      delivered();
    }
  });
  await page.getByRole('button', { name: file.name, exact: true }).click();
  await started;
  await page.getByRole('button', { name: next.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp('parent=' + next.id));
  release();
  await settled;
  // 给已完成响应一次完整打开窗口；断言的是旧阅读器始终没有出现。
  const opened = await page
    .getByRole('dialog')
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(
      () => true,
      () => false,
    );
  expect(opened, 'A reader from the previous directory opened after navigation').toBe(false);
  await expect(
    page.getByRole('heading', { level: 1, name: next.name, exact: true }),
  ).toBeAttached();
});

test('独立文件页与应用盒子保留会话，盒子尺寸与打开数量无关', async ({ page }, info) => {
  await login(page);
  const { root, next, files } = await fixture(page, 8);
  await page.goto('/home?parent=' + root.id);
  const launcher = page.getByRole('button', { name: '已打开应用', exact: true });
  const box = page.locator('[data-file-app-box]');
  const listFile = (name: string) => page.getByRole('button', { name, exact: true });
  let size: { width: number; height: number } | undefined;
  for (const [index, file] of files.slice(0, 8).entries()) {
    await listFile(file.name).click();
    await expect(page).toHaveURL(new RegExp(`/home/view\\?file=${file.id}&app=`));
    const reader = page.getByRole('dialog', { name: file.name, exact: true });
    await reader.getByRole('button', { name: '最小化', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`parent=${root.id}$`));
    if (index === 0) {
      await expect(listFile(file.name)).toBeFocused();
      await launcher.press('Enter');
      const bounds = await box.boundingBox();
      if (!bounds) throw new Error('应用盒子未打开');
      size = { width: bounds.width, height: bounds.height };
      await page.keyboard.press('Escape');
    }
  }
  await listFile(files[8]!.name).click();
  await expect(page.getByRole('status').filter({ hasText: '最多打开 8 个文件' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`parent=${root.id}$`));
  await listFile(next.name).click();
  await expect(page).toHaveURL(new RegExp(`parent=${next.id}$`));
  await launcher.press('Enter');
  const bounds = await box.boundingBox();
  expect(bounds && { width: bounds.width, height: bounds.height }).toEqual(size);
  await expect(box.locator('li')).toHaveCount(8);
  await page.screenshot({ path: info.outputPath('file-application-box.png') });
  await box.getByRole('button', { name: files[0]!.name, exact: true }).click();
  const reader = page.getByRole('dialog', { name: files[0]!.name, exact: true });
  await expect(reader).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`parent=${next.id}$`));
  await launcher.press('Enter');
  await expect(box.locator('li')).toHaveCount(7);
});

for (const [extension, title] of [
  ['txt', '文本'],
  ['md', 'Markdown'],
] as const) {
  test(`收纳和刷新后从应用盒子还原${title}草稿，关闭可保留或放弃`, async ({ page }) => {
    await login(page);
    const { root, file } = await fixture(page, 0, extension);
    await page.goto('/home?parent=' + root.id);
    const namedReader = page.getByRole('dialog', { name: file.name, exact: true });
    const editor = namedReader.getByLabel('文件内容', { exact: true });
    const expectText = (text: string) =>
      extension === 'md' ? expect(editor).toHaveValue(text) : expect(editor).toHaveText(text);
    const launcher = page.getByRole('button', { name: '已打开应用', exact: true });
    const appBox = page.locator('[data-file-app-box]');
    const openEditor = async () => {
      await page.getByRole('button', { name: file.name + ' 的操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '编辑文本', exact: true }).click();
    };
    await openEditor();
    await editor.fill('本机草稿还原验证');
    await expect(namedReader.getByRole('status', { name: '', exact: true })).toContainText(
      '已存为本机草稿',
    );
    await namedReader.getByRole('button', { name: '最小化', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`parent=${root.id}$`));
    await page.reload();
    await launcher.press('Enter');
    await appBox.getByRole('button', { name: `${file.name} 草稿`, exact: true }).click();
    await expectText('本机草稿还原验证');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
    await expect(launcher).toHaveCount(0);
    await openEditor();
    await expectText('本机草稿还原验证');
    await namedReader.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await openEditor();
    await expectText('This reader belongs to the previous directory.');
  });
}

test('已回收文件刷新后暂停恢复并说明原因', async ({ page }) => {
  await login(page);
  const { root, file } = await fixture(page);
  await page.goto('/home?parent=' + root.id);
  await page.getByRole('button', { name: file.name, exact: true }).click();
  await page.getByRole('button', { name: '最小化', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`parent=${root.id}$`));
  await page.evaluate(async (id) => {
    const base = '/api/console/v1';
    const { token } = (await (await fetch(base + '/auth/csrf')).json()) as { token: string };
    const response = await fetch(base + '/native/files/' + encodeURIComponent(id) + '/trash', {
      method: 'POST',
      headers: { 'X-CSRF-Token': token },
    });
    if (!response.ok) throw new Error('Fixture HTTP ' + response.status);
  }, file.id);
  await page.reload();
  await page.getByRole('button', { name: '已打开应用', exact: true }).press('Enter');
  await page
    .locator('[data-file-app-box]')
    .getByRole('button', { name: '文件或目录不存在，或已移入回收站。', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: '文件或目录不存在，或已移入回收站。' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: file.name, exact: true })).toHaveCount(0);
});

test('IndexedDB 不可写时编辑器保留内存内容并提示保存失败', async ({ page }) => {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, version) => {
      if (name === 'clouddrive-file-readers')
        throw new DOMException('Fixture', 'QuotaExceededError');
      return open(name, version);
    };
  });
  await login(page);
  const { root, file } = await fixture(page);
  await page.goto('/home?parent=' + root.id);
  await page.getByRole('button', { name: file.name + ' 的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑文本', exact: true }).click();
  const reader = page.getByRole('dialog', { name: file.name, exact: true });
  const editor = reader.getByLabel('文件内容', { exact: true });
  await editor.fill('需要保留在内存的文字');
  await expect(
    reader.getByText('本机草稿保存失败，当前修改仍保留在页面中。', { exact: true }),
  ).toBeVisible();
  await reader.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '本机草稿保存失败' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(editor).toHaveText('需要保留在内存的文字');
});

test('同页 Office 会话刷新后重新授权，旧令牌不会恢复', async ({ page }) => {
  await login(page);
  const { root, file } = await fixture(page);
  const id = `web-${randomUUID().replaceAll('-', '')}` as const;
  const origin = 'https://office-reader.example.test';
  const name = '测试 Office 阅读器';
  await page.route('**/native/files/applications/active', async (route) => {
    const response = await route.fetch();
    const policy = (await response.json()) as FileApplicationPolicy;
    await route.fulfill({
      response,
      json: {
        ...policy,
        defaults: [
          ...policy.defaults.filter((item) => item.extension !== 'txt'),
          { extension: 'txt', app: id },
        ],
        webItems: [
          {
            id,
            name,
            origin,
            extensions: ['txt'],
            enabled: true,
            platform: 'all',
            maxBytes: 0,
            newTab: false,
            protocol: 'wopi',
          },
        ],
      },
    });
  });
  let authorizations = 0;
  await page.route(`**/native/files/${file.id}/web-preview`, async (route) => {
    authorizations++;
    await route.fulfill({
      json: {
        origin,
        name: file.name,
        urlTemplate: '',
        newTab: false,
        token: `fixture-${authorizations}`,
        wopi: { actionUrl: `${origin}/reader`, expiresAtMilliseconds: Date.now() + 300_000 },
      },
    });
  });
  await page.route(`${origin}/reader?*`, async (route) => {
    expect(new URLSearchParams(route.request().postData() ?? '').get('access_token')).toBe(
      `fixture-${authorizations}`,
    );
    await route.fulfill({ contentType: 'text/html', body: '<h1>Office mock ready</h1>' });
  });
  await page.goto('/home?parent=' + root.id);
  await page.getByRole('button', { name: file.name, exact: true }).click();
  const reader = page.getByRole('dialog', { name: file.name, exact: true });
  const allow = reader.getByRole('button', { name: '允许并继续', exact: true });
  const frame = reader.locator('iframe');
  await expect(allow).toBeVisible();
  await allow.click();
  await expect(
    frame.contentFrame().getByRole('heading', { name: 'Office mock ready' }),
  ).toBeVisible();
  await page.reload();
  await expect(allow).toBeVisible();
  await expect(frame).toHaveCount(0);
  expect(authorizations).toBe(1);
  await allow.click();
  await expect(
    frame.contentFrame().getByRole('heading', { name: 'Office mock ready' }),
  ).toBeVisible();
  expect(authorizations).toBe(2);
});
