'use client';
import { formatDate } from '@clouddrive/i18n';
import { usePreferencesPort } from '@clouddrive/plugin-framework/preferences';
import type { Preferences } from '@clouddrive/surface/preferences-model';
import { useState } from 'react';
import {
  FoundationForm,
  FoundationControlledField,
  useFoundationForm,
} from '@clouddrive/form-foundation';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Page, PageHeader, Section } from '@clouddrive/surface-foundation/layout';
import { FormActions } from '@clouddrive/surface-foundation/form-actions';
import { SelectField, SwitchField, type SelectOption } from '@clouddrive/ui-adapter/form-field';
import { Action } from '@clouddrive/ui-adapter/action';
import { StatusPill } from '@clouddrive/ui-adapter/status-pill';
import { ConfirmDialog } from '@clouddrive/ui-adapter/overlays';
import { useFeedback } from '@clouddrive/ui-adapter/feedback-context';
import { useRegisterDirtySource } from '@clouddrive/plugin-framework/leave-confirm';
import {
  IdentityError,
  useIdentityPort,
  type RegistrationConfiguration,
  type RegistrationSettingsInput,
} from '@clouddrive/surface/identity/runtime';
import { useIdentityQuery } from '../../../src/identity/use-query';
import { SettingsSections } from './settings-sections';
import { PasswordPolicySection } from './password-policy';
import {
  IdentityModeNotice,
  IdentityQueryState,
  IdentityMutationError,
} from '../../../src/identity/query-state';

