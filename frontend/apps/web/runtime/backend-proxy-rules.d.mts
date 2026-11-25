export function configuredHttpOrigin(value: string, name: string): URL;

export function backendDestination(requestUrl: string, backend?: string): URL;

/** Returns membership in the allowlist and throws when its runtime configuration is invalid. */
export function isBackendOriginAllowed(origin: string, allowedOrigins?: string): boolean;

export function backendRequestHeaders(
  requestUrl: string,
  incoming: Headers,
  destination: URL,
  allowedOrigins?: string,
): Headers;
