'use client';
import { useIdentityQuery } from './use-query';
/** Current authorization projection. A refresh can retain the last result for the same account. */
export function useProductAccess({ retainDuringRefresh = false } = {}) {
  const result = useIdentityQuery('product.access', (port) => port.access());
  return { ...result, data: result.loading && !retainDuringRefresh ? null : result.data };
}
