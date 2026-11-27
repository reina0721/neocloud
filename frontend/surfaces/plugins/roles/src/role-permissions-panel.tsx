'use client';
import { useCallback, useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { CheckboxField } from '@neocloud/ui-adapter/form-field';
import { DialogSurface } from '@neocloud/ui-adapter/overlays';
import { useFeedback } from '@neocloud/ui-adapter/feedback-context';
import { IdentityError, type DirectoryRole } from '@neocloud/surface/identity/runtime';
import { useRequiredAdministration } from '../../../src/administration/context';
import type { AdministrationPort, Permission } from '../../../src/administration/model';
import { RemoteRegion, useRemote } from '../../../src/administration/resource-state';
import { IdentityMutationError } from '../../../src/identity/query-state';

type RoleGrants = Awaited<ReturnType<AdministrationPort['rolePermissions']>>;

function RolePermissionDialog({
  catalog,
  grants,
  reload,
  onSaved,
}: Readonly<{
  catalog: readonly Permission[];
  grants: RoleGrants;
  reload: () => void;
  onSaved: () => void;
}>) {
  const port = useRequiredAdministration();
  const { t } = useFrontendTranslation();
  const { notify } = useFeedback();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(grants.permissionKeys);
  const [failure, setFailure] = useState<IdentityError | null>(null);
  const dirty =
    keys.length !== grants.permissionKeys.length ||
    keys.some((key) => !grants.permissionKeys.includes(key));

  function close() {
    setOpen(false);
    setKeys(grants.permissionKeys);
    setFailure(null);
  }

  return (
    <>
      <Action variant="secondary" onPress={() => setOpen(true)}>
        {t('roles.editPermissions')}
      </Action>
      <DialogSurface
        triggerLabel={t('roles.editPermissions')}
        title={t('roles.editPermissions')}
        description={t('roles.nativeImpact')}
        cancelLabel={t('identityProduct.cancel')}
        confirmLabel={t('identityProduct.save')}
        confirmDisabled={!dirty || failure?.code === 'conflict'}
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        onConfirm={async () => {
          setFailure(null);
          try {
            await port.replaceRolePermissions({ ...grants, permissionKeys: keys });
            notify({ title: t('roles.permissionsSaved'), tone: 'success' });
            reload();
            onSaved();
          } catch (error) {
            const issue = error instanceof IdentityError ? error : new IdentityError('unavailable');
            setFailure(issue);
            throw issue;
          }
        }}
      >
        <IdentityMutationError error={failure} />
        {failure?.code === 'conflict' ? (
          <div>
            <Action
              variant="secondary"
              size="sm"
              onPress={() => {
                close();
                reload();
              }}
            >
              {t('identityProduct.refresh')}
            </Action>
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.map((permission) => (
            <CheckboxField
              key={permission.key}
              label={permission.key}
              checked={keys.includes(permission.key)}
              onCheckedChange={(checked) =>
                setKeys((prior) =>
                  checked
                    ? [...prior, permission.key]
                    : prior.filter((key) => key !== permission.key),
                )
              }
            />
          ))}
        </div>
      </DialogSurface>
    </>
  );
}

export function RolePermissionsPanel({
  role,
  editable,
  onSaved,
}: Readonly<{ role: DirectoryRole; editable: boolean; onSaved: () => void }>) {
  const port = useRequiredAdministration();
  const { t } = useFrontendTranslation();
  const state = useRemote(
    useCallback(async () => {
      const [grants, catalog] = await Promise.all([
        port.rolePermissions(role.id),
        editable ? port.permissions() : [],
      ]);
      return { grants, catalog };
    }, [port, role.id, editable]),
  );
  return (
    <RemoteRegion {...state}>
      {state.value ? (
        <>
          {state.value.grants.permissionKeys.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('roles.noPermissions')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {state.value.grants.permissionKeys.map((key) => (
                <li key={key} className="break-all rounded-control bg-surface-muted px-2 py-1">
                  <code className="text-xs text-ink-muted">{key}</code>
                </li>
              ))}
            </ul>
          )}
          {editable ? (
            <div>
              <RolePermissionDialog
                key={state.value.grants.roleVersion}
                catalog={state.value.catalog}
                grants={state.value.grants}
                reload={state.reload}
                onSaved={onSaved}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </RemoteRegion>
  );
}
