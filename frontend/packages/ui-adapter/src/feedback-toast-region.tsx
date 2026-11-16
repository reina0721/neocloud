import SnackbarContent from '@mui/material/SnackbarContent';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import { forwardRef } from 'react';
import type { FeedbackMessage } from './feedback-context';

export const FeedbackToastRegion = forwardRef<
  HTMLDivElement,
  Readonly<{
    message: FeedbackMessage;
    closeLabel: string;
    loadingLabel: string;
    onDismiss: () => void;
  }>
>(function FeedbackToastRegion({ message, closeLabel, loadingLabel, onDismiss }, ref) {
  return (
    <SnackbarContent
      ref={ref}
      role={message.tone === 'danger' ? 'alert' : 'status'}
      className="ui-toast border border-border bg-surface-raised text-ink shadow-overlay"
      message={
        <span className="flex items-start gap-3">
          {message.loading ? <CircularProgress aria-label={loadingLabel} size={20} /> : null}
          <span>
            <strong className="block text-sm">{message.title}</strong>
            {message.description ? (
              <span className="mt-1 block text-xs text-ink-muted">{message.description}</span>
            ) : null}
          </span>
        </span>
      }
      action={
        <>
          {message.action ? (
            <Button onClick={message.action.onPress}>{message.action.label}</Button>
          ) : null}
          <IconButton aria-label={closeLabel} onClick={onDismiss}>
            <span aria-hidden="true">×</span>
          </IconButton>
        </>
      }
    />
  );
});
