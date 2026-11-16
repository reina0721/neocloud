'use client';
import { SnackbarProvider, useSnackbar } from 'notistack';
import { useTheme } from '@mui/material/styles';
import { useEffect, useMemo } from 'react';
import type { FeedbackProviderProps, FeedbackTransport } from './feedback-provider';
import { FeedbackToastRegion } from './feedback-toast-region';
type HostProps = Omit<FeedbackProviderProps, 'children'> &
  Readonly<{
    connect: (transport: FeedbackTransport) => () => void;
  }>;
function Transport({ closeLabel, loadingLabel, toastDurationMs = 5000, connect }: HostProps) {
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const transport = useMemo<FeedbackTransport>(
    () => ({
      dismiss: (id) => closeSnackbar(id),
      enqueue: (id, message) => {
        enqueueSnackbar(message.title, {
          key: id,
          persist: message.loading || message.duration === 'persistent',
          autoHideDuration: toastDurationMs,
          content: (key) => (
            <FeedbackToastRegion
              message={message}
              closeLabel={closeLabel}
              loadingLabel={loadingLabel}
              onDismiss={() => closeSnackbar(key)}
            />
          ),
        });
      },
    }),
    [enqueueSnackbar, closeSnackbar, closeLabel, loadingLabel, toastDurationMs],
  );
  useEffect(() => connect(transport), [connect, transport]);
  return null;
}
export default function ToastHost(props: HostProps) {
  const theme = useTheme();
  return (
    <SnackbarProvider
      transitionDuration={{
        enter: theme.transitions.duration.standard,
        exit: theme.transitions.duration.shortest,
      }}
      maxSnack={3}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Transport {...props} />
    </SnackbarProvider>
  );
}
