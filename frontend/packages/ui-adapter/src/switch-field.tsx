'use client';
import Switch from '@mui/material/Switch';
import { useId } from 'react';
export type SwitchFieldProps = Readonly<{
  label: string;
  description: string;
  checked: boolean;
  presentation?: 'card' | 'row';
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}>;

export function SwitchField({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
  presentation = 'card',
}: SwitchFieldProps) {
  const id = useId();
  const descriptionId = useId();
  return (
    <label
      htmlFor={id}
      data-disabled={disabled || undefined}
      className={`ui-switch-content flex w-full min-w-0 items-center justify-between gap-4 ${presentation === 'row' ? 'px-3 py-2' : 'rounded-panel border border-border bg-surface p-4'}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span id={descriptionId} className="mt-1 block text-xs leading-5 text-ink-muted">
          {description}
        </span>
      </span>
      <Switch
        id={id}
        className="ui-switch"
        checked={checked}
        disabled={disabled}
        onChange={(_, value) => onCheckedChange(value)}
        slotProps={{
          thumb: { className: 'ui-switch-thumb' },
          track: { className: 'ui-switch-track' },
          input: { role: 'switch', 'aria-label': label, 'aria-describedby': descriptionId },
        }}
      />
    </label>
  );
}
