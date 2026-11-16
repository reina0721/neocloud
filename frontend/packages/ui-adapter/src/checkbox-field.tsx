'use client';
import Checkbox from '@mui/material/Checkbox';
import { useId } from 'react';
type CheckboxChangeProps =
  | Readonly<{ disabled: true; onCheckedChange?: never }>
  | Readonly<{ disabled?: false; onCheckedChange: (checked: boolean) => void }>
  | Readonly<{ disabled: boolean; onCheckedChange: (checked: boolean) => void }>;
export type CheckboxFieldProps = Readonly<{
  label: string;
  description?: string;
  checked: boolean;
  presentation?: 'label' | 'control-only';
}> &
  CheckboxChangeProps;

export function CheckboxField({
  label,
  description,
  checked,
  presentation = 'label',
  disabled = false,
  onCheckedChange,
}: CheckboxFieldProps) {
  const id = useId();
  const descriptionId = useId();
  return (
    <label
      className={`ui-checkbox-field inline-flex min-w-0 items-start gap-2 text-sm ${presentation === 'control-only' ? '' : 'w-full'}`}
      htmlFor={id}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(_, value) => onCheckedChange?.(value)}
        size="small"
        slotProps={{
          input: {
            'aria-label': label,
            'aria-describedby': description ? descriptionId : undefined,
          },
        }}
      />
      <span className={presentation === 'control-only' ? 'sr-only' : 'min-w-0 pt-2'}>
        <span className="block font-semibold text-ink">{label}</span>
        {description ? (
          <span id={descriptionId} className="mt-1 block text-xs leading-5 text-ink-muted">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
