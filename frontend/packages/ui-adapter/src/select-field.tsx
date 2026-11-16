'use client';
import { useId } from 'react';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import type { FieldTextProps } from './field-contract';
export type SelectOption = Readonly<{
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
}>;

export type SelectFieldProps = FieldTextProps &
  Readonly<{
    name?: string;
    value?: string | null;
    defaultValue?: string;
    options: readonly SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    defaultOpen?: boolean;
    onValueChange?: (value: string) => void;
    presentation?: 'field' | 'toolbar';
    popoverPlacement?: 'top' | 'bottom';
  }>;

export function SelectField({
  label,
  hint,
  error,
  options,
  value,
  defaultValue,
  placeholder,
  disabled = false,
  defaultOpen = false,
  onValueChange,
  name,
  presentation = 'field',
  popoverPlacement,
}: SelectFieldProps) {
  const id = useId();
  const toolbar = presentation === 'toolbar';
  return (
    <FormControl
      className={toolbar ? 'ui-select-toolbar min-w-0 max-w-full' : 'ui-field'}
      fullWidth={!toolbar}
      disabled={disabled}
      error={Boolean(error)}
    >
      <label id={id + '-label'} htmlFor={id} className={toolbar ? 'sr-only' : 'ui-field-label'}>
        {label}
      </label>
      <MuiSelect
        id={id}
        labelId={id + '-label'}
        aria-describedby={!toolbar && (error || hint) ? id + '-helper' : undefined}
        name={name}
        value={value === null ? '' : value}
        defaultValue={defaultValue ?? ''}
        defaultOpen={defaultOpen}
        displayEmpty
        className={toolbar ? 'min-h-control-sm max-w-full' : 'ui-material-field'}
        onChange={(event) => onValueChange?.(String(event.target.value))}
        renderValue={(selected) => (
          <span className="ui-select-value flex min-w-0 items-center gap-1.5 truncate">
            {toolbar ? <span className="text-ink-muted">{label}:</span> : null}
            <span className="ui-select-label truncate">
              {options.find((option) => option.value === selected)?.label || placeholder || ''}
            </span>
          </span>
        )}
        MenuProps={{
          slotProps: {
            paper: { className: 'ui-overlay-surface overflow-hidden' },
            list: { className: 'ui-listbox' },
          },
          ...(popoverPlacement === 'top'
            ? {
                anchorOrigin: { vertical: 'top', horizontal: 'left' },
                transformOrigin: { vertical: 'bottom', horizontal: 'left' },
              }
            : {}),
        }}
      >
        {options.map((option, index) => (
          <MenuItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            aria-describedby={option.description ? `${id}-option-${index}` : undefined}
            disabled={option.disabled}
            className="ui-option"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{option.label}</span>
              {option.description ? (
                <span id={`${id}-option-${index}`} className="mt-0.5 block text-xs text-ink-muted">
                  {option.description}
                </span>
              ) : null}
            </span>
          </MenuItem>
        ))}
      </MuiSelect>
      {!toolbar && (error || hint) ? (
        <FormHelperText
          id={id + '-helper'}
          role={error ? 'alert' : undefined}
          className={error ? 'ui-field-error' : 'ui-field-hint'}
        >
          {error || hint}
        </FormHelperText>
      ) : null}
    </FormControl>
  );
}
