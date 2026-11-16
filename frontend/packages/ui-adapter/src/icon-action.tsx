'use client';
import Button from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import type { ReactNode, Ref } from 'react';
type IconActionBehavior =
  | Readonly<{ onPress: () => void; disabled?: boolean }>
  | Readonly<{ onPress?: never; disabled: true }>;
export type IconActionProps = Readonly<{
  label: string;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
  active?: boolean;
  controls?: string;
  expanded?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  tone?: 'neutral' | 'danger';
  variant?: 'standard' | 'filled';
  tooltip?: boolean | string;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
}> &
  IconActionBehavior;

export function IconAction({
  label,
  ref,
  children,
  controls,
  expanded,
  onPress,
  active = false,
  disabled = false,
  loading = false,
  size = 'md',
  tone = 'neutral',
  variant = 'standard',
  tooltip = false,
  tooltipPlacement = 'top',
}: IconActionProps) {
  const button = (
    <Button
      ref={ref}
      aria-label={label}
      aria-controls={controls}
      aria-expanded={expanded}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={onPress}
      className={`ui-action shrink-0 rounded-action ${size === 'sm' ? 'size-control-sm min-w-control-sm' : 'size-control min-w-control'} ${variant === 'filled' ? (tone === 'danger' ? 'bg-danger text-on-danger' : 'bg-brand text-on-brand hover:bg-brand-strong') : tone === 'danger' ? 'bg-danger-soft text-danger' : active ? 'bg-brand-soft text-brand' : 'bg-transparent text-ink-muted hover:bg-ink/8 hover:text-ink'}`}
    >
      {loading ? <CircularProgress size="1rem" color="inherit" aria-hidden="true" /> : children}
    </Button>
  );
  return tooltip ? (
    <Tooltip title={typeof tooltip === 'string' ? tooltip : label} placement={tooltipPlacement}>
      <span className="inline-flex">{button}</span>
    </Tooltip>
  ) : (
    button
  );
}
