import { useEffect, useState } from 'react';
import { ApiError, createJsonClient } from '../api/json-client';
import { readAuthConfig } from './config';
import type { SetupPasswordPolicy } from './setup-schema';

export async function readInstancePasswordPolicy(base: string, signal: AbortSignal) {
  const [value, { setupPolicySchema }] = await Promise.all([
    createJsonClient(base)('/auth/setup-policy', { signal }),
    import('./setup-schema'),
  ]);
  const parsed = setupPolicySchema.safeParse(value);
  if (!parsed.success) throw new ApiError('protocol');
  return parsed.data;
}

export function usePasswordPolicy(enabled: boolean) {
  const [policy, setPolicy] = useState<SetupPasswordPolicy>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => {
        const config = readAuthConfig();
        return config.mode === 'backend'
          ? readInstancePasswordPolicy(config.apiBaseUrl, controller.signal)
          : undefined;
      })
      .then((result) => {
        if (!controller.signal.aborted) setPolicy(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPolicy(undefined);
      });
    return () => controller.abort();
  }, [enabled]);
  return enabled ? policy : undefined;
}

export function passwordRuleMessage(policy: SetupPasswordPolicy) {
  return policy.requireComplexity ? 'auth.setupComplexPasswordRule' : 'auth.setupPasswordRule';
}
