import { NextResponse, type NextRequest } from 'next/server';
import { backendDestination, backendRequestHeaders } from './backend-proxy';
import { webPreviewReadiness, webPreviewReadinessApplication } from './web-preview-readiness';

// Keep transport, streaming and cookies in Next's proxy; Go owns authorization.
// Read the upstream at runtime so the same artifact can move between deployments.
export function proxy(request: NextRequest) {
  const destination = backendDestination(request.url);
  let headers: Headers;
  try {
    headers = backendRequestHeaders(request.url, request.headers, destination);
  } catch {
    return NextResponse.json({ error: 'Invalid request origin or authority.' }, { status: 403 });
  }
  const application = webPreviewReadinessApplication(new URL(request.url).pathname);
  if (application && request.method === 'GET')
    return webPreviewReadiness(application, destination, headers, request.signal);
  return NextResponse.rewrite(destination, { request: { headers } });
}

export const config = {
  matcher: ['/api/:path*', '/wopi/:path*', '/management/:path*', '/dav/:path*'],
};
