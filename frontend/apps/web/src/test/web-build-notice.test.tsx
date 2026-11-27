// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TextField } from '@neocloud/ui-adapter/form-field';

vi.mock('@neocloud/i18n', () => ({
  useFrontendTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('新部署只提示刷新，关闭本次提醒后还可发现新部署', async () => {
  const loaded = 'a'.repeat(40);
  let buildId = loaded;
  vi.stubEnv('NEXT_PUBLIC_NEOCLOUD_WEB_BUILD_ID', loaded);
  const fetcher = vi.fn(() => Promise.resolve(Response.json({ buildId })));
  vi.stubGlobal('fetch', fetcher);
  const { WebBuildNotice } = await import('../host/web-build-notice');
  await act(() => {
    render(
      <>
        <TextField label="draft" defaultValue="unfinished" />
        <WebBuildNotice />
      </>,
    );
    return Promise.resolve();
  });
  expect(fetcher).toHaveBeenCalledWith(
    '/api/host/v1/web-build',
    expect.objectContaining({ cache: 'no-store' }),
  );
  expect(screen.queryByRole('button', { name: 'common.reload' })).toBeNull();

  buildId = 'b'.repeat(40);
  fireEvent.focus(window);
  await screen.findByRole('button', { name: 'common.reload' });
  expect(screen.getByRole('textbox', { name: 'draft' })).toHaveValue('unfinished');
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'common.reload' })).toBeNull());

  buildId = 'c'.repeat(40);
  fireEvent.focus(window);
  await screen.findByRole('button', { name: 'common.reload' });
  expect(screen.getByRole('textbox', { name: 'draft' })).toHaveValue('unfinished');
});
