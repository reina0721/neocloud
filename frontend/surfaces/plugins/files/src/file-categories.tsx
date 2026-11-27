import { useFrontendTranslation } from '@neocloud/i18n';
import { MenuButton } from '@neocloud/ui-adapter/menu-button';

import { fileCategoryKeys } from './file-category-keys';

export function FileCategoryMenu({
  category = '',
  onSelect,
}: Readonly<{ category?: string; onSelect: (category: string) => void }>) {
  const { t } = useFrontendTranslation();
  return (
    <MenuButton
      triggerSize="sm"
      triggerVariant="standard"
      ariaLabel={t('files.workspace.categories')}
      label={t(category ? `files.${category}` : 'files.explorer.allTypes')}
      header={<p className="px-3 py-1 text-xs text-ink-muted">{t('files.explorer.typeScope')}</p>}
      items={[
        { id: 'all', label: t('files.explorer.allTypes'), selected: !category },
        ...fileCategoryKeys.map((key) => ({
          id: key,
          label: t(`files.${key}`),
          selected: key === category,
        })),
      ]}
      onAction={(id) => onSelect(id === 'all' ? '' : id)}
    />
  );
}
