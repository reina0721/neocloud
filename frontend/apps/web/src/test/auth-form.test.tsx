import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createFrontendI18n, FrontendI18nProvider } from '@neocloud/i18n';
import { AuthForm } from '../auth/auth-form';
import type { LoginInput } from '../auth/contract';
import { authenticationResources } from '../auth/translations';

const { login, register } = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
vi.mock('../auth/context', () => ({ useAuth: () => ({ login, register }) }));
vi.mock('../auth/frame', () => ({
  AuthFrame: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../auth/demo-access', () => ({ DemoAccessPanel: () => null }));
vi.mock('../auth/registration-policy', () => ({
  readRegistrationAvailability: () => Promise.resolve(true),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

function renderAuth(kind: 'login' | 'expired' | 'register', mode: 'backend' | 'mock') {
  vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', mode);
  vi.stubEnv('NEXT_PUBLIC_AUTH_API_BASE_URL', '/api/console/v1');
  render(
    <FrontendI18nProvider
      runtime={createFrontendI18n({
        resources: authenticationResources,
        defaultLocale: 'zh-CN',
        supportedLocales: ['zh-CN', 'en'],
      })}
    >
      <AuthForm kind={kind} />
    </FrontendI18nProvider>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  login.mockReset();
  register.mockReset();
});

it.each(['login', 'expired'] as const)(
  '真实 %s 接受合法 IAM 用户名，沿用 email 字段',
  async (kind) => {
    login.mockResolvedValue(false);
    renderAuth(kind, 'backend');
    const identifier = screen.getByLabelText('邮箱', { exact: true });
    const password = screen.getByLabelText('密码', { exact: true });
    const submit = screen.getByRole('button', { name: '登录' });
    expect(identifier).toHaveAccessibleDescription('也可输入用户名。');
    expect(identifier).toHaveAttribute('type', 'text');

    fireEvent.change(identifier, { target: { value: '-Owner' } });
    fireEvent.change(password, { target: { value: 'fixture-password' } });
    fireEvent.click(submit);
    await waitFor(() => expect(identifier).toHaveAttribute('aria-invalid', 'true'));
    expect(login).not.toHaveBeenCalled();

    fireEvent.change(identifier, { target: { value: ' Owner._-01 ' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: 'Owner._-01',
        password: 'fixture-password',
      } satisfies LoginInput),
    );
  },
);

it.each([
  ['login', 'mock', '登录'],
  ['register', 'backend', '创建账户'],
] as const)('%s %s 继续要求邮箱', async (kind, mode, submitName) => {
  renderAuth(kind, mode);
  const identifier = await screen.findByLabelText('邮箱', { exact: true });
  expect(identifier).toHaveAttribute('type', 'email');
  expect(identifier).not.toHaveAccessibleDescription('也可输入用户名。');
  fireEvent.change(identifier, { target: { value: 'Owner_01' } });
  fireEvent.click(screen.getByRole('button', { name: submitName }));
  await waitFor(() => expect(identifier).toHaveAttribute('aria-invalid', 'true'));
  expect(login).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});
