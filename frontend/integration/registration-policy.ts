import { expect, type Browser, type Page } from '@playwright/test';
import { authPageHref } from '../apps/web/src/auth/contract';

export async function verifyRegistrationPolicy(page: Page, browser: Browser) {
  const base = '/api/console/v1';
  const created = await page.evaluate(async (base) => {
    const { token } = (await fetch(base + '/auth/csrf').then((response) => response.json())) as {
      token: string;
    };
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const response = await fetch(base + '/native/iam/roles', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: 'registration-upload', name: '验收上传角色', description: '' }),
    });
    if (!response.ok) throw new Error('Upload role creation failed: ' + response.status);
    const role = (await response.json()) as { id: string; version: number };
    const grants = await fetch(base + '/native/iam/roles/' + role.id + '/permissions', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ expectedRoleVersion: role.version, permissionKeys: ['files:write'] }),
    });
    if (!grants.ok) throw new Error('Upload role grant failed: ' + grants.status);
    return role.id;
  }, base);
  const options = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === base + '/system/registration' &&
      url.searchParams.get('include') === 'roleOptions'
    );
  });
  await page.goto('/system-settings');
  const optionsResponse = await options;
  expect(optionsResponse.ok()).toBe(true);
  const configuration = (await optionsResponse.json()) as { roleOptions: unknown[] };
  expect(configuration.roleOptions).toContainEqual(
    expect.objectContaining({ id: created, eligible: false, reason: 'restricted-permissions' }),
  );
  const roles = page.getByRole('combobox', { name: '注册账号默认角色', exact: true });
  const enabled = page.getByRole('switch', { name: '开放公开注册', exact: true });
  await enabled.check();
  await roles.click();
  const unsafeRole = page.getByRole('option', { name: '验收上传角色', exact: true });
  await expect(unsafeRole).toHaveAttribute('aria-disabled', 'true');
  await expect(unsafeRole).toHaveAccessibleDescription('此角色含有公开注册不可分配的权限。');
  await page.getByRole('option', { name: '重命名验收角色', exact: true }).click();
  await page.getByRole('button', { name: '保存策略', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认注册策略变更', exact: true })
    .getByRole('button', { name: '保存策略', exact: true })
    .click();
  await expect(page.getByText('注册策略已保存', { exact: true })).toBeVisible();

  const member = await browser.newPage({ baseURL: new URL(page.url()).origin, locale: 'zh-CN' });
  try {
    const destination = '/home?acceptance=registration#return-target';
    await member.goto(authPageHref('/register', destination));
    await member.getByRole('textbox', { name: '姓名', exact: true }).fill('注册验收成员');
    await member
      .getByRole('textbox', { name: '邮箱', exact: true })
      .fill('registration@neocloud.test');
    await member.getByLabel('密码', { exact: true }).fill('RegistrationAcceptance2026!');
    await member.getByLabel('确认密码', { exact: true }).fill('RegistrationAcceptance2026!');
    await member.getByRole('button', { name: '创建账户', exact: true }).click();
    await expect(member.getByText('账户已创建', { exact: true })).toBeVisible();
    await expect(
      member.getByText('此账号可以查看文件。如需上传或分享，请联系管理员开通文件写入权限。', {
        exact: true,
      }),
    ).toBeVisible();
    await member.getByRole('button', { name: '开始使用', exact: true }).click();
    await expect(member).toHaveURL(destination);
  } finally {
    await member.close();
  }
}
