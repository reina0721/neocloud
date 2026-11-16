'use client';
import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { FeedbackContext, type FeedbackController, type FeedbackMessage } from './feedback-context';
const ToastHost = lazy(() => import('./feedback-toast-host'));
export type FeedbackProviderProps = Readonly<{
  children: ReactNode;
  closeLabel: string;
  loadingLabel: string;
  toastDurationMs?: number;
}>;
export type FeedbackTransport = Readonly<{
  enqueue: (id: string, message: FeedbackMessage) => void;
  dismiss: (id?: string) => void;
}>;

/** Keep the context and business subtree stable while loading the notification renderer. */
export function FeedbackProvider({ children, ...labels }: FeedbackProviderProps) {
  const [active, setActive] = useState(false);
  const state = useRef({
    sequence: 0,
    pending: new Map<string, FeedbackMessage>(),
    transport: undefined as FeedbackTransport | undefined,
  });
  const controller = useMemo<FeedbackController>(
    () => ({
      notify(message) {
        const id = `feedback-${++state.current.sequence}`;
        if (state.current.transport) state.current.transport.enqueue(id, message);
        else {
          state.current.pending.set(id, message);
          setActive(true);
        }
        return id;
      },
      dismiss(id) {
        state.current.pending.delete(id);
        state.current.transport?.dismiss(id);
      },
      clear() {
        state.current.pending.clear();
        state.current.transport?.dismiss();
      },
    }),
    [],
  );
  const connect = useCallback((transport: FeedbackTransport) => {
    state.current.transport = transport;
    for (const [id, message] of state.current.pending) transport.enqueue(id, message);
    state.current.pending.clear();
    return () => {
      if (state.current.transport === transport) state.current.transport = undefined;
    };
  }, []);
  return (
    <FeedbackContext value={controller}>
      {children}
      <Suspense
        fallback={
          <div role="status" className="sr-only">
            {labels.loadingLabel}
          </div>
        }
      >
        {active ? <ToastHost {...labels} connect={connect} /> : null}
      </Suspense>
    </FeedbackContext>
  );
}
