'use client';
import { Page, PageHeader, Section } from '@clouddrive/surface-foundation/layout';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { useIdentityPort, IdentityError } from '@clouddrive/surface/identity/runtime';
import { DescriptionList } from '@clouddrive/ui-adapter/description-list';
import { Action } from '@clouddrive/ui-adapter/action';
import { route, RouteLink } from '@clouddrive/plugin-framework/plugin';
import { useIdentityQuery } from '../../../src/identity/use-query';
import {
  IdentityQueryState,
  IdentityModeNotice,
  IdentityMutationError,
} from '../../../src/identity/query-state';
import { UserForm } from '../../../src/identity/user-form';
import { AccountSecurity } from './account-security';
import { BackendProfile } from './backend-profile';
export function AccountPage() {
  const { t } = useFrontendTranslation();
  const port = useIdentityPort();
  const query = useIdentityQuery('account', async (service) => {
    const [access, user] = await Promise.all([service.access(), service.me()]);
    if (access.user.id !== user.id || user.id !== service.currentUserId())
      throw new IdentityError('protocol');
    return { access, user };
  });
  const roles = useIdentityQuery('account.roles', (service) => service.roles(true));
  const data = query.data;
  const nativePermissions = data?.access.nativePermissions;
  const roleLabel = (id: string) =>
    ['administrator', 'operator', 'viewer'].includes(id)
      ? t(`identityProduct.roleNames.${id}`)
      : (roles.data?.find((role) => role.id === id)?.name ?? id);
  return (
    <Page density="compact">
      <PageHeader
        density="compact"
        title={t('account.title')}
        description={t('account.description')}
      />
      <IdentityModeNotice mode={port.mode} />
      {query.error || !data ? (
        <IdentityQueryState error={query.error} retry={query.reload} />
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-panel bg-surface">
          <Section
            appearance="embedded"
            density="compact"
            title={t('account.profile')}
            contentInset
          >
            <div className="grid gap-4">
              <UserForm
                key={data.user.id}
                mode="profile"
                presentation="embedded"
                saveLabel={t('account.saveProfile')}
                user={data.user}
                roles={roles.data ?? []}
                access={data.access}
                onSaved={query.reload}
              />
              <div className="grid gap-3 border-t border-border pt-4">
                <p className="text-sm text-ink-muted">{t('account.roleDescription')}</p>
                {roles.loading ? <p role="status">{t('identityProduct.loading')}</p> : null}
                {roles.error ? (
                  <div className="space-y-2">
                    <IdentityMutationError error={roles.error} />
                    <Action variant="secondary" onPress={roles.reload}>
                      {t('identityProduct.retry')}
                    </Action>
                  </div>
                ) : null}
                <DescriptionList
                  label={t('account.details')}
                  columns={2}
                  items={[
                    { id: 'id', term: t('account.id'), description: data.user.id },
                    {
                      id: 'status',
                      term: t('identityProduct.status'),
                      description: t(`identityProduct.${data.user.status}`),
                    },
                    {
                      id: 'roles',
                      term: t('identityProduct.roles'),
                      description: data.user.roleIds.map(roleLabel).join(' / '),
                    },
                  ]}
                />
              </div>
            </div>
          </Section>
          {port.mode === 'backend' ? (
            <>
              {nativePermissions?.includes('iam:account:self:read') ? (
                <BackendProfile
                  editable={nativePermissions.includes('iam:account:self:profile:write')}
                  onSaved={query.reload}
                />
              ) : null}
              <Section
                appearance="embedded"
                density="compact"
                title={t('administration.preferences')}
                contentInset
              >
                <RouteLink target={route('settings')} presentation="action" variant="secondary">
                  {t('administration.openAppearanceSettings')}
                </RouteLink>
              </Section>
            </>
          ) : null}
          <AccountSecurity
            canChangePassword={
              port.mode === 'mock' ||
              nativePermissions?.includes('iam:account:self:password:write') === true
            }
          />
        </div>
      )}
    </Page>
  );
}
