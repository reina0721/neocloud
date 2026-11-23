import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createFrontendI18n, FrontendI18nProvider } from '@clouddrive/i18n';
import { SetupForm } from '../auth/setup-form';
import { authenticationResources } from '../auth/translations';

vi.mock('../auth/frame', () => ({
  AuthFrame: ({ children }: { children: ReactNode }) => children,
}));

const defaultPolicy = {
  minLength: 15,
  maxLength: 128,
  requireComplexity: false,
  initialized: false,
};

function renderSetup(readPolicy: () => Response, submit = vi.fn<() => Response>()) {
  vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'backend');
  vi.stubEnv('NEXT_PUBLIC_AUTH_API_BASE_URL', '/api/console/v1');
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      switch (url) {
        case '/api/console/v1/auth/setup-policy':
          return Promise.resolve(readPolicy());
        case '/api/console/v1/auth/csrf':
          return Promise.resolve(Response.json({ token: 'fixture-csrf' }));
        case '/api/console/v1/auth/setup':
          return Promise.resolve(submit());
        default:
          return Promise.reject(new Error('Unexpected request'));
      }
    }),
  );
  render(
    <FrontendI18nProvider
      runtime={createFrontendI18n({
        resources: authenticationResources,
        defaultLocale: 'zh-CN',
        supportedLocales: ['zh-CN', 'en'],
      })}
    >
      <SetupForm />
    </FrontendI18nProvider>,
  );
  return submit;
}

function fill(field: string, value: string) {
  fireEvent.change(screen.getByLabelText(field, { exact: true }), { target: { value } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('在失焦和提交时显示默认密码要求，拦截短密码且将错误关联到控件', async () => {
  const submit = renderSetup(() => Response.json(defaultPolicy));
  const password = await screen.findByLabelText('密码', { exact: true });
  const button = screen.getByRole('button', { name: '创建管理员' });
  expect(password).toHaveAccessibleDescription('请输入 15–128 个字符。');

  fill('姓名', '测试管理员');
  fill('邮箱', 'fixture@example.test');
  fill('设置令牌', 'fixture-token');
  fill('密码', '🌲'.repeat(14));
  fireEvent.blur(password);
  await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
  fireEvent.click(button);
  await waitFor(() => expect(password).toHaveFocus());
  expect(submit).not.toHaveBeenCalled();
});

it('应用实际复杂度和长度，定位令牌错误并在并发初始化后提供登录入口', async () => {
  const submit = vi
    .fn<() => Response>()
    .mockReturnValueOnce(
      Response.json(
        { error: { code: 'unauthenticated', reason: 'invalid-setup-token' } },
        { status: 401 },
      ),
    )
    .mockReturnValueOnce(
      Response.json({ error: { code: 'conflict', reason: 'setup-closed' } }, { status: 409 }),
    );
  renderSetup(
    () => Response.json({ ...defaultPolicy, minLength: 8, maxLength: 12, requireComplexity: true }),
    submit,
  );
  const password = await screen.findByLabelText('密码', { exact: true });
  const token = screen.getByLabelText('设置令牌', { exact: true });
  const button = screen.getByRole('button', { name: '创建管理员' });
  expect(password).toHaveAccessibleDescription(/8–12 个字符.*大写字母.*小写字母.*数字/);
  fill('姓名', '测试管理员');
  fill('邮箱', 'fixture@example.test');
  fill('设置令牌', 'fixture-token');
  fill('密码', '🌲'.repeat(5) + 'ab1');
  fireEvent.blur(password);
  await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
  expect(submit).not.toHaveBeenCalled();

  fill('密码', '🌲'.repeat(5) + 'Ab1');
  fireEvent.click(button);
  await waitFor(() => expect(token).toHaveAttribute('aria-invalid', 'true'));
  expect(token).toHaveAccessibleDescription(/设置令牌无效/);
  expect(password).not.toHaveAttribute('aria-invalid', 'true');

  fill('设置令牌', 'updated-fixture-token');
  expect(token).not.toHaveAttribute('aria-invalid', 'true');
  fireEvent.click(button);
  const link = await screen.findByRole('link', { name: '前往登录' });
  expect(link).toHaveAttribute('href', '/login');
  expect(screen.queryByRole('button', { name: '创建管理员' })).not.toBeInTheDocument();
  expect(submit).toHaveBeenCalledTimes(2);
});

it('读取失败时允许重试，已初始化实例直接给出登录入口', async () => {
  const readPolicy = vi
    .fn<() => Response>()
    .mockReturnValueOnce(Response.json({}, { status: 503 }))
    .mockReturnValueOnce(Response.json({ ...defaultPolicy, initialized: true }));
  renderSetup(readPolicy);

  const retry = await screen.findByRole('button', { name: '重试' });
  expect(screen.getByRole('alert')).toHaveTextContent('无法读取首次设置的密码要求');
  expect(screen.queryByLabelText('密码', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(retry);
  expect(await screen.findByRole('link', { name: '前往登录' })).toHaveAttribute('href', '/login');
  expect(screen.getByRole('status')).toHaveTextContent('系统已完成首次设置');
  expect(readPolicy).toHaveBeenCalledTimes(2);
});

it.each([
  ['invalid-password', '密码', '密码未通过服务端验证'],
  ['invalid-email', '邮箱', '请输入有效的邮箱地址。'],
  ['invalid-name', '姓名', '请输入 1–128 个字符的姓名。'],
])('将服务端 %s 错误关联到对应输入', async (reason, field, message) => {
  const submit = vi.fn(() =>
    Response.json({ error: { code: 'validation', reason } }, { status: 422 }),
  );
  renderSetup(() => Response.json(defaultPolicy), submit);
  await screen.findByLabelText('密码', { exact: true });
  fill('姓名', '测试管理员');
  fill('邮箱', 'fixture@example.test');
  fill('密码', '🌲'.repeat(15));
  fill('设置令牌', 'fixture-token');
  fireEvent.click(screen.getByRole('button', { name: '创建管理员' }));

  const input = screen.getByLabelText(field, { exact: true });
  await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
  expect(input).toHaveAccessibleDescription(expect.stringContaining(message));
});
