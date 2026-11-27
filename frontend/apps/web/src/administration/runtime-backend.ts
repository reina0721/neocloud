import type { z } from 'zod';
import {
  RuntimeReadError,
  nativeUpdateJobSchema,
  nativeUpdateStatusSchema,
  releaseCatalogSchema,
  runtimeBuildSchema,
  runtimeDiagnosticsSchema,
  runtimeMetadataSchema,
  runtimeMetricsSchema,
  runtimeProbeSchema,
  type RuntimePort,
} from '@clouddrive/surface/administration';
import { ApiError, createJsonClient } from '../api/json-client';

export async function readRuntimeInformation<T>(
  operation: () => Promise<T>,
  currentUserId?: () => string | null,
  signal?: AbortSignal,
): Promise<T> {
  const owner = currentUserId?.();
  if (currentUserId && !owner) throw new RuntimeReadError('unauthenticated');
  signal?.throwIfAborted();
  try {
    const value = await operation();
    signal?.throwIfAborted();
    if (currentUserId && owner !== currentUserId()) throw new RuntimeReadError('unauthenticated');
    return value;
  } catch (error) {
    if (currentUserId && owner !== currentUserId()) throw new RuntimeReadError('unauthenticated');
    signal?.throwIfAborted();
    if (error instanceof ApiError) {
      const code =
        error.code === 'http'
          ? error.status === 401
            ? 'unauthenticated'
            : error.status === 403
              ? 'forbidden'
              : 'unavailable'
          : error.code;
      throw new RuntimeReadError(code);
    }
    throw error;
  }
}

export function createRuntimePort(
  metadata: (signal?: AbortSignal) => Promise<unknown>,
  currentUserId?: () => string | null,
  request: typeof fetch = fetch,
): RuntimePort {
  const transport = createJsonClient('/management', request);
  const releaseTransport = createJsonClient('/api/host/v1/releases', request);
  const consoleTransport = createJsonClient('/api/console/v1', request);
  const nativeUpdatePath = '/deployment/native-update';
  const owned = <T>(operation: () => Promise<T>, signal?: AbortSignal) =>
    readRuntimeInformation(operation, currentUserId, signal);
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError('protocol');
    return result.data;
  }
  const blob = async (path: string, signal?: AbortSignal) => {
    const value = await transport(path, {
      responseType: 'blob',
      maxBlobBytes: 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (!(value instanceof Blob)) throw new ApiError('protocol');
    return value.text();
  };
  const json = async <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) => {
    const body = await blob(path, signal);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new ApiError('protocol');
    }
    return parse(schema, value);
  };
  return {
    nativeUpdate: (signal) =>
      owned(async () => {
        try {
          return {
            kind: 'available',
            status: parse(
              nativeUpdateStatusSchema,
              await consoleTransport(nativeUpdatePath, signal ? { signal } : {}),
            ),
          } as const;
        } catch (error) {
          if (error instanceof ApiError && error.code === 'http') {
            if (error.status === 404) return { kind: 'unavailable' } as const;
            if (error.status === 403) return { kind: 'owner-required' } as const;
          }
          throw error;
        }
      }, signal),
    startNativeUpdate: (action) =>
      owned(async () =>
        parse(
          nativeUpdateJobSchema,
          await consoleTransport(nativeUpdatePath + '/jobs', {
            method: 'POST',
            body: { action },
          }),
        ),
      ),
    cancelNativeUpdate: () =>
      owned(async () => {
        await consoleTransport(nativeUpdatePath + '/cancel', { method: 'POST' });
      }),
    maintenanceAccess: (signal) =>
      owned(async () => {
        const options = { cache: 'no-store' as const, ...(signal ? { signal } : {}) };
        const gateway = await request('/maintenance', { ...options, method: 'HEAD' });
        if (
          gateway.status === 404 ||
          (gateway.ok && gateway.headers.get('X-CloudDrive-Maintenance') !== '1')
        ) {
          return 'gateway-unavailable';
        }
        if (!gateway.ok) throw new ApiError('http', gateway.status);
        const owner = await request('/api/console/v1/deployment/owner', options);
        if (owner.status === 403) return 'owner-required';
        if (!owner.ok) throw new ApiError('http', owner.status);
        return 'owner-verified';
      }, signal),
    probe: (kind, signal) =>
      owned(async () => {
        try {
          const result = await json(
            kind === 'readiness' ? '/readyz' : '/livez',
            runtimeProbeSchema,
            signal,
          );
          if (result.status !== 'pass') throw new ApiError('protocol');
          return result;
        } catch (error) {
          if (error instanceof ApiError && error.code === 'http' && error.status === 503) {
            const result = runtimeProbeSchema.safeParse(error.payload);
            if (result.success && result.data.status === 'fail') return result.data;
            throw new ApiError('protocol');
          }
          throw error;
        }
      }, signal),
    build: (signal) => owned(() => json('/build', runtimeBuildSchema, signal), signal),
    latestRelease: (signal) =>
      owned(async () => {
        try {
          return parse(
            releaseCatalogSchema,
            await releaseTransport('/latest', signal ? { signal } : {}),
          );
        } catch (error) {
          if (error instanceof ApiError && error.code === 'http') {
            if (error.status === 429) throw new RuntimeReadError('rate-limited');
            if (error.status === 404) throw new RuntimeReadError('no-release');
            if (error.status === 504) throw new RuntimeReadError('timeout');
          }
          throw error;
        }
      }, signal),
    metadata: (signal) =>
      owned(async () => parse(runtimeMetadataSchema, await metadata(signal)), signal),
    diagnostics: (signal) =>
      owned(() => json('/diagnostics', runtimeDiagnosticsSchema, signal), signal),
    metrics: (signal) =>
      owned(() => json('/metrics-summary', runtimeMetricsSchema, signal), signal),
    metricsText: (signal) => owned(() => blob('/metrics', signal), signal),
  };
}
