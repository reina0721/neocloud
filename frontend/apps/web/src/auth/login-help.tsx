'use client';

import { useFrontendTranslation } from '@neocloud/i18n';
import { DisclosurePanel } from '@neocloud/ui-adapter/disclosure';

export function LoginHelp() {
  const { t } = useFrontendTranslation();

  return (
    <DisclosurePanel title={t('auth.loginHelp.title')}>
      <div className="space-y-2">
        <p>{t('auth.loginHelp.account')}</p>
        <p>{t('auth.loginHelp.owner', { command: 'neocloud iam recover-owner' })}</p>
      </div>
    </DisclosurePanel>
  );
}
