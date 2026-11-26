import { z } from 'zod';
import { runtimeMetadataSchema } from '@clouddrive/surface/administration';
import { readBoundedBlob } from './api/blob-body';

export const releaseCatalogPath = '/api/host/v1/releases/latest';

const repository = 'reina0721/neocloud';
const releaseOrigin = `https://github.com/${repository}/releases`;
const latestReleaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const responseHeaders = { 'Cache-Control': 'no-store' };
const requestBudgetMs = 10_000;
const latestReleaseSchema = z.object({
  tag_name: z.string().regex(/^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/),
  published_at: z.iso.datetime(),
  body: z.string().nullable(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(z.object({ name: z.string(), size: z.int().nonnegative(), state: z.string() })),
});
const safeAssetName = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,199}$/;

function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers: responseHeaders });
}

async function readJSON(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const body = await readBoundedBlob(response, maxBytes, signal);
  return JSON.parse(await body.text()) as unknown;
}

/** The Web Host reads public release metadata after Go authorizes the current console session. */
export async function latestReleaseCatalog(
  method: string,
  destination: URL,
  requestHeaders: Headers,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  if (method !== 'GET')
    return new Response(null, { status: 405, headers: { ...responseHeaders, Allow: 'GET' } });

  signal.throwIfAborted();
  const cookie = requestHeaders.get('cookie');
  if (!cookie) return failure(401, 'unauthenticated');
  const timeout = AbortSignal.timeout(requestBudgetMs);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const options = {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: requestSignal,
  } as const;

  try {
    const authorization = await request(new URL('/api/console/v1/system/runtime', destination), {
      ...options,
      headers: { Accept: 'application/json', Cookie: cookie },
    });
    if (authorization.status !== 200) {
      await authorization.body?.cancel().catch(() => undefined);
      if (authorization.status === 401) return failure(401, 'unauthenticated');
      if (authorization.status === 403) return failure(403, 'forbidden');
      return failure(502, 'upstream');
    }
    runtimeMetadataSchema.parse(await readJSON(authorization, 64 * 1024, requestSignal));
    requestSignal.throwIfAborted();

    const response = await request(latestReleaseApi, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CloudDrive-Release-Catalog',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) return failure(404, 'no-release');
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('X-RateLimit-Remaining') === '0' ||
            response.headers.has('Retry-After')))
      )
        return failure(429, 'rate-limited');
      return failure(502, 'upstream');
    }
    const release = latestReleaseSchema.parse(await readJSON(response, 1024 * 1024, requestSignal));
    requestSignal.throwIfAborted();
    const version = release.tag_name;
    const tag = encodeURIComponent(version);
    const windowsBackendNames = new Set(
      ['amd64', 'arm64'].map((arch) => `clouddrive_${version.slice(1)}_windows_${arch}.zip`),
    );
    const assets = release.assets
      .filter((asset) => asset.state === 'uploaded' && safeAssetName.test(asset.name))
      .map((asset) => ({
        name: asset.name,
        sizeBytes: asset.size,
        downloadUrl: `${releaseOrigin}/download/${tag}/${encodeURIComponent(asset.name)}`,
        kind: windowsBackendNames.has(asset.name) ? 'windows-backend' : 'other',
      }));
    return Response.json(
      {
        version,
        publishedAt: release.published_at,
        notes: release.body ?? '',
        releaseUrl: `${releaseOrigin}/tag/${tag}`,
        assets,
      },
      { headers: responseHeaders },
    );
  } catch {
    signal.throwIfAborted();
    return timeout.aborted ? failure(504, 'timeout') : failure(502, 'upstream');
  }
}
