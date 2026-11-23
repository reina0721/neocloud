'use client';
import { useState } from 'react';
import {
  FoundationControlledField,
  FoundationForm,
  useFoundationForm,
} from '@clouddrive/form-foundation';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { useRegisterDirtySource } from '@clouddrive/plugin-framework/leave-confirm';
import { Section } from '@clouddrive/surface-foundation/layout';
import { Action } from '@clouddrive/ui-adapter/action';
import { useFeedback } from '@clouddrive/ui-adapter/feedback-context';
import { SwitchField, TextField } from '@clouddrive/ui-adapter/form-field';
import {
  useAdministration,
  type AdministrationPort,
  type PasswordPolicy,
} from '../../../src/administration';
import { IdentityError } from '../../../src/identity/errors';
import { IdentityMutationError, IdentityQueryState } from '../../../src/identity/query-state';
import { useIdentityQuery } from '../../../src/identity/use-query';

type Values = Pick<PasswordPolicy, 'requireComplexity'> & { minLength: string; maxLength: string };

function formValues(value: PasswordPolicy): Values {
  return {
    minLength: String(value.minLength),
    maxLength: String(value.maxLength),
    requireComplexity: value.requireComplexity,
  };
}

export function PasswordPolicySection() {
  const { t } = useFrontendTranslation();
  const port = useAdministration()?.passwordPolicy;
  const query = useIdentityQuery('instance-password-policy', async () => {
    if (!port) return null;
    try {
      return await port.read();
    } catch (error) {
      if (error instanceof IdentityError && error.code === 'forbidden') return null;
      throw error;
    }
  });
  if (!port || (!query.data && !query.error)) return null;
  return (
    <Section
      title={t('systemSettings.password.title')}
      description={t('systemSettings.password.description')}
    >
      {query.data ? (
        <PasswordPolicyFields
          key={query.data.version}
          initial={query.data}
          port={port}
          reload={query.reload}
        />
      ) : (
        <IdentityQueryState error={query.error} retry={query.reload} />
      )}
    </Section>
  );
}

function PasswordPolicyFields({
  initial,
  port,
  reload,
}: Readonly<{
  initial: PasswordPolicy;
  port: AdministrationPort['passwordPolicy'];
  reload: () => void;
}>) {
  const { t } = useFrontendTranslation();
  const { notify } = useFeedback();
  const [baseline, setBaseline] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<IdentityError | null>(null);
  const form = useFoundationForm<Values>({
    defaultValues: formValues(initial),
    schema: () =>
      import('./password-policy-schema').then((module) => module.passwordPolicyFormSchema),
  });
  useRegisterDirtySource({
    pageId: 'system-settings.password-policy',
    message: () => t('identityProduct.unsaved'),
    isDirty: () => form.isDirty,
    isSubmitting: () => pending,
  });
  async function persist(save: () => Promise<PasswordPolicy>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await save();
      setBaseline(saved);
      form.reset(formValues(saved));
      notify({ title: t('systemSettings.password.saved'), tone: 'success' });
    } catch (failure) {
      setError(failure instanceof IdentityError ? failure : new IdentityError('unavailable'));
    } finally {
      setPending(false);
    }
  }
  return (
    <FoundationForm
      form={form}
      className="grid gap-5 p-5 sm:p-6"
      onSubmit={(value) =>
        persist(() =>
          port.update({
            minLength: Number(value.minLength),
            maxLength: Number(value.maxLength),
            requireComplexity: value.requireComplexity,
            version: baseline.version,
          }),
        )
      }
    >
      <p className="text-sm text-ink-muted">
        {t(
          baseline.overridden
            ? 'systemSettings.password.override'
            : 'systemSettings.password.configured',
        )}
      </p>
      <IdentityMutationError error={error} />
      {error?.code === 'conflict' ? (
        <Action variant="secondary" onPress={reload}>
          {t('identityProduct.refresh')}
        </Action>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t('systemSettings.password.minimum')}
          inputMode="numeric"
          disabled={pending}
          {...form.registerField('minLength')}
          {...(form.hasError('minLength')
            ? { error: t('systemSettings.password.lengthError') }
            : {})}
        />
        <TextField
          label={t('systemSettings.password.maximum')}
          inputMode="numeric"
          disabled={pending}
          {...form.registerField('maxLength')}
          {...(form.hasError('maxLength')
            ? { error: t('systemSettings.password.lengthError') }
            : {})}
        />
      </div>
      <FoundationControlledField form={form} name="requireComplexity">
        {(field) => (
          <SwitchField
            label={t('systemSettings.password.complexity')}
            description={t('systemSettings.password.complexityDescription')}
            checked={field.value}
            onCheckedChange={field.onChange}
            disabled={pending}
          />
        )}
      </FoundationControlledField>
      <div className="flex flex-wrap gap-2">
        <Action type="submit" disabled={pending || !form.isDirty} loading={form.isSubmitting}>
          {t('systemSettings.password.save')}
        </Action>
        {baseline.overridden ? (
          <Action
            variant="secondary"
            disabled={pending}
            onPress={() => {
              void persist(() => port.reset(baseline.version));
            }}
          >
            {t('systemSettings.password.restore')}
          </Action>
        ) : null}
      </div>
    </FoundationForm>
  );
}
