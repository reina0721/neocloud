'use client';

import { useFrontendTranslation } from '@clouddrive/i18n';
import { DisclosurePanel } from '@clouddrive/ui-adapter/disclosure';

export function LoginHelp() {
  const { t } = useFrontendTranslation();

  return (
    <DisclosurePanel title={t('auth.loginHelp.title')}>
      <div className="space-y-2">
        <p>{t('auth.loginHelp.account')}</p>
        <p>{t('auth.loginHelp.owner', { command: 'clouddrive iam recover-owner' })}</p>
      </div>
    </DisclosurePanel>
  );
}
