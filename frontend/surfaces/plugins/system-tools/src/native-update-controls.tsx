'use client';

import { useEffect, useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Section } from '@neocloud/surface-foundation/layout';
import { Action } from '@neocloud/ui-adapter/action';
import { ConfirmDialog } from '@neocloud/ui-adapter/overlays';
import { StatusPill } from '@neocloud/ui-adapter/status-pill';
import {
  RuntimeReadError,
  type NativeUpdateStatus,
  type RuntimePort,
} from '../../../src/administration/runtime-model';
import { GitHubReleaseSection } from './github-release-section';

type Intent = 'apply' | 'rollback' | 'cancel';

export function NativeUpdateControls({
  initial,
  runtime,
}: Readonly<{ initial: NativeUpdateStatus; runtime: RuntimePort }>) {
  const { t } = useFrontendTranslation();
  const [status, setStatus] = useState(initial);
  const [intent, setIntent] = useState<Intent>();
  const [waiting, setWaiting] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const running = status.job !== undefined && !status.job.done;
  const refresh = waiting || running;

  useEffect(() => {
    if (!refresh) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await runtime.nativeUpdate(controller.signal);
        if (controller.signal.aborted) return;
        if (value.kind !== 'available') {
          setAccessLost(true);
          setWaiting(false);
          return;
        }
        setStatus(value.status);
        setWaiting(false);
        if (!value.status.job?.done && value.status.job !== undefined) {
          timer = setTimeout(() => void poll(), 1200);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof RuntimeReadError &&
          (error.code === 'unauthenticated' || error.code === 'forbidden')
        ) {
          setAccessLost(true);
          setWaiting(false);
          return;
        }
        // The old or new worker may be inside the host's bounded handoff gate.
        timer = setTimeout(() => void poll(), 2000);
      }
    }
    timer = setTimeout(() => void poll(), 700);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [refresh, runtime]);

  const labels = {
    apply: t('systemUpdate.upgrade'),
    rollback: t('systemUpdate.rollback'),
    cancel: t('systemUpdate.native.cancel'),
  };

  async function confirm() {
    if (!intent) return;
    setWaiting(true);
    if (intent === 'cancel') {
      await runtime.cancelNativeUpdate();
    } else {
      const job = await runtime.startNativeUpdate(intent);
      setStatus((current) => ({
        ...current,
        canApply: false,
        canRollback: false,
        canCancel: true,
        job,
      }));
    }
    setIntent(undefined);
  }

  if (accessLost) return <p role="status">{t('systemUpdate.status.owner-required')}</p>;

  const job = status.job;
  const versions = t('systemUpdate.native.versions', {
    go: status.current,
    web: status.webVersion,
  });
  return (
    <>
      <Section title={t('systemUpdate.version')} density="compact" contentInset>
        <p className="break-all text-sm font-medium tabular-nums">{versions}</p>
      </Section>
      <GitHubReleaseSection load={runtime.latestRelease} />
      <Section title={t('systemUpdate.operations')} density="compact" contentInset>
        <div className="space-y-2 text-sm">
          {job ? (
            <p role="status" className="flex flex-wrap items-baseline gap-2">
              <StatusPill tone={job.phase === 'failed' ? 'danger' : 'neutral'}>
                {t(
                  job.phase === 'succeeded' && !job.target
                    ? 'systemUpdate.native.noUpdate'
                    : `systemUpdate.native.phases.${job.phase}`,
                )}
              </StatusPill>
              {job.target ? <span className="tabular-nums">{job.target}</span> : null}
            </p>
          ) : null}
          {!status.canRollback && !running ? (
            <p className="text-ink-muted">{t('systemUpdate.native.noRollback')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Action
              size="sm"
              variant="secondary"
              disabled={!status.canApply || waiting}
              onPress={() => setIntent('apply')}
            >
              {labels.apply}
            </Action>
            <Action
              size="sm"
              variant="secondary"
              disabled={!status.canRollback || waiting}
              onPress={() => setIntent('rollback')}
            >
              {labels.rollback}
            </Action>
            {running ? (
              <Action
                size="sm"
                variant="quiet"
                disabled={!status.canCancel || waiting}
                onPress={() => setIntent('cancel')}
              >
                {labels.cancel}
              </Action>
            ) : null}
          </div>
          {intent ? (
            <ConfirmDialog
              isOpen
              title={labels[intent]}
              triggerLabel={labels[intent]}
              description={t(`systemUpdate.native.confirm.${intent}`)}
              impact={versions}
              cancelLabel={t('systemUpdate.native.dismiss')}
              confirmLabel={labels[intent]}
              failureMessage={t('systemUpdate.native.submitFailed')}
              onOpenChange={(open) => {
                if (!open) setIntent(undefined);
              }}
              onConfirm={confirm}
            />
          ) : null}
        </div>
      </Section>
    </>
  );
}
