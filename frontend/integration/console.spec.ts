import { test, expect } from '@playwright/test';

test('empty SQLite setup, real business writes, protected native pages and logout', async ({
  browser,
  page,
}) => {
  const token = process.env.CLOUDDRIVE_TEST_SETUP_TOKEN;
  const password = process.env.CLOUDDRIVE_TEST_PASSWORD;
  if (!token || !password)
    throw new Error('Run scripts/Test-Integration.ps1 to create an isolated backend.');
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/setup');
  await page.getByLabel('姓名', { exact: true }).fill('验收管理员');
  await page.getByLabel('邮箱', { exact: true }).fill('acceptance@clouddrive.test');
  const passwordField = page.getByLabel('密码', { exact: true });
  const tokenField = page.getByLabel('设置令牌', { exact: true });
  const setupButton = page.getByRole('button', { name: '创建管理员', exact: true });
  const isSetupRequest = (request: { method(): string; url(): string }) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/console/v1/auth/setup';
  let setupRequests = 0;
  page.on('request', (request) => {
    if (isSetupRequest(request)) setupRequests++;
  });
  await tokenField.fill('not-the-fixture-setup-token');
  await passwordField.fill('短密码');
  await setupButton.click();
  await expect(passwordField).toHaveAttribute('aria-invalid', 'true');
  expect(setupRequests).toBe(0);
  await passwordField.fill(password);
  const rejected = page.waitForResponse((response) => isSetupRequest(response.request()));
  await setupButton.click();
  expect((await rejected).status()).toBe(401);
  await expect(tokenField).toHaveAttribute('aria-invalid', 'true');
  await tokenField.fill(token);
  await setupButton.click();
  await expect(page).toHaveURL(/\/home$/);
  const guest = await browser.newPage({ locale: 'zh-CN' });
  try {
    await guest.goto(new URL('/setup', page.url()).href);
    await expect(guest.getByRole('link', { name: /登录/ })).toBeVisible();
    await expect(guest.getByRole('button', { name: '创建管理员' })).toHaveCount(0);
    await guest.getByRole('button', { name: '无法登录？' }).click();
    await expect(guest.getByText(/iam recover-owner/)).toBeVisible();
    await guest.goto(new URL('/login', page.url()).href);
    await guest.getByRole('button', { name: '无法登录？' }).click();
    await expect(guest.getByText(/iam recover-owner/)).toBeVisible();
    await expect(guest.getByText('acceptance@clouddrive.test', { exact: true })).toHaveCount(0);
  } finally {
    await guest.close();
  }
  await page.goto('/users');
  await expect(
    page.getByRole('gridcell', { name: 'acceptance@clouddrive.test', exact: true }),
  ).toBeVisible();
  await page.goto('/workspace');
  await page.getByRole('button', { name: '添加待办', exact: true }).click();
  const todoDialog = page.getByRole('dialog', { name: '添加待办', exact: true });
  await todoDialog.getByRole('textbox').fill('浏览器真实待办');
  await todoDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('浏览器真实待办', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('浏览器真实待办', { exact: true })).toBeVisible();
  await page.goto('/system/departments');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('验收部门');
  await page.getByRole('dialog').getByLabel('编码', { exact: true }).fill('browser_department');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('rowheader', { name: '验收部门', exact: true })).toBeVisible();
  // Persist a real workspace, then execute from the actual browser editor and restore history.
  await page.evaluate(async () => {
    const base = '/api/console/v1';
    const csrf = (await fetch(base + '/auth/csrf').then((response) => response.json())) as {
      token: string;
    };
    const current = await fetch(base + '/api-workbench/workspace');
    const workspace = {
      version: 1,
      projects: [{ id: 'acceptance-project', name: '验收项目' }],
      collections: [
        { id: 'acceptance-collection', projectId: 'acceptance-project', name: '真实集合' },
      ],
      requests: [
        {
          id: 'acceptance-request',
          collectionId: 'acceptance-collection',
          name: '真实策略查询',
          method: 'GET',
          url: 'http://127.0.0.1:8088/api/console/v1/auth/registration-policy',
          params: [],
          headers: [],
          auth: { type: 'none' },
          body: { type: 'none' },
          disguise: { timeoutMs: 5000 },
          extractors: [],
          preScript: '',
          postScript: '',
        },
      ],
      environments: [],
      globals: [],
      tasks: [],
      history: [],
    };
    const saved = await fetch(base + '/api-workbench/workspace', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf.token,
        'If-Match': current.headers.get('ETag') ?? '',
      },
      body: JSON.stringify(workspace),
    });
    if (saved.status !== 204) throw new Error('Real workspace save failed: ' + saved.status);
  });
  await page.goto('/api-workbench');
  await expect(page.getByRole('textbox', { name: '请求 URL', exact: true })).toHaveValue(
    'http://127.0.0.1:8088/api/console/v1/auth/registration-policy',
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('200 OK', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button', { name: /8088\/api\/console/ })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button', { name: /8088\/api\/console/ })).toBeVisible();
  for (const route of [
    '/system/menus',
    '/system/dictionaries',
    '/analytics',
    '/account/security',
    '/account/tokens',
    '/system-tools/runtime',
  ]) {
    await page.goto(route);
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    // Wait for actual API completion rather than accepting a loading placeholder.
    await expect(
      page.getByRole('main').getByText('正在读取服务器数据…', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('main').getByText('操作未完成', { exact: true })).toHaveCount(0);
  }
  const result = await page.evaluate(async () => {
    const csrf = (await fetch('/api/console/v1/auth/csrf').then((response) => response.json())) as {
      token: string;
    };
    const response = await fetch('/api/console/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token },
      body: '{}',
    });
    return response.status;
  });
  expect(result).toBe(204);
  await page.reload();
  await expect(page).toHaveURL(/login|session-expired/);
  expect(failures).toEqual([]);
});
