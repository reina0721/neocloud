import { fileApplicationPolicySchema } from '@clouddrive/surface/files';
import { isBackendOriginAllowed } from './backend-proxy';

const readinessPath =
  /^\/api\/console\/v1\/native\/files\/applications\/([a-z0-9-]+)\/web-preview-readiness$/;

export function webPreviewReadinessApplication(path: string): string | undefined {
  return readinessPath.exec(path)?.[1];
}

/** 仅查询固定 Go 上游中当前会话有权读取的已生效策略。 */
export async function webPreviewReadiness(
  application: string,
  destination: URL,
  requestHeaders: Headers,
  signal: AbortSignal,
) {
  const headers = new Headers({ Accept: 'application/json' });
  const cookie = requestHeaders.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const responseHeaders = { 'Cache-Control': 'no-store' };
  const unavailable = () => Response.json({ status: 'unavailable' }, { headers: responseHeaders });
  try {
    const response = await fetch(
      new URL('/api/console/v1/native/files/applications/active', destination),
      {
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        return new Response(null, { status: response.status, headers: responseHeaders });
      return unavailable();
    }
    const policy = fileApplicationPolicySchema.parse(await response.json());
    const item = policy.webItems.find((item) => item.id === application && item.enabled);
    if (!item?.origin || item.protocol === 'wopi') return unavailable();
    return Response.json(
      { status: isBackendOriginAllowed(item.origin) ? 'allowed' : 'denied' },
      { headers: responseHeaders },
    );
  } catch {
    return unavailable();
  }
}
