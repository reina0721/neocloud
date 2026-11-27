'use client';

import { useFrontendTranslation } from '@neocloud/i18n';
import { usePreferencesPort } from '@neocloud/plugin-framework/preferences';
import type { Preferences } from '@neocloud/surface/preferences-model';
import { BusyIndicator } from '@neocloud/ui-adapter/busy-indicator';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  installBeforeUnloadGuard,
  setLeaveConfirmEnabled,
  setLeaveConfirmResolver,
} from './leave-confirm';
const ConfirmDialog = lazy(() =>
  import('@neocloud/ui-adapter/overlays').then((module) => ({ default: module.ConfirmDialog })),
);

/**
 * Host —— 离开确认对话框（composition root 安装一次）。
 *
 * - 注入 `setLeaveConfirmResolver`：dirty 时应用内导航先弹确认；
 * - 绑定全局偏好：settings 操作偏好「离开未保存内容时提醒」（confirmLeave）关闭时
 *   不询问（产品强制底线仍保留：confirmLeave 只关"询问"不关 beforeunload 兜底草稿；
 *   高风险的既有输入确认不受影响）；
 * - 安装 beforeunload 守卫，在待保存或正在提交时提示；
 * - 取消 → 不改路由/标签/进度（proceedAfterLeaveConfirm 返回 false，不 begin）。
 */
export function LeaveConfirmationGuard({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useFrontendTranslation();
  const preferencesPort = usePreferencesPort<Preferences>();
  const [confirmLeaveEnabled, setConfirmLeaveState] = useState(true);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const pendingResolveRef = useRef<((ok: boolean) => void) | null>(null);

  // 绑定 confirmLeave 偏好 → leave-confirm 开关（即时生效）。
  useEffect(() => {
    const update = () => {
      const next = preferencesPort.getSnapshot().actionPreferences.confirmLeave;
      setConfirmLeaveState(next);
      setLeaveConfirmEnabled(next);
    };
    update();
    return preferencesPort.subscribe(update);
  }, [preferencesPort]);

  // 装配确认实现（只装一次）。
  useEffect(() => {
    setLeaveConfirmResolver((message) => {
      pendingResolveRef.current?.(false);
      setPendingMessage(message);
      return new Promise<boolean>((resolve) => {
        pendingResolveRef.current = resolve;
      });
    });
    return () => {
      setLeaveConfirmResolver(null);
      pendingResolveRef.current?.(false);
      pendingResolveRef.current = null;
    };
  }, []);

  // 浏览器刷新、窗口关闭与版本切换共用整页离开守卫。
  useEffect(() => {
    return installBeforeUnloadGuard();
  }, []);

  const finish = (confirmed: boolean) => {
    setPendingMessage(null);
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    resolve?.(confirmed);
  };

  return (
    <>
      {children}
      {pendingMessage !== null && confirmLeaveEnabled ? (
        <Suspense
          fallback={
            <div className="pointer-events-none fixed inset-0 z-overlay grid place-items-center">
              <BusyIndicator label={t('common.confirmLoading')} />
            </div>
          }
        >
          <ConfirmDialog
            cancelLabel={t('common.cancel')}
            confirmLabel={t('common.leave')}
            description={pendingMessage}
            failureMessage=""
            impact=""
            isOpen
            onOpenChange={(open) => {
              if (!open) finish(false); // 关闭（Escape/背景）视为取消离开
            }}
            onConfirm={() => finish(true)}
            title={t('shell.leaveConfirmTitle')}
            triggerLabel={t('shell.leaveConfirmTitle')}
          />
        </Suspense>
      ) : null}
    </>
  );
}