function SettingsForm({
  configuration,
  allowed,
}: Readonly<{
  configuration: RegistrationConfiguration;
  allowed: boolean;
}>) {
  const { t, locale } = useFrontendTranslation();
  const region = usePreferencesPort<Preferences>().getSnapshot().localeRegion;
  const port = useIdentityPort();
  const { notify } = useFeedback();
  const { settings } = configuration;
  const [baseline, setBaseline] = useState(settings);
  const [reloaded, setReloaded] = useState<{
    previous: RegistrationConfiguration;
    current: RegistrationConfiguration;
  } | null>(null);
  const { roleOptions } = reloaded?.previous === configuration ? reloaded.current : configuration;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<IdentityError | null>(null);
  const [invalidRole, setInvalidRole] = useState(false);
  const [confirmation, setConfirmation] = useState<RegistrationSettingsInput | null>(null);
  const form = useFoundationForm<RegistrationSettingsInput>({
    schema: () =>
      import('../../../src/identity/model').then(
        (module) => module.registrationSettingsInputSchema,
      ),
    defaultValues: {
      enabled: settings.enabled,
      defaultRoleId: settings.defaultRoleId,
      version: settings.version,
    },
  });
  useRegisterDirtySource({
    pageId: 'system-settings.registration',
    message: () => t('identityProduct.unsaved'),
    isDirty: () => form.isDirty,
    isSubmitting: () => pending,
  });
  const options: SelectOption[] = [
    { value: '', label: t('systemSettings.unsetRole') },
    ...roleOptions.map((role) => ({
      value: role.id,
      label:
        port.mode === 'mock' && ['administrator', 'operator', 'viewer'].includes(role.id)
          ? t(`identityProduct.roleNames.${role.id}`)
          : role.name,
      disabled: !role.eligible,
      ...(role.reason ? { description: t(`systemSettings.roleReasons.${role.reason}`) } : {}),
    })),
  ];
  if (baseline.defaultRoleId && !roleOptions.some((role) => role.id === baseline.defaultRoleId))
    options.push({
      value: baseline.defaultRoleId,
      label: t('systemSettings.missingRole', { id: baseline.defaultRoleId }),
      description: t('systemSettings.roleReasons.missing-role'),
      disabled: true,
    });
  function roleCouldHaveChanged() {
    return (
      failure?.reason === 'protected-role' ||
      failure?.reason === 'inactive-role' ||
      failure?.reason === 'missing-role' ||
      failure?.reason === 'restricted-permissions'
    );
  }
  async function reload() {
    if (pending) return;
    setPending(true);
    try {
      const current = await port.registrationConfiguration();
      const latest = current.settings;
      setReloaded({ previous: configuration, current });
      setBaseline(latest);
      form.reset({
        enabled: latest.enabled,
        defaultRoleId: latest.defaultRoleId,
        version: latest.version,
      });
      setInvalidRole(false);
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof IdentityError ? error : new IdentityError('unavailable'));
    } finally {
      setPending(false);
    }
  }
  async function save() {
    if (!confirmation || pending) return;
    setPending(true);
    try {
      const saved = await port.updateRegistrationSettings(confirmation);
      setBaseline(saved);
      form.reset({
        enabled: saved.enabled,
        defaultRoleId: saved.defaultRoleId,
        version: saved.version,
      });
      setConfirmation(null);
      setFailure(null);
      notify({ title: t('systemSettings.saved'), tone: 'success' });
    } catch (error) {
      const problem = error instanceof IdentityError ? error : new IdentityError('unavailable');
      setFailure(problem);
      throw problem;
    } finally {
      setPending(false);
    }
  }
  return (
    <Section
      title={t('systemSettings.title')}
      description={t('systemSettings.description')}
      action={
        <div className="flex items-center gap-2">
          <StatusPill tone={baseline.enabled ? 'success' : 'neutral'}>
            {t(baseline.enabled ? 'systemSettings.open' : 'systemSettings.closed')}
          </StatusPill>
          <span className="text-xs tabular-nums text-ink-muted">
            {formatDate(
              locale,
              baseline.updatedAt,
              region.timeZone === 'auto' ? {} : { timeZone: region.timeZone },
            )}
          </span>
        </div>
      }
    >
      <FoundationForm
        form={form}
        className="grid gap-6 p-5 sm:p-6"
        onSubmit={(values) => {
          if (
            values.enabled &&
            !roleOptions.some((role) => role.id === values.defaultRoleId && role.eligible)
          ) {
            setInvalidRole(true);
            return;
          }
          setFailure(null);
          setConfirmation(values);
        }}
      >
        {!allowed ? <p className="text-sm text-ink-muted">{t('systemSettings.readonly')}</p> : null}
        <IdentityMutationError
          error={failure}
          reload={() => {
            void reload();
          }}
        />
        {roleCouldHaveChanged() ? (
          <Action variant="secondary" size="sm" disabled={pending} onPress={() => void reload()}>
            {t('identityProduct.refresh')}
          </Action>
        ) : null}
        <FoundationControlledField form={form} name="enabled">
          {(field) => (
            <div className="max-w-xl">
              <SwitchField
                label={t('systemSettings.enabled')}
                description={t('systemSettings.enabledHint')}
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked);
                  setInvalidRole(false);
                }}
                disabled={!allowed || pending}
              />
            </div>
          )}
        </FoundationControlledField>
        <FoundationControlledField form={form} name="defaultRoleId">
          {(field) => {
            const selected = roleOptions.find((role) => role.id === field.value);
            const description = options.find((option) => option.value === field.value)?.description;
            return (
              <div className="grid max-w-xl min-w-0 gap-3">
                <SelectField
                  label={t('systemSettings.role')}
                  hint={description ?? t('systemSettings.roleHint')}
                  value={field.value}
                  onValueChange={(id) => {
                    field.onChange(id);
                    setInvalidRole(false);
                  }}
                  disabled={!allowed || pending}
                  options={options}
                  {...(invalidRole || form.hasError('defaultRoleId')
                    ? { error: t('systemSettings.invalid') }
                    : {})}
                />
                {selected ? (
                  <div className="rounded-control border border-border/60 bg-surface-muted/30 p-3 text-xs text-ink-muted">
                    <p className="font-semibold text-ink">{t('systemSettings.permissions')}</p>
                    {selected.permissionKeys.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {selected.permissionKeys.map((permission) => (
                          <span
                            key={permission}
                            className="break-all rounded border border-border/80 bg-surface px-2 py-0.5 text-ink-muted"
                          >
                            {t(`management.permissions.${permission}`, {
                              defaultValue: permission,
                            })}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1">{t('systemSettings.noPermissions')}</p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          }}
        </FoundationControlledField>
        <FormActions
          primary={
            <Action type="submit" disabled={!allowed || !form.isDirty || pending}>
              {t('systemSettings.save')}
            </Action>
          }
          secondary={
            <Action
              variant="quiet"
              disabled={pending}
              onPress={() => {
                form.reset({
                  enabled: baseline.enabled,
                  defaultRoleId: baseline.defaultRoleId,
                  version: baseline.version,
                });
                setInvalidRole(false);
                setFailure(null);
              }}
            >
              {t('systemSettings.reset')}
            </Action>
          }
        />
      </FoundationForm>
      <ConfirmDialog
        triggerLabel=""
        title={t('systemSettings.confirm')}
        description={t('systemSettings.description')}
        impact={t('systemSettings.impact')}
        cancelLabel={t('systemSettings.cancel')}
        confirmLabel={t('systemSettings.save')}
        failureMessage={t('systemSettings.failure')}
        isOpen={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        onConfirm={save}
      />
    </Section>
  );
}
export function RegistrationSettingsPage() {
  const { t } = useFrontendTranslation();
  const port = useIdentityPort();
  const query = useIdentityQuery('registration-settings', async (service) => {
    const access = await service.access();
    if (!access.permissions.includes('settings.read')) throw new IdentityError('forbidden');
    const configuration = await service.registrationConfiguration();
    return { configuration, allowed: access.permissions.includes('settings.update') };
  });
  return (
    <Page>
      <PageHeader title={t('systemSettings.nav')} description={t('systemSettings.description')} />
      {port.mode === 'backend' ? <SettingsSections active="registration" /> : null}
      <IdentityModeNotice mode={port.mode} />
      {port.mode === 'backend' ? (
        <PasswordPolicySection key={`password-policy:${port.currentUserId() ?? ''}`} />
      ) : null}
      {query.error || !query.data ? (
        <IdentityQueryState error={query.error} retry={query.reload} />
      ) : (
        <SettingsForm
          key={port.currentUserId()}
          configuration={query.data.configuration}
          allowed={query.data.allowed}
        />
      )}
    </Page>
  );
}
