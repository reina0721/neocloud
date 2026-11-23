'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FoundationForm, useFoundationForm } from '@clouddrive/form-foundation';
import { Page, PageHeader } from '@clouddrive/surface-foundation/layout';
import { TextField, PasswordField } from '@clouddrive/ui-adapter/form-field';
import { Action } from '@clouddrive/ui-adapter/action';
import { AlertBanner } from '@clouddrive/ui-adapter/feedback';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { AuthFrame } from './frame';
import { LoginHelp } from './login-help';
import { readAuthConfig } from './config';
import { passwordRuleMessage, readInstancePasswordPolicy } from './password-policy';
import { ApiError, createJsonClient } from '../api/json-client';
import type { SetupPasswordPolicy, SetupValues } from './setup-schema';

type SetupState =
  | { status: 'loading' | 'failed' | 'closed' }
  | { status: 'ready'; apiBaseUrl: string; policy: SetupPasswordPolicy };

type SetupFailure = { message: string; field?: keyof SetupValues };

function setupFailure(error: unknown): SetupFailure | 'closed' {
  if (!(error instanceof ApiError)) return { message: 'auth.errors.unavailable' };
  if (error.code === 'network' || error.code === 'timeout' || error.code === 'protocol')
    return { message: `auth.errors.${error.code}` };

  const payload = error.payload;
  const problem =
    payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
  const reason =
    problem && typeof problem === 'object' && 'reason' in problem ? problem.reason : null;

  if (error.status === 401 && reason === 'invalid-setup-token')
    return { field: 'setupToken', message: 'auth.setupTokenInvalid' };
  if (error.status === 409 && reason === 'setup-closed') return 'closed';
  if (error.status === 422) {
    if (reason === 'invalid-password')
      return { field: 'password', message: 'auth.setupPasswordRejected' };
    if (reason === 'invalid-email') return { field: 'email', message: 'auth.emailError' };
    if (reason === 'invalid-name') return { field: 'name', message: 'auth.setupNameError' };
    return { message: 'auth.setupValidation' };
  }
  if (error.status === 403) return { message: 'auth.setupForbidden' };
  return { message: 'auth.errors.unavailable' };
}

export function SetupForm() {
  const { t } = useFrontendTranslation();
  const [state, setState] = useState<SetupState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const config = readAuthConfig();
        if (config.mode !== 'backend') throw new Error('Backend setup requires backend auth');
        const policy = await readInstancePasswordPolicy(config.apiBaseUrl, controller.signal);
        if (!controller.signal.aborted) {
          setState(
            policy.initialized
              ? { status: 'closed' }
              : { status: 'ready', apiBaseUrl: config.apiBaseUrl, policy },
          );
        }
      } catch {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);

  return (
    <AuthFrame>
      <Page>
        <PageHeader
          title={t('auth.setupTitle')}
          description={state.status === 'ready' ? t('auth.setupDescription') : ''}
        />
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-ink-muted">
            {t('auth.setupPolicyLoading')}
          </p>
        ) : null}
        {state.status === 'failed' ? (
          <AlertBanner
            tone="danger"
            announcement="urgent"
            title={t('auth.setupPolicyFailure')}
            description={t('auth.setupPolicyRetry')}
            icon={<AlertTriangle aria-hidden="true" />}
            actionLabel={t('auth.retry')}
            onAction={() => {
              setState({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          />
        ) : null}
        {state.status === 'closed' ? (
          <div className="space-y-4">
            <p role="status" className="text-sm text-ink-muted">
              {t('auth.setupClosed')}
            </p>
            <Link
              className="font-semibold text-brand underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              href="/login"
            >
              {t('auth.loginLink')}
            </Link>
            <LoginHelp />
          </div>
        ) : null}
        {state.status === 'ready' ? (
          <SetupFields
            apiBaseUrl={state.apiBaseUrl}
            policy={state.policy}
            onSetupClosed={() => setState({ status: 'closed' })}
          />
        ) : null}
      </Page>
    </AuthFrame>
  );
}

function SetupFields({
  apiBaseUrl,
  policy,
  onSetupClosed,
}: Readonly<{
  apiBaseUrl: string;
  policy: SetupPasswordPolicy;
  onSetupClosed: () => void;
}>) {
  const { t } = useFrontendTranslation();
  const [failure, setFailure] = useState<SetupFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => () => submission.current?.abort(), []);
  const form = useFoundationForm<SetupValues>({
    schema: () =>
      import('./setup-schema').then(({ createSetupSchema }) => createSetupSchema(policy)),
    defaultValues: { name: '', email: '', password: '', setupToken: '' },
  });
  const passwordRule = t(passwordRuleMessage(policy), {
    minLength: policy.minLength,
    maxLength: policy.maxLength,
  });
  const validation = (field: keyof SetupValues, message: string) => {
    if (failure?.field === field) return { error: t(failure.message) };
    return form.hasError(field) ? { error: message } : {};
  };
  const registerField = (field: keyof SetupValues) => {
    const registered = form.registerField(field);
    return {
      ...registered,
      disabled: submitting,
      onChange: (event: unknown) => {
        if (failure?.field === field) setFailure(null);
        registered.onChange(event);
      },
    };
  };
  const passwordField = registerField('password');

  return (
    <>
      {failure && !failure.field ? (
        <AlertBanner
          tone="danger"
          announcement="urgent"
          title={t('auth.setupErrorTitle')}
          description={t(failure.message)}
          icon={<AlertTriangle aria-hidden="true" />}
        />
      ) : null}
      <FoundationForm
        form={form}
        className="grid gap-5"
        onSubmit={async (values) => {
          const controller = new AbortController();
          submission.current = controller;
          setFailure(null);
          setSubmitting(true);
          try {
            await createJsonClient(apiBaseUrl)('/auth/setup', {
              method: 'POST',
              body: values,
              signal: controller.signal,
            });
            if (!controller.signal.aborted) window.location.replace('/');
          } catch (error) {
            if (controller.signal.aborted) return;
            const outcome = setupFailure(error);
            if (outcome === 'closed') onSetupClosed();
            else setFailure(outcome);
          } finally {
            submission.current = null;
            if (!controller.signal.aborted) setSubmitting(false);
          }
        }}
      >
        <TextField
          label={t('auth.name')}
          autoComplete="name"
          {...registerField('name')}
          {...validation('name', t('auth.setupNameError'))}
        />
        <TextField
          label={t('auth.email')}
          purpose="email"
          autoComplete="username"
          {...registerField('email')}
          {...validation('email', t('auth.emailError'))}
        />
        <PasswordField
          label={t('auth.password')}
          purpose="new"
          showLabel={t('auth.showPassword')}
          hideLabel={t('auth.hidePassword')}
          hint={passwordRule}
          {...passwordField}
          {...validation('password', passwordRule)}
          onBlur={(event) => {
            passwordField.onBlur(event);
            if (event.target.value)
              form.setValue('password', event.target.value, { dirty: false, validate: true });
          }}
        />
        <PasswordField
          label={t('auth.setupToken')}
          purpose="transient"
          showLabel={t('auth.showPassword')}
          hideLabel={t('auth.hidePassword')}
          {...registerField('setupToken')}
          {...validation('setupToken', t('auth.setupTokenRequired'))}
        />
        <Action type="submit" loading={form.isSubmitting} fullWidth>
          {t('auth.setupSubmit')}
        </Action>
      </FoundationForm>
    </>
  );
}
