import { NextResponse, type NextRequest } from 'next/server';
import { backendDestination, backendRequestHeaders } from './backend-proxy';
import { latestReleaseCatalog, releaseCatalogPath } from './release-catalog.server';
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
  if (destination.pathname === releaseCatalogPath)
    return latestReleaseCatalog(request.method, destination, headers, request.signal);
  const application = webPreviewReadinessApplication(destination.pathname);
  if (application && request.method === 'GET')
    return webPreviewReadiness(application, destination, headers, request.signal);
  return NextResponse.rewrite(destination, { request: { headers } });
}

export const config = {
  matcher: ['/api/:path*', '/wopi/:path*', '/management/:path*', '/dav/:path*'],
};
