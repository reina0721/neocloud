'use client';
import { useCallback, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Page, PageHeader } from '@clouddrive/surface-foundation/layout';
import { TextField, PasswordField, SelectField } from '@clouddrive/ui-adapter/form-field';
import { DialogSurface } from '@clouddrive/ui-adapter/overlays';
import { useIdentityPort, defaultUserQuery } from '@clouddrive/surface/identity/runtime';
import { useRequiredAdministration } from '../../../src/administration/context';
import { useRemote, RemoteRegion } from '../../../src/administration/resource-state';

function AccountAction({
  id,
  version,
  archive,
  onSaved,
}: Readonly<{ id: string; version: number; archive: boolean; onSaved: () => void }>) {
  const port = useRequiredAdministration();
  const { t } = useFrontendTranslation();
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string>();
  const label = t(archive ? 'administration.archive' : 'administration.resetPassword');
  return (
    <DialogSurface
      triggerLabel={label}
      title={label}
      description={t('administration.archiveWarning')}
      cancelLabel={t('administration.cancel')}
      confirmLabel={t('administration.confirm')}
      {...(failure ? { failureMessage: failure } : {})}
      onConfirm={async () => {
        try {
          if (archive) await port.archiveAccount(id, version);
          else await port.resetPassword(id, password, version);
          setPassword('');
          onSaved();
        } catch (error) {
          setFailure(t('administration.failureDescription'));
          throw error;
        }
      }}
    >
      {archive ? (
        <p>{t('administration.archiveWarning')}</p>
      ) : (
        <PasswordField
          label={t('administration.newPassword')}
          purpose="new"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          showLabel={t('account.showPassword')}
          hideLabel={t('account.hidePassword')}
        />
      )}
    </DialogSurface>
  );
}
export function AccountAdministrationPage() {
  const identity = useIdentityPort();
  const { t } = useFrontendTranslation();
  const [query, setQuery] = useState('');
  const [id, setId] = useState('');
  const state = useRemote(
    useCallback(
      () => identity.list({ ...defaultUserQuery, q: query, pageSize: 50 }),
      [identity, query],
    ),
  );
  return (
    <Page>
      <PageHeader
        title={t('administration.adminActions')}
        description={t('administration.description')}
      />
      <TextField
        label={t('identityProduct.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <RemoteRegion {...state}>
        <div className="space-y-4">
          <SelectField
            label={t('administration.accountId')}
            value={id}
            onValueChange={setId}
            options={[
              { value: '', label: t('administration.selectAccount') },
              ...(state.value?.items ?? []).map((user) => ({
                value: user.id,
                label: user.name + ' · ' + user.email,
              })),
            ]}
          />
          {state.value?.items.length ? (
            <ul className="divide-y divide-border rounded-panel border border-border bg-surface">
              {state.value.items.map((user) => {
                const active = user.id === id;
                return (
                  <li
                    key={user.id}
                    className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${active ? 'bg-brand-soft/45' : ''}`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setId(user.id)}
                    >
                      <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
                      <p className="truncate text-xs text-ink-muted">{user.email}</p>
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <AccountAction
                        version={user.version}
                        id={user.id}
                        archive={false}
                        onSaved={state.reload}
                      />
                      <AccountAction
                        version={user.version}
                        id={user.id}
                        archive
                        onSaved={() => {
                          if (id === user.id) setId('');
                          state.reload();
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </RemoteRegion>
    </Page>
  );
}
