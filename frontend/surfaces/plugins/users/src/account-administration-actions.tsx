'use client';
import { useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { PasswordField } from '@clouddrive/ui-adapter/form-field';
import { DialogSurface } from '@clouddrive/ui-adapter/overlays';
import { useFeedback } from '@clouddrive/ui-adapter/feedback-context';
import { Section } from '@clouddrive/surface-foundation/layout';
import { IdentityError, type DirectoryUser } from '@clouddrive/surface/identity/runtime';
import { IdentityMutationError } from '../../../src/identity/query-state';
import { useRequiredAdministration } from '../../../src/administration/context';

export function AccountAdministrationActions({
  user,
  self,
  refresh,
  onArchived,
  refreshing,
}: Readonly<{
  user: DirectoryUser;
  self: boolean;
  refresh: () => void;
  onArchived: () => void;
  refreshing: boolean;
}>) {
  const port = useRequiredAdministration();
  const { t } = useFrontendTranslation();
  const { notify } = useFeedback();
  const [action, setAction] = useState<'reset' | 'archive' | null>(null);
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<IdentityError | null>(null);
  const archive = action === 'archive';
  const label = t(archive ? 'users.archive' : 'users.resetPassword');

  function close() {
    setAction(null);
    setPassword('');
    setFailure(null);
  }

  return (
    <Section title={t('users.accountAdministration')}>
      <div className="flex flex-wrap gap-3 p-5">
        <Action variant="secondary" disabled={refreshing} onPress={() => setAction('reset')}>
          {t('users.resetPassword')}
        </Action>
        <Action variant="secondary" disabled={refreshing} onPress={() => setAction('archive')}>
          {t('users.archive')}
        </Action>
      </div>
      <DialogSurface
        triggerLabel={label}
        title={label}
        description={t(archive ? 'users.archiveWarning' : 'users.resetPasswordWarning', {
          email: user.email,
        })}
        cancelLabel={t('identityProduct.cancel')}
        confirmLabel={label}
        confirmDisabled={refreshing || failure?.code === 'conflict' || (!archive && !password)}
        isOpen={action !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        onConfirm={async () => {
          if (action === null) return;
          setFailure(null);
          try {
            if (archive) {
              await port.archiveAccount(user.id, user.version);
              notify({ title: t('users.archived'), tone: 'success' });
              if (self) port.endSession();
              else onArchived();
            } else {
              await port.resetPassword(user.id, password, user.version);
              notify({ title: t('users.passwordReset'), tone: 'success' });
              if (self) port.endSession();
              else refresh();
            }
          } catch (error) {
            const issue = error instanceof IdentityError ? error : new IdentityError('unavailable');
            setFailure(issue);
            throw issue;
          }
        }}
      >
        <div className="grid gap-3">
          <IdentityMutationError error={failure} />
          {failure?.code === 'conflict' ? (
            <div>
              <Action
                variant="secondary"
                size="sm"
                onPress={() => {
                  close();
                  refresh();
                }}
              >
                {t('identityProduct.refresh')}
              </Action>
            </div>
          ) : null}
          {!archive ? (
            <PasswordField
              label={t('administration.newPassword')}
              purpose="new"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              showLabel={t('account.showPassword')}
              hideLabel={t('account.hidePassword')}
            />
          ) : null}
        </div>
      </DialogSurface>
    </Section>
  );
}
