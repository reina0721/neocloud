'use client';

import { useFrontendTranslation } from '@neocloud/i18n';
import { usePreferencesPort, type PersistResult } from '@neocloud/plugin-framework/preferences';
import type { Preferences } from '@neocloud/surface/preferences-model';
import { ConfirmDialog } from '@neocloud/ui-adapter/overlays';

/**
 * 恢复默认（双层）：
 * - `RestoreAllButton`：恢复全部九分类（ConfirmDialog 二次确认，列影响范围）；
 * - `RestoreCategoryButton`：恢复单分类（ConfirmDialog，只影响该分类）。
 * 只恢复偏好；不触碰账号/业务数据、收藏、最近、通知、草稿与已保存筛选方案
 * （resetCategory/resetAll 由 Host Port 保证只写偏好 store）。
 * 恢复动作由设置壳执行与登记，失败后可重试同一动作。
 */
type Props = {
  persist: (apply: () => PersistResult) => PersistResult;
};

export function RestoreAllButton({ persist }: Props) {
  const { t } = useFrontendTranslation();
  const port = usePreferencesPort<Preferences>();
  return (
    <ConfirmDialog
      cancelLabel={t('settings.cancel')}
      confirmLabel={t('settings.confirmRestore')}
      description={t('settings.restoreAllDescription')}
      failureMessage={t('settings.notSaved')}
      impact={t('settings.restoreImpact')}
      title={t('settings.restoreAllTitle')}
      triggerLabel={t('settings.restoreAll')}
      onConfirm={() => {
        persist(() => port.resetAll());
      }}
    />
  );
}

export function RestoreCategoryButton({
  category,
  categoryLabel,
  persist,
}: Props & { category: keyof Preferences; categoryLabel: string }) {
  const { t } = useFrontendTranslation();
  const port = usePreferencesPort<Preferences>();
  return (
    <ConfirmDialog
      cancelLabel={t('settings.cancel')}
      confirmLabel={t('settings.confirmRestore')}
      description={t('settings.restoreCategoryDescription')}
      failureMessage={t('settings.notSaved')}
      impact={categoryLabel}
      title={t('settings.restoreCategoryTitle', { category: categoryLabel })}
      triggerLabel={t('settings.restoreCategory')}
      onConfirm={() => {
        persist(() => port.resetCategory(category));
      }}
    />
  );
}
