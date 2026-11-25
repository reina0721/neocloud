import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createFrontendI18n, FrontendI18nProvider } from '@clouddrive/i18n';
import { RequiredPasswordChange } from '../auth/required-password-change';
import { authenticationResources } from '../auth/translations';

vi.mock('../auth/frame', () => ({
  AuthFrame: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../auth/context', () => ({ useAuth: () => ({ expire: vi.fn() }) }));

function renderPasswordChange(request: typeof fetch) {
  vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'backend');
  vi.stubEnv('NEXT_PUBLIC_AUTH_API_BASE_URL', '/api/console/v1');
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/api/console/v1/auth/setup-policy') {
      return Promise.resolve(
        Response.json({ minLength: 4, maxLength: 24, requireComplexity: false, initialized: true }),
      );
    }
    return request(input, init);
  });
  render(
    <FrontendI18nProvider
      runtime={createFrontendI18n({
        resources: authenticationResources,
        defaultLocale: 'zh-CN',
        supportedLocales: ['zh-CN', 'en'],
      })}
    >
      <RequiredPasswordChange />
    </FrontendI18nProvider>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('关联必填与新旧密码相同的校验信息，拒绝提交至服务', async () => {
  const request = vi.fn<typeof fetch>();
  renderPasswordChange(request);
  const currentPassword = screen.getByLabelText('当前密码', { exact: true });
  const newPassword = screen.getByLabelText('新密码', { exact: true });
  const submit = screen.getByRole('button', { name: '保存并重新登录' });
  await waitFor(() => expect(newPassword).toHaveAccessibleDescription(/4–24/));

  fireEvent.click(submit);
  await waitFor(() => expect(currentPassword).toHaveFocus());
  expect(currentPassword).toHaveAccessibleDescription(/请输入当前密码/);
  expect(newPassword).toHaveAttribute('aria-invalid', 'true');

  fireEvent.change(currentPassword, { target: { value: 'fixture-password' } });
  fireEvent.change(newPassword, { target: { value: 'fixture-password' } });
  fireEvent.click(submit);
  await waitFor(() => expect(newPassword).toHaveFocus());
  expect(newPassword).toHaveAccessibleDescription(/不同于当前密码/);
  expect(request).not.toHaveBeenCalled();
});

it.each([
  [401, { code: 'unauthenticated' }, '当前密码不正确，或登录会话已失效'],
  [409, { code: 'conflict' }, '请选择近期未使用过的新密码'],
  [409, { code: 'conflict', reason: 'stale-version' }, '账户状态已更新'],
  [422, { code: 'validation' }, '新密码不符合此实例的密码要求'],
])('以改密文案呈现 HTTP %i 服务端错误 %j', async (status, error, description) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'fixture-csrf' }))
    .mockResolvedValueOnce(Response.json({ error }, { status }));
  renderPasswordChange(request);
  fireEvent.change(screen.getByLabelText('当前密码', { exact: true }), {
    target: { value: 'fixture-password' },
  });
  fireEvent.change(screen.getByLabelText('新密码', { exact: true }), {
    target: { value: 'new-test' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存并重新登录' }));

  const alert = await screen.findByRole('alert', { name: '未能修改密码' });
  expect(alert).toHaveTextContent(description);
  expect(request.mock.calls[1]?.[0]).toBe('/api/console/v1/auth/password');
});

it('当前密码输错时保留新密码，并将焦点定位回当前密码', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'fixture-csrf' }))
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'unauthenticated', reason: 'current-password-invalid' } },
        { status: 401 },
      ),
    );
  renderPasswordChange(request);
  const current = screen.getByLabelText('当前密码', { exact: true });
  const next = screen.getByLabelText('新密码', { exact: true });
  fireEvent.change(current, { target: { value: 'wrong-password' } });
  fireEvent.change(next, { target: { value: 'new-test' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并重新登录' }));
  await waitFor(() => expect(current).toHaveAccessibleDescription(/当前密码不正确/));
  await waitFor(() => expect(current).toHaveFocus());
  expect(next).toHaveValue('new-test');
  fireEvent.change(current, { target: { value: 'correct-password' } });
  expect(current).not.toHaveAttribute('aria-invalid', 'true');
});
