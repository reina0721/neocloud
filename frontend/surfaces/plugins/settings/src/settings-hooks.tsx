'use client';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import {
  usePreferencesPort,
  type PersistResult,
  type PreferencesPort,
} from '@clouddrive/plugin-framework/preferences';
import type { Preferences } from '@clouddrive/surface/preferences-model';
import { AlertBanner } from '@clouddrive/ui-adapter/feedback';
import { TriangleAlert } from 'lucide-react';
import type { Ctx } from './category-sections';
export function useSettingsPersistReport(): {
  banner: ReactNode;
  persist: (apply: () => PersistResult) => PersistResult;
  ctxFor: (prefs: Preferences) => Ctx;
} {
  const { t } = useFrontendTranslation();
  const port = usePreferencesPort<Preferences>();
  const [retry, setRetry] = useState<(() => PersistResult) | null>(null);

  function persist(apply: () => PersistResult): PersistResult {
    const result = apply();
    setRetry(() => (result.ok ? null : apply));
    return result;
  }

  const reportingPort: PreferencesPort<Preferences> = {
    getSnapshot: port.getSnapshot.bind(port),
    subscribe: port.subscribe.bind(port),
    updateCategory: (category, patch) => persist(() => port.updateCategory(category, patch)),
    resetCategory: (category) => persist(() => port.resetCategory(category)),
    resetAll: () => persist(() => port.resetAll()),
  };

  const banner = retry ? (
    <AlertBanner
      actionLabel={t('settings.retry')}
      description={t('settings.notSavedDescription')}
      icon={<TriangleAlert className="size-4" aria-hidden="true" />}
      onAction={() => persist(retry)}
      title={t('settings.notSaved')}
      tone="warning"
    />
  ) : null;

  const ctxFor = (prefs: Preferences): Ctx => ({ port: reportingPort, prefs });
  return { banner, persist, ctxFor };
}

/** 响应式 prefs 订阅（layout 单实例，供 ctx 构造）。 */
export function useSettingsPreferences(): Preferences {
  const port = usePreferencesPort<Preferences>();
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot);
}
