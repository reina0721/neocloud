import { test, expect } from '@playwright/test';
import { readNeoCloudEnv } from '../apps/web/runtime/environment.mjs';
import { verifyFilesOverflow } from './files-overflow';
import { verifyRegistrationPolicy } from './registration-policy';

test('empty SQLite setup, real business writes, protected native pages and logout', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const token = readNeoCloudEnv('TEST_SETUP_TOKEN');
  const password = readNeoCloudEnv('TEST_PASSWORD');
  const apiUrl = readNeoCloudEnv('TEST_API_URL') ?? 'http://127.0.0.1:8088';
  const policyUrl = apiUrl + '/api/console/v1/auth/registration-policy';
  if (!token || !password)
    throw new Error('Run node scripts/dev.mjs --acceptance to create an isolated backend.');
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
  await page.goto('/system-settings');
  const policySection = page.getByText('密码强度', { exact: true });
  await expect(policySection).toBeVisible();
  const minimum = page.getByLabel('最少字符数', { exact: true });
  await minimum.fill('4');
  await page.getByRole('button', { name: '保存密码规则', exact: true }).click();
  await expect(page.getByText('当前使用在此保存的规则。')).toBeVisible();
  const effectivePolicy = (await (
    await page.request.get('/api/console/v1/auth/setup-policy')
  ).json()) as {
    minLength: number;
  };
  expect(effectivePolicy.minLength).toBe(4);
  await page.getByRole('button', { name: '恢复配置中的规则', exact: true }).click();
  await expect(minimum).toHaveValue('8');
  await page.goto('/users');
  await expect(
    page.getByRole('gridcell', { name: 'acceptance@clouddrive.test', exact: true }),
  ).toBeVisible();
  await page.goto('/users/administration');
  await expect(
    page.getByRole('gridcell', { name: 'acceptance@clouddrive.test', exact: true }),
  ).toBeVisible();
  await page.goto('/roles/catalog');
  await expect(page.getByText('iam:permission:read', { exact: true })).toBeVisible();
  await test.step('角色详情编辑原生授权，名称修改保留授权和描述', async () => {
    const role = await page.evaluate(async () => {
      const base = '/api/console/v1';
      const { token } = (await fetch(base + '/auth/csrf').then((response) => response.json())) as {
        token: string;
      };
      const created = await fetch(base + '/native/iam/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ code: 'browser-role', name: '验收角色', description: '原始描述' }),
      });
      if (created.status !== 201)
        throw new Error('Role fixture creation failed: ' + created.status);
      return (await created.json()) as { id: string; version: number };
    });
    const detail = '/roles/detail?id=' + encodeURIComponent(role.id);
    await page.goto(detail);
    await page.getByRole('button', { name: '编辑角色权限', exact: true }).click();
    const permissions = page.getByRole('dialog', { name: '编辑角色权限', exact: true });
    await permissions.getByRole('checkbox', { name: 'files:read', exact: true }).check();
    const grant = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname ===
          `/api/console/v1/native/iam/roles/${role.id}/permissions`,
    );
    await permissions.getByRole('button', { name: '保存', exact: true }).click();
    const granted = await grant;
    expect(granted.status()).toBe(200);
    expect(granted.request().postDataJSON()).toEqual({
      expectedRoleVersion: role.version,
      permissionKeys: ['files:read'],
    });
    await expect(permissions).toBeHidden();
    await expect(page.getByText('files:read', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: '修改角色名称', exact: true }).click();
    await expect(page.getByRole('heading', { name: '修改角色名称', level: 1 })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('textbox', { name: '角色名称', exact: true }).fill('重命名验收角色');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const rename = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/api/console/v1/native/iam/roles/${role.id}`,
    );
    await page
      .getByRole('alertdialog', { name: '修改角色名称', exact: true })
      .getByRole('button', { name: '保存', exact: true })
      .click();
    expect((await rename).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/roles/detail\\?id=${role.id}$`));
    const saved = await page.evaluate(async (id) => {
      const response = await fetch('/api/console/v1/native/iam/roles/' + encodeURIComponent(id));
      if (!response.ok) throw new Error('Role read-back failed: ' + response.status);
      return (await response.json()) as unknown;
    }, role.id);
    expect(saved).toMatchObject({
      role: { name: '重命名验收角色', description: '原始描述' },
      permissions: [{ key: 'files:read' }],
    });
  });
  await test.step('公开注册发放实际的只读角色并保留浏览器返回地址', () =>
    verifyRegistrationPolicy(page, browser));
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
  await page.evaluate(async (policyUrl) => {
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
          url: policyUrl,
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
  }, policyUrl);
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', {
      name: '接口调试',
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/api-workbench$/);
  await expect(page.getByRole('textbox', { name: '请求 URL', exact: true })).toHaveValue(policyUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('200 OK', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button', { name: policyUrl, exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: '历史', exact: true }).click();
  await expect(page.getByRole('button', { name: policyUrl, exact: false })).toBeVisible();
  await test.step('读取与保存账号资料后，同一会话仍能同步偏好', async () => {
    const profilePath = '/api/console/v1/native/iam/self/profile';
    const profileRead = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === profilePath,
    );
    await page.goto('/account');
    const initial = await profileRead;
    expect(initial.status()).toBe(200);
    const { version } = (await initial.json()) as { version: number };
    const profile = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '扩展资料', exact: true }) });
    await profile.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '扩展资料', exact: true });
    await editor.getByLabel('昵称', { exact: true }).fill('验收昵称');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && new URL(response.url()).pathname === profilePath,
    );
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({ expectedVersion: version });
    await expect(profile.getByText('验收昵称', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '前往外观与偏好设置', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });
  await test.step('账号主题同步，界面密度留在当前设备', async () => {
    await page
      .getByRole('radiogroup', { name: '界面密度' })
      .getByText('紧凑', { exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/api/console/v1/native/iam/self/preferences',
    );
    await page
      .getByRole('radiogroup', { name: '主题模式' })
      .getByText('深色主题', { exact: true })
      .click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const patch = response.request().postDataJSON() as { themeMode?: string; density?: string };
    expect(patch.themeMode).toBe('dark');
    expect(patch.density).toBeUndefined();

    const secondDevice = await browser.newContext({
      locale: 'zh-CN',
      storageState: { cookies: await page.context().cookies(), origins: [] },
    });
    try {
      const other = await secondDevice.newPage();
      await other.goto(new URL('/settings', page.url()).href);
      await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(other.locator('html')).toHaveAttribute('data-density', 'standard');
    } finally {
      await secondDevice.close();
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  });
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
  const temporaryPassword = 'tempword';
  const permanentPassword = 'newpassw';
  const owned = await page.evaluate(async () => {
    const base = '/api/console/v1';
    const csrf = (await fetch(base + '/auth/csrf').then((response) => response.json())) as {
      token: string;
    };
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token };
    const session = (await fetch(base + '/auth/session').then((response) => response.json())) as {
      user: { id: string };
    };
    const folder = await fetch(base + '/native/files/folders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ parentId: '', name: '恢复验收文件夹' }),
    });
    if (!folder.ok) throw new Error('Recovery fixture folder failed: ' + folder.status);
    const entry = (await folder.json()) as { id: string };
    return {
      accountId: session.user.id,
      fileId: entry.id,
    };
  });
  await page.goto('/users/detail?id=' + encodeURIComponent(owned.accountId));
  const resetTrigger = page.getByRole('button', { name: '重置密码', exact: true });
  await resetTrigger.click();
  const resetDialog = page.getByRole('dialog', { name: '重置密码', exact: true });
  await resetDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(resetTrigger).toBeFocused();
  await resetTrigger.click();
  await resetDialog.getByLabel('新密码', { exact: true }).fill(temporaryPassword);
  const reset = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/api/console/v1/native/iam/accounts/${owned.accountId}/password-reset`,
  );
  await resetDialog.getByRole('button', { name: '重置密码', exact: true }).click();
  const resetResponse = await reset;
  expect(resetResponse.status()).toBe(204);
  expect(resetResponse.request().headers()['if-match']).toMatch(/^"\d+"$/);
  await expect(page).toHaveURL(/\/login$/);
  expect(
    await page.evaluate(async () => (await fetch('/api/console/v1/auth/session')).status),
  ).toBe(401);
  async function signIn(value: string) {
    await page.goto('/login');
    await page.getByLabel(/邮箱/).fill('acceptance@clouddrive.test');
    await page.getByLabel('密码', { exact: true }).fill(value);
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await signIn(temporaryPassword);
  await expect(page.getByRole('heading', { name: '必须修改密码' })).toBeVisible();
  await page.getByLabel('当前密码', { exact: true }).fill(temporaryPassword);
  await page.getByLabel('新密码', { exact: true }).fill(permanentPassword);
  await page.getByRole('button', { name: '保存并重新登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(permanentPassword);
  await expect(page).toHaveURL(/\/home$/);
  const afterReset = await page.evaluate(async (fileId) => {
    const base = '/api/console/v1';
    const [session, detail] = await Promise.all([
      fetch(base + '/auth/session'),
      fetch(base + '/native/files/' + encodeURIComponent(fileId)),
    ]);
    if (!session.ok || !detail.ok)
      throw new Error('Recovery verification failed: ' + session.status + '/' + detail.status);
    const identity = (await session.json()) as { user: { id: string } };
    const file = (await detail.json()) as { entry: { name: string } };
    return { accountId: identity.user.id, name: file.entry.name };
  }, owned.fileId);
  expect(afterReset).toEqual({ accountId: owned.accountId, name: '恢复验收文件夹' });
  await test.step('文件条目超限后仍可浏览和清理', () => verifyFilesOverflow(page));
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
