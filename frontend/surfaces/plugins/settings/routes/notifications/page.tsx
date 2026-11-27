'use client';

import { useSettingsShell } from '../../src/settings-context';
import { NotificationsSection } from '../../src/category-sections';
import { useAccountNotificationSettings } from '@neocloud/surface/administration/runtime';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Section } from '@neocloud/surface-foundation/layout';
import { SwitchField } from '@neocloud/ui-adapter/form-field';

/**
 * 分类区段页（/settings 内页 Shell 的右侧内容）。侧边栏/搜索/PageHeader 由
 * routes/layout.tsx 持久化壳提供——本页只渲染分类区段，切换分类不重挂载壳。
 */
export default function SettingsPageContent() {
  const ctx = useSettingsShell();
  const account = useAccountNotificationSettings();
  const { t } = useFrontendTranslation();
  const values = account?.values;
  return (
    <>
      <NotificationsSection ctx={ctx} />
      {account && values ? (
        <Section
          title={t('administration.preferences')}
          description={t('administration.accountNotificationPreferencesHint')}
          appearance="outlined"
          contentInset
        >
          {(['emailDigest', 'showSummaries', 'dailySummary'] as const).map((field) => (
            <SwitchField
              key={field}
              label={t(`administration.${field}`)}
              description=""
              presentation="row"
              checked={values[field]}
              disabled={!account.editable}
              onCheckedChange={(value) => account.update(field, value)}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}
