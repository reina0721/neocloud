'use client';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FoundationForm, useFoundationForm } from '@clouddrive/form-foundation';
import { Page, PageHeader } from '@clouddrive/surface-foundation/layout';
import { PasswordField } from '@clouddrive/ui-adapter/form-field';
import { Action } from '@clouddrive/ui-adapter/action';
import { AlertBanner } from '@clouddrive/ui-adapter/feedback';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { AuthFrame } from './frame';
import { readAuthConfig } from './config';
import { AuthError } from './contract';
import { ApiError, createJsonClient } from '../api/json-client';
import { useAuth } from './context';

function passwordChangeError(error: unknown): string {
  if (error instanceof AuthError && error.code === 'configuration')
    return 'auth.errors.configuration';
  if (!(error instanceof ApiError)) return 'auth.changePasswordUnavailable';
  if (error.code === 'network' || error.code === 'timeout' || error.code === 'protocol')
    return `auth.errors.${error.code}`;
  if (error.status === 401) return 'auth.changePasswordAuthentication';
  if (error.status === 403) return 'auth.changePasswordForbidden';
  if (error.status === 422) return 'auth.changePasswordPolicy';
  if (error.status === 409) {
    const payload = error.payload;
    const problem =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
    if (
      problem &&
      typeof problem === 'object' &&
      'reason' in problem &&
      problem.reason === 'stale-version'
    )
      return 'auth.changePasswordStale';
    return 'auth.changePasswordReused';
  }
  return 'auth.changePasswordUnavailable';
}

export function RequiredPasswordChange() {
  const { t } = useFrontendTranslation();
  const auth = useAuth();
  const [failure, setFailure] = useState<string>();
  const form = useFoundationForm<{ currentPassword: string; newPassword: string }>({
    schema: () =>
      import('@clouddrive/surface/identity').then((module) => module.changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });
  return (
    <AuthFrame>
      <Page>
        <PageHeader
          title={t('auth.requiredPasswordTitle')}
          description={t('auth.requiredPasswordDescription')}
        />
        {failure ? (
          <AlertBanner
            tone="danger"
            announcement="urgent"
            title={t('auth.changePasswordFailure')}
            description={t(failure)}
            icon={<AlertTriangle aria-hidden="true" />}
          />
        ) : null}
        <FoundationForm
          form={form}
          className="grid gap-5"
          onSubmit={async (values) => {
            setFailure(undefined);
            try {
              const config = readAuthConfig();
              if (config.mode !== 'backend') throw new AuthError('configuration');
              await createJsonClient(config.apiBaseUrl)('/auth/password', {
                method: 'POST',
                body: values,
              });
              auth.expire();
              window.location.replace('/login');
            } catch (error) {
              setFailure(passwordChangeError(error));
            }
          }}
        >
          <PasswordField
            label={t('auth.currentPassword')}
            purpose="current"
            showLabel={t('auth.showPassword')}
            hideLabel={t('auth.hidePassword')}
            {...form.registerField('currentPassword')}
            {...(form.hasError('currentPassword')
              ? { error: t('auth.changePasswordCurrentInput') }
              : {})}
          />
          <PasswordField
            label={t('auth.newPassword')}
            purpose="new"
            showLabel={t('auth.showPassword')}
            hideLabel={t('auth.hidePassword')}
            {...form.registerField('newPassword')}
            {...(form.hasError('newPassword') ? { error: t('auth.changePasswordNewInput') } : {})}
          />
          <Action type="submit" loading={form.isSubmitting}>
            {t('auth.changePasswordSubmit')}
          </Action>
        </FoundationForm>
      </Page>
    </AuthFrame>
  );
}
