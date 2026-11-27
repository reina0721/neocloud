'use client';

/**
 * settings —— 内页 Shell（SET-011 持久布局壳 + SET-012 复用主 Shell 路由内容动效）。
 *
 * Next App Router layout：跨 /settings 子路由 client 导航**不重挂载**——壳
 * （PageHeader、跨分类搜索、失败横幅、偏好订阅）
 * 只在壳层装配一次；分类切换仅替换右侧 {children}。
 *
 * 内容动效（SET-012）：壳/内容显式分层——右侧内容容器标 `data-route-content`，
 * surface-foundation route-enter 编排对它（与主 Shell `.surface-page-stack` 并列）
 * 施加同一进入动效（fade+rise + 区段错峰 + forward 方向 + reduced/motion 降级），
 * 由 Host RouteTransition 同一门控触发；壳不在 `data-route-content` 内 → 不命中、
 * 静止持久。settings 不自建路由状态机或第二套 Motion。
 *
 * PersonalShell 持有侧栏导航，SettingsContentFrame 负责分类内容。
 */
import { usePathname } from 'next/navigation';
import { Page } from '@neocloud/surface-foundation/layout';
import { useAccountNotificationSettings } from '@neocloud/surface/administration/runtime';
import { useFrontendTranslation } from '@neocloud/i18n';
import type { ReactNode } from 'react';

import {
  SettingsCategoryHeader,
  SettingsContentFrame,
  SettingsSearch,
  SettingsShellProvider,
  SettingsRestoreActions,
} from '../src/settings-layout-shell';
import {
  appearanceMeta,
  SETTINGS_CATEGORIES,
  type SettingsCategoryMeta,
} from '../src/settings-categories';
import { useSettingsPersistReport, useSettingsPreferences } from '../src/settings-hooks';

/** 由当前 pathname 解析活动分类（/settings → appearance；/settings/<shortId> → 对应）。 */
function resolveActiveMeta(pathname: string): SettingsCategoryMeta {
  const segment = pathname.replace(/^\/settings\/?/, '');
  if (segment === '') return appearanceMeta;
  const match = SETTINGS_CATEGORIES.find((meta) => meta.shortId === segment);
  return match ?? appearanceMeta;
}

export default function SettingsShellLayout({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const activeMeta = resolveActiveMeta(pathname);
  const preferences = useSettingsPreferences();
  const { banner, persist, ctxFor } = useSettingsPersistReport();
  const account = useAccountNotificationSettings();
  const { t } = useFrontendTranslation();
  const ctx = {
    ...ctxFor(preferences),
    accountPreferencesBlocked:
      account?.sharedReadOnly === true || account?.sharedUnavailable === true,
  };

  return (
    <Page density="compact">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <SettingsCategoryHeader meta={activeMeta} />
        <div className="w-full shrink-0 sm:w-64">
          <SettingsSearch />
        </div>
      </div>
      <SettingsContentFrame banner={banner}>
        {account?.sharedReadOnly ? (
          <p className="text-sm text-ink-muted">{t('administration.preferencesReadOnly')}</p>
        ) : null}
        {account?.pending ? (
          <p className="text-sm text-ink-muted" role="status">
            {t('administration.preferencesPending')}
          </p>
        ) : null}
        <div data-route-content>
          <Page density="compact">
            <div className="divide-y divide-border overflow-hidden rounded-panel bg-surface">
              <SettingsShellProvider ctx={ctx}>{children}</SettingsShellProvider>
            </div>
          </Page>
        </div>
        <SettingsRestoreActions meta={activeMeta} persist={persist} />
      </SettingsContentFrame>
    </Page>
  );
}
