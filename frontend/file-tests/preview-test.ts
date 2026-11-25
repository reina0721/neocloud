import {
  expect,
  test as playwright,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import { readPreviewAccess } from './reading-fixture';

const consolePath = '/api/console/v1';
const preferencesPath = consolePath + '/native/iam/self/preferences';
const baseline = { language: 'zh-CN', themeMode: 'system' };
type PreviewPreferences = Partial<typeof baseline> & { version?: number };

function hasBaseline(value: PreviewPreferences): boolean {
  return value.language === baseline.language && value.themeMode === baseline.themeMode;
}

function cookies(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .map(({ value }) => value.split(';', 1)[0]!);
}

async function csrf(request: APIRequestContext) {
  const response = await request.get(consolePath + '/auth/csrf');
  if (!response.ok()) throw new Error('Preview fixture CSRF HTTP ' + response.status());
  const result = (await response.json()) as { token?: string };
  if (!result.token) throw new Error('Preview fixture did not return a CSRF token.');
  return { token: result.token, cookies: cookies(response) };
}

export const test = playwright.extend<{ previewLocale: void }>({
  previewLocale: [
    async ({ playwright, baseURL }, use) => {
      const access = readPreviewAccess();
      if (baseURL !== access.origin) throw new Error('Unexpected files preview base URL.');

      // 浏览器的 locale 仅影响浏览器提示。账号语言由服务端保存，
      // 因此串行夹具必须在下一条用例登录前核对并恢复中文。
      const request = await playwright.request.newContext({
        baseURL: access.origin,
        extraHTTPHeaders: { Origin: access.origin },
      });
      let authenticated: Record<string, string> | undefined;
      const errors: unknown[] = [];
      try {
        const session = await csrf(request);
        const signed = { Cookie: session.cookies.join('; '), 'X-CSRF-Token': session.token };
        const signIn = await request.post(consolePath + '/auth/login', {
          headers: signed,
          data: { email: access.username, password: access.password },
          maxRedirects: 0,
        });
        if (!signIn.ok()) throw new Error('Preview fixture login HTTP ' + signIn.status());
        signed.Cookie = [...session.cookies, ...cookies(signIn)].join('; ');
        authenticated = signed;
        const response = await request.get(preferencesPath, { headers: signed });
        if (response.ok()) {
          const current = (await response.json()) as PreviewPreferences;
          if (!hasBaseline(current)) {
            const saved = await request.patch(preferencesPath, {
              headers: signed,
              data: { version: current.version, ...baseline },
            });
            if (!saved.ok()) throw new Error('Preview fixture preference HTTP ' + saved.status());
            const persisted = await request.get(preferencesPath, { headers: signed });
            const actual = persisted.ok() ? ((await persisted.json()) as PreviewPreferences) : {};
            if (!hasBaseline(actual))
              throw new Error('Preview fixture preferences were not persisted.');
          }
        } else if (response.status() !== 403) {
          throw new Error('Preview fixture preference HTTP ' + response.status());
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        if (authenticated) {
          const logout = await request.post(consolePath + '/auth/logout', {
            headers: authenticated,
            data: { logout: true },
          });
          if (!logout.ok()) throw new Error('Preview fixture logout HTTP ' + logout.status());
        }
      } catch (error) {
        errors.push(error);
      }
      await request.dispose().catch((error: unknown) => {
        errors.push(error);
      });
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, 'Preview fixture setup or cleanup failed');
      await use();
    },
    { auto: true },
  ],
});

export { expect };
export type { Locator, Page, Route } from '@playwright/test';
