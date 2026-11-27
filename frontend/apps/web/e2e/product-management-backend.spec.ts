import { test, expect } from '@playwright/test';
import { installProductBackend } from './product-backend-fixture';

test('Both user directory entries work without role directory permission', async ({
  page,
  context,
}) => {
  await installProductBackend(context, ['users.read', 'users.update']);
  let roleDirectoryReads = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/roles' && url.searchParams.get('scope') !== 'self')
      roleDirectoryReads++;
  });
  for (const path of ['/users', '/users/administration']) {
    await page.goto(path);
    await expect(page.getByRole('gridcell', { name: 'backend@example.test' })).toBeVisible();
  }
  expect(roleDirectoryReads).toBe(0);
});

test('Registration settings show backend eligibility and can close registration with a missing saved role', async ({
  page,
  context,
}) => {
  const fixture = await installProductBackend(context);
  fixture.setRegistrationDefaultRole('removed-role');
  await page.goto('/system-settings');
  const roles = page.getByRole('combobox', { name: '注册账号默认角色', exact: true });
  await expect(roles).toContainText('原默认角色（removed-role）');
  await expect(roles).toHaveAccessibleDescription(
    '已保存的默认角色已不存在。请为公开注册选择其他角色。',
  );
  await roles.click();
  const protectedRole = page.getByRole('option', { name: 'Administrator', exact: true });
  await expect(protectedRole).toHaveAttribute('aria-disabled', 'true');
  await expect(protectedRole).toHaveAccessibleDescription('受保护的系统角色不可通过公开注册分配。');
  await page.keyboard.press('Escape');

  const enabled = page.getByRole('switch', { name: '开放公开注册', exact: true });
  const save = page.getByRole('button', { name: '保存策略', exact: true });
  await enabled.press('Space');
  await save.click();
  const confirmation = page.getByRole('alertdialog', { name: '确认注册策略变更', exact: true });
  await confirmation.getByRole('button', { name: '保存策略', exact: true }).click();
  await expect(page.getByText('注册策略已保存', { exact: true })).toBeVisible();
  await expect(roles).toContainText('原默认角色（removed-role）');
  await page.reload();
  await expect(enabled).not.toBeChecked();
  await expect(roles).toContainText('原默认角色（removed-role）');
  await enabled.press('Space');
  await save.click();
  await expect(roles).toHaveAccessibleDescription('请选择有效的默认角色。');
  await expect(confirmation).toHaveCount(0);
  expect(fixture.writes.filter((write) => write.path === '/system/registration')).toHaveLength(1);
});

test('Backend M2–M6 uses proposed REST/CSRF contracts, preserves conflict drafts and synchronizes notifications', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const fixture = await installProductBackend(context);
  await page.goto('/users/create');
  await page.getByRole('textbox', { name: '姓名', exact: true }).fill('Backend Member');
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('member@example.test');
  await page.getByLabel('初始密码', { exact: true }).fill('BackendPassword2026!');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(/\/users\/detail\?id=/, { timeout: 15000 });
  await page.goto('/account');
  fixture.rejectNextProfileWrite();
  await page.getByRole('textbox', { name: '姓名', exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('数据发生冲突');
  await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue(
    'Keep this draft',
  );
  await page.locator('form').first().getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue(
    'Server profile',
  );
  await page.getByRole('textbox', { name: '姓名', exact: true }).fill('Backend Updated');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByText('个人资料已保存', { exact: true })).toBeVisible();
  await page.goto('/roles/create');
  await page.getByRole('textbox', { name: '角色名称', exact: true }).fill('Backend Audit');
  await page.getByRole('checkbox', { name: '查询审计日志', exact: true }).press('Space');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认角色授权', exact: true })
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(page).toHaveURL(/\/roles\/detail\?id=/, { timeout: 15000 });
  await page.goto('/notifications');
  await expect(page.getByRole('main')).toContainText('Backend Audit');
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('0 条未读');
  await page.goto('/audit-logs');
  await expect(page.getByRole('main')).toContainText('Backend Audit');
  await expect(page.getByRole('main')).toContainText('Backend Updated');
  expect(fixture.writes.map((item) => item.path)).toEqual(
    expect.arrayContaining(['/users', '/me', '/roles', '/notifications/read-all']),
  );
  expect(fixture.writes.every((item) => item.csrf === 'product-csrf')).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('clouddrive.auth-mock'))).toBeNull();
  await page.goto('/system-settings');
  const registrationSwitch = page.getByRole('switch', { name: '开放公开注册', exact: true });
  await expect(registrationSwitch).toBeChecked();
  await registrationSwitch.press('Space');
  fixture.rejectNextPolicyWrite();
  await page.getByRole('button', { name: '保存策略', exact: true }).click();
  const policyConfirmation = page.getByRole('alertdialog', {
    name: '确认注册策略变更',
    exact: true,
  });
  await policyConfirmation.getByRole('button', { name: '保存策略', exact: true }).click();
  await expect(policyConfirmation).toContainText('策略保存失败，请检查错误并重试。');
  await policyConfirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('数据发生冲突');
  await expect(registrationSwitch).not.toBeChecked();
  await page.locator('form').first().getByRole('button', { name: '刷新', exact: true }).click();
  await expect(registrationSwitch).toBeChecked();
  await registrationSwitch.press('Space');
  await page.getByRole('button', { name: '保存策略', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '确认注册策略变更', exact: true })
    .getByRole('button', { name: '保存策略', exact: true })
    .click();
  await expect(page.getByText('注册策略已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(registrationSwitch).not.toBeChecked();
  expect(fixture.writes).toContainEqual({
    path: '/system/registration',
    method: 'PATCH',
    csrf: 'product-csrf',
  });
  expect(await page.evaluate(() => localStorage.getItem('clouddrive.auth-mock'))).toBeNull();
});
