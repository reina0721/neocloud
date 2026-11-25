export function configuredHttpOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be an HTTP(S) origin.`);
  return url;
}

/** The upstream is server configuration; request paths must never choose its host. */
export function backendDestination(
  requestUrl,
  backend = process.env.CLOUDDRIVE_BACKEND_URL ?? 'http://127.0.0.1:8080',
) {
  const destination = configuredHttpOrigin(backend, 'CLOUDDRIVE_BACKEND_URL');
  const incoming = new URL(requestUrl);
  destination.pathname = incoming.pathname;
  destination.search = incoming.search;
  return destination;
}

export function isBackendOriginAllowed(
  origin,
  allowedOrigins = process.env.CLOUDDRIVE_ALLOWED_ORIGINS ?? '[]',
) {
  const allowed = JSON.parse(allowedOrigins);
  if (!Array.isArray(allowed) || !allowed.every((value) => typeof value === 'string'))
    throw new Error('CLOUDDRIVE_ALLOWED_ORIGINS must be an array of origins.');
  return allowed.includes(origin);
}

/** Web Host owns the browser-facing authority; Go still owns authentication and CSRF. */
export function backendRequestHeaders(requestUrl, incoming, destination, allowedOrigins) {
  const headers = new Headers(incoming);
  const host = incoming.get('host');
  if (!host || host.length > 320 || /[\s,@/\\?#]/.test(host))
    throw new Error('Invalid request authority.');
  const originValue = incoming.get('origin');
  const request = new URL(requestUrl);
  let external = new URL(`${request.protocol}//${host}`);
  if (!['http:', 'https:'].includes(external.protocol))
    throw new Error('Invalid request authority.');
  if (originValue) {
    const origin = new URL(originValue);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== originValue)
      throw new Error('Invalid request origin.');
    const sameAuthority = new URL(`${origin.protocol}//${host}`).origin === origin.origin;
    if (sameAuthority) {
      external = origin;
      headers.set('origin', destination.origin);
    } else if (!request.pathname.startsWith('/wopi/')) {
      if (!isBackendOriginAllowed(originValue, allowedOrigins))
        throw new Error('Cross-origin request rejected.');
    }
    // Cross-origin WOPI requests retain their protocol-specific token authorization.
  }
  // Forwarded headers never choose an upstream, a cookie policy, or an authorization origin.
  for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port'])
    headers.delete(name);
  // Presentation metadata only: the backend uses this for displayed connection URLs, never auth.
  headers.set('x-clouddrive-web-origin', external.origin);
  const davDestination = incoming.get('destination');
  if ((request.pathname === '/dav' || request.pathname.startsWith('/dav/')) && davDestination) {
    const target = new URL(davDestination, external);
    if (target.origin === external.origin && !target.username && !target.password) {
      target.protocol = destination.protocol;
      target.host = destination.host;
      headers.set('destination', target.href);
    }
  }
  return headers;
}
