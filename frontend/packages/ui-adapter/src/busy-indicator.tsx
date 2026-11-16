'use client';
import CircularProgress from '@mui/material/CircularProgress';
export type BusyIndicatorProps = Readonly<{
  label: string;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}>;

export function BusyIndicator({ label, size = 'md', showLabel = false }: BusyIndicatorProps) {
  return (
    <span
      aria-label={label}
      className="inline-flex items-center gap-2 text-sm font-medium text-ink-muted"
      role="status"
    >
      <CircularProgress
        aria-hidden="true"
        className="text-brand"
        size={size === 'sm' ? 16 : size === 'lg' ? 32 : 24}
      />
      {showLabel ? <span>{label}</span> : null}
    </span>
  );
}
