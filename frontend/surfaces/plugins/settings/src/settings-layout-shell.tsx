'use client';

/**
 * settings —— 设置内页 Shell（SET-011：持久化布局壳）。
 *
 * - `SETTINGS_CATEGORIES`：单一映射表（shortId/routeId/模型 key/label/iconId/分组）。
 * - `SettingsShellContext`：layout 一次性装配的偏好 ctx 与失败横幅，下传各分类 page
 *   （page 只渲染分类区段，不重复订阅/装配——切换分类仅换右侧内容，壳不重挂载）。
 * - `SettingsSearch`：位于设置内容顶部，命中后聚焦相应分类字段。
 * - `useSettingsPersistReport`：统一持久化失败呈现（reportingPort + notSaved + 重试）。
 */
import { useState, type ReactNode } from 'react';

import { useFrontendTranslation } from '@clouddrive/i18n';
import { type PersistResult } from '@clouddrive/plugin-framework/preferences';
import { route, RouteLink } from '@clouddrive/plugin-framework/plugin';
import { PageHeader } from '@clouddrive/surface-foundation/layout';
import { Action } from '@clouddrive/ui-adapter/action';
import { SearchBox } from '@clouddrive/ui-adapter/search-box';

import type { Ctx } from './category-sections';
import { SettingsShellContext } from './settings-context';
import { SETTINGS_CATEGORIES, type SettingsCategoryMeta } from './settings-categories';
import { RestoreAllButton, RestoreCategoryButton } from './restore-defaults';
import { PreferencesTransferPanel } from './preferences-transfer-panel';
import { normalizeSearchTerm, searchSettings } from './settings-index';

/* ------------------------------------------------------------------ */
/* 偏好订阅 + 持久化失败统一呈现                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 壳 Context：layout 一次性装配，page 消费                                */
/* ------------------------------------------------------------------ */

export type SettingsShellValue = Ctx;

/** layout 安装壳 ctx 供分类 page 消费（page 内 useSettingsShell() 取用）。 */
export function SettingsShellProvider({
  ctx,
  children,
}: Readonly<{ ctx: Ctx; children: ReactNode }>) {
  return <SettingsShellContext.Provider value={ctx}>{children}</SettingsShellContext.Provider>;
}

/* ------------------------------------------------------------------ */
/* 跨目录搜索                                                            */
/* ------------------------------------------------------------------ */

/** 跨目录设置搜索，命中后定位对应字段。 */
export function SettingsSearch() {
  const { t } = useFrontendTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const resolveEntryText = (key: string) => {
    const resolved = t(key);
    return typeof resolved === 'string' ? resolved : key;
  };
  const searchResults = searchSettings(searchQuery, resolveEntryText);
  const searching = normalizeSearchTerm(searchQuery) !== '';

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <SearchBox
        label={t('settings.searchLabel')}
        placeholder={t('settings.searchPlaceholder')}
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      {searching ? (
        <Action variant="quiet" size="sm" onPress={() => setSearchQuery('')}>
          {t('settings.searchClear')}
        </Action>
      ) : null}
      {searching ? (
        <div className="grid gap-1">
          {searchResults.entries.length === 0 ? (
            <p className="px-1 text-xs leading-5 text-ink-muted">
              {t('settings.searchEmpty')} · {t('settings.searchNoResultsDescription')}
            </p>
          ) : (
            searchResults.entries.map((entry) => {
              const meta = SETTINGS_CATEGORIES.find((item) => item.categoryKey === entry.category);
              if (!meta) return null;
              return (
                <RouteLink
                  ariaLabel={t(entry.nameKey)}
                  className="flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-start text-sm outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus-ring"
                  key={`${entry.category}.${entry.fieldId}`}
                  target={route(
                    meta.targetRouteId,
                    {},
                    { fragment: `settings-${entry.category}-${entry.fieldId}` },
                  )}
                >
                  <span className="min-w-0 truncate font-medium text-ink">{t(entry.nameKey)}</span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {t(entry.categoryLabelKey)}
                  </span>
                </RouteLink>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 内容区 wrapper（分类区段 + 失败横幅）。 */
export function SettingsContentFrame({
  banner,
  children,
}: Readonly<{ banner?: ReactNode; children: ReactNode }>) {
  return (
    <div className="min-w-0 space-y-5 px-3 md:px-0">
      {banner}
      {children}
    </div>
  );
}

export function SettingsCategoryHeader({ meta }: Readonly<{ meta: SettingsCategoryMeta }>) {
  const { t } = useFrontendTranslation();
  return (
    <div className="min-w-0 flex-1">
      <PageHeader
        eyebrow={t('settings.eyebrow')}
        title={t(meta.labelKey)}
        description={t('settings.categoryDescription', {
          scope: t(`settings.categoryIntro.${meta.shortId}`),
        })}
      />
    </div>
  );
}

export function SettingsRestoreActions({
  meta,
  persist,
}: Readonly<{
  meta: SettingsCategoryMeta;
  persist: (apply: () => PersistResult) => PersistResult;
}>) {
  const { t } = useFrontendTranslation();
  return (
    <div className="grid gap-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <RestoreCategoryButton
          category={meta.categoryKey}
          categoryLabel={t(meta.labelKey)}
          persist={persist}
        />
        <RestoreAllButton persist={persist} />
      </div>
      {/* 配置输出/导入：分类页脚常驻，保存与恢复之外提供可携带的配置。 */}
      <PreferencesTransferPanel persist={persist} />
    </div>
  );
}
