'use client';
import LinearProgress from '@mui/material/LinearProgress';
export type ProgressMeterProps = Readonly<{
  value: number;
  label: string;
}>;

export function ProgressMeter({ value, label }: ProgressMeterProps) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="ui-progress-meter grid gap-2">
      <div className="flex justify-between gap-2 text-xs text-ink-muted">
        <span>{label}</span>
        <span>{normalized}%</span>
      </div>
      <LinearProgress
        aria-label={label}
        value={normalized}
        variant="determinate"
        className="h-2 rounded-action"
      />
    </div>
  );
}
