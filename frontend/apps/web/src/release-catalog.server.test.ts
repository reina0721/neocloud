import { describe, expect, it, vi } from 'vitest';
import { latestReleaseCatalog, releaseCatalogPath } from './release-catalog.server';

const goOrigin = 'http://127.0.0.1:8080';
const githubApi = 'https://api.github.com/repos/reina0721/neocloud/releases/latest';
const githubRelease = 'https://github.com/reina0721/neocloud/releases';
const allowed = () => Response.json({ configuration: [], capabilities: [] });
const published = {
  tag_name: 'v0.2.2',
  published_at: '2026-11-18T18:54:00Z',
  body: 'Release notes',
  draft: false,
  prerelease: false,
  assets: [],
};

function openCatalog(
  request: typeof fetch,
  options: { method?: string; headers?: Headers; signal?: AbortSignal } = {},
) {
  const { method = 'GET', headers, signal = new AbortController().signal } = options;
  return latestReleaseCatalog(
    method,
    new URL(`${releaseCatalogPath}?repository=untrusted`, goOrigin),
    headers ?? new Headers({ Cookie: 'session=active' }),
    signal,
    request,
  );
}

describe('只读系统发布查询', () => {
  it('向固定 Go 地址验证会话，随后向固定仓库查询并生成安全附件地址', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(allowed())
      .mockResolvedValueOnce(
        Response.json({
          ...published,
          html_url: 'https://untrusted.invalid/release',
          assets: [
            {
              name: 'clouddrive_0.2.2_windows_amd64.zip',
              size: 20,
              state: 'uploaded',
              browser_download_url: 'https://untrusted.invalid/asset',
            },
            { name: 'checksums+extra.txt', size: 24, state: 'uploaded' },
            { name: '../secret', size: 12, state: 'uploaded' },
            { name: 'incomplete.zip', size: 5, state: 'starter' },
          ],
        }),
      );
    const response = await openCatalog(request, {
      headers: new Headers({
        Cookie: 'session=active',
        Authorization: 'Bearer app-credential',
        Origin: 'https://cloud.example',
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      version: 'v0.2.2',
      publishedAt: published.published_at,
      notes: published.body,
      releaseUrl: `${githubRelease}/tag/v0.2.2`,
      assets: [
        {
          name: 'clouddrive_0.2.2_windows_amd64.zip',
          sizeBytes: 20,
          downloadUrl: `${githubRelease}/download/v0.2.2/clouddrive_0.2.2_windows_amd64.zip`,
          kind: 'windows-backend',
        },
        {
          name: 'checksums+extra.txt',
          sizeBytes: 24,
          downloadUrl: `${githubRelease}/download/v0.2.2/checksums%2Bextra.txt`,
          kind: 'other',
        },
      ],
    });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, options] of request.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(request.mock.calls[0]?.[0]).toEqual(new URL('/api/console/v1/system/runtime', goOrigin));
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: 'application/json',
      Cookie: 'session=active',
    });
    expect(request.mock.calls[1]?.[0]).toBe(githubApi);
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('cookie')).toBeNull();
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('authorization')).toBeNull();
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('origin')).toBeNull();
  });

  it('缺少会话或方法不匹配时不访问上游', async () => {
    const request = vi.fn<typeof fetch>();
    expect((await openCatalog(request, { headers: new Headers() })).status).toBe(401);
    const post = await openCatalog(request, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('Go 返回 %s 时终止在授权检查', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status }));
    const response = await openCatalog(request);
    expect(response.status).toBe(status === 503 ? 502 : status);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('Go 的 200 HTML 响应不能代替授权检查', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<p>Sign in</p>'));
    expect((await openCatalog(request)).status).toBe(502);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { upstream: 404, status: 404, error: 'no-release' },
    { upstream: 429, status: 429, error: 'rate-limited' },
    { upstream: 403, status: 429, error: 'rate-limited', rate: '0' },
    { upstream: 403, status: 502, error: 'upstream' },
    { upstream: 503, status: 502, error: 'upstream' },
  ])('区分 GitHub $upstream 与查询结果 $status', async ({ upstream, status, error, rate }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(allowed())
      .mockResolvedValueOnce(
        new Response(null, {
          status: upstream,
          ...(rate ? { headers: { 'X-RateLimit-Remaining': rate } } : {}),
        }),
      );
    const response = await openCatalog(request);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it('空附件是有效结果，拒绝预发布与超过响应体预算的结果', async () => {
    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(allowed())
      .mockResolvedValueOnce(Response.json({ ...published, body: null }));
    const response = await openCatalog(empty);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ notes: '', assets: [] });

    for (const release of [
      Response.json({ ...published, prerelease: true }),
      Response.json({ ...published, body: 'a'.repeat(1024 * 1024) }),
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(allowed())
        .mockResolvedValueOnce(release);
      expect((await openCatalog(request)).status).toBe(502);
    }
  });

  it('区分超时与调用方取消，取消授权后不访问 GitHub', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(AbortSignal.abort(new DOMException('Budget exceeded', 'TimeoutError')));
    const stalled = vi.fn<typeof fetch>().mockImplementation((_target, options) => {
      options?.signal?.throwIfAborted();
      return Promise.resolve(allowed());
    });
    try {
      expect((await openCatalog(stalled)).status).toBe(504);
      expect(stalled).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }

    const client = new AbortController();
    const cancelled = vi.fn<typeof fetch>().mockImplementation(() => {
      client.abort();
      return Promise.resolve(allowed());
    });
    await expect(openCatalog(cancelled, { signal: client.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
