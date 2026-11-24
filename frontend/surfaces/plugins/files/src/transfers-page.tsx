'use client';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Page, PageHeader } from '@clouddrive/surface-foundation/layout';
import { TransferPanel } from './transfer-panel';

export function TransfersPage() {
  const { t } = useFrontendTranslation();
  return (
    <Page>
      <PageHeader title={t('files.transferCenter')} description={t('files.transferResumeHint')} />
      <TransferPanel />
    </Page>
  );
}
