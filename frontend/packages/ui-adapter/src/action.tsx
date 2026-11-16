'use client';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import type { ReactNode } from 'react';
import { actionStyles } from './action-styles';
type ActionBehavior =
  | Readonly<{ type?: 'button'; onPress: () => void; disabled?: boolean }>
  | Readonly<{ type: 'submit' | 'reset'; onPress?: () => void; disabled?: boolean }>
  | Readonly<{ type?: 'button'; onPress?: never; disabled: true }>;

export type ActionProps = Readonly<{
  children: ReactNode;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
  expanded?: boolean;
  controls?: string;
  form?: string;
}> &
  ActionBehavior;

export function Action({
  children,
  leadingIcon,
  trailingIcon,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  expanded,
  controls,
  form,
  type = 'button',
  onPress,
}: ActionProps) {
  return (
    <Button
      type={type}
      variant={
        variant === 'primary' || variant === 'danger'
          ? 'contained'
          : variant === 'secondary'
            ? 'outlined'
            : 'text'
      }
      color={variant === 'danger' ? 'error' : 'primary'}
      className={actionStyles({ fullWidth, size, variant })}
      disabled={disabled || loading}
      aria-disabled={disabled || loading || undefined}
      data-pending={loading || undefined}
      fullWidth={fullWidth}
      aria-busy={loading || undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      form={form}
      onClick={onPress}
      startIcon={
        loading ? (
          <CircularProgress size="1rem" color="inherit" aria-hidden="true" />
        ) : leadingIcon ? (
          <span
            aria-hidden="true"
            className="grid size-icon-sm shrink-0 place-items-center text-current [&>svg]:m-0"
          >
            {leadingIcon}
          </span>
        ) : undefined
      }
      endIcon={
        trailingIcon ? (
          <span
            aria-hidden="true"
            className="grid size-icon-sm shrink-0 place-items-center text-current [&>svg]:m-0"
          >
            {trailingIcon}
          </span>
        ) : undefined
      }
    >
      {children}
    </Button>
  );
}
