'use client';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Page, PageHeader } from '@clouddrive/surface-foundation/layout';
import { DataTable } from '@clouddrive/ui-adapter/data-display';
import { route, RouteLink } from '@clouddrive/plugin-framework/plugin';
import { IdentityError } from '@clouddrive/surface/identity/runtime';
import { useRequiredAdministration } from '../../../src/administration/context';
import { useIdentityQuery } from '../../../src/identity/use-query';
import { IdentityQueryState } from '../../../src/identity/query-state';

export function PermissionCatalogPage() {
  const port = useRequiredAdministration();
  const { t } = useFrontendTranslation();
  const result = useIdentityQuery('roles.catalog', async (identity) => {
    const access = await identity.access();
    if (!access.nativePermissions?.includes('iam:permission:read'))
      throw new IdentityError('forbidden');
    return {
      permissions: await port.permissions(),
      canReadRoles: access.permissions.includes('roles.read'),
    };
  });

  return (
    <Page>
      <PageHeader
        title={t('roles.permissionCatalog')}
        description={t('roles.permissionCatalogDescription')}
        actions={
          result.data?.canReadRoles ? (
            <RouteLink target={route('roles')}>{t('roles.back')}</RouteLink>
          ) : null
        }
      />
      {result.error || !result.data ? (
        <IdentityQueryState error={result.error} retry={result.reload} />
      ) : (
        <DataTable
          label={t('roles.permissionCatalog')}
          columns={[
            { id: 'key', label: t('administration.id'), rowHeader: true, render: (row) => row.key },
            { id: 'owner', label: t('administration.owner'), render: (row) => row.ownerModuleId },
            { id: 'risk', label: t('administration.risk'), render: (row) => row.risk },
          ]}
          rows={result.data.permissions.map((item) => ({ ...item, id: item.key }))}
          emptyContent={t('administration.empty')}
        />
      )}
    </Page>
  );
}
