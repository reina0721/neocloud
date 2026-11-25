'use client';
import FormControl from '@mui/material/FormControl';
import RadioGroup from '@mui/material/RadioGroup';
import Radio from '@mui/material/Radio';
import { useId, type ReactNode } from 'react';
import type { FieldTextProps } from './field-contract';
export type RadioOption = Readonly<{
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
  /** Decorative comparison only; interactive descendants are not supported. */
  preview?: ReactNode;
}>;

export type RadioGroupFieldProps = FieldTextProps &
  Readonly<{
    value: string;
    options: readonly RadioOption[];
    presentation?: 'cards' | 'rows' | 'tiles' | 'inline' | 'previews';
    labelIcon?: ReactNode;
    labelVisibility?: 'visible' | 'screen-reader';
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }>;

export function RadioGroupField({
  label,
  hint,
  error,
  value,
  options,
  disabled = false,
  onValueChange,
  presentation = 'cards',
  labelIcon,
  labelVisibility = 'visible',
}: RadioGroupFieldProps) {
  const id = useId();
  const comparison = presentation === 'previews';
  const compact = presentation === 'inline';
  const tiles = presentation === 'tiles';
  return (
    <FormControl className="ui-field @container" error={Boolean(error)} disabled={disabled}>
      <div
        className={
          labelVisibility === 'screen-reader' ? 'sr-only' : 'flex min-w-0 items-start gap-3'
        }
      >
        {labelIcon ? (
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"
          >
            {labelIcon}
          </span>
        ) : null}
        <div className="grid gap-1">
          <span id={id} className="ui-field-label">
            {label}
          </span>
          {hint ? (
            <p id={id + '-hint'} className="ui-field-hint">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
      <RadioGroup
        aria-labelledby={id}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={
          [hint ? id + '-hint' : '', error ? id + '-error' : ''].filter(Boolean).join(' ') ||
          undefined
        }
        value={value}
        onChange={(_, next) => onValueChange(next)}
        className={
          presentation === 'rows'
            ? 'grid gap-2'
            : compact
              ? 'flex flex-row flex-wrap gap-2'
              : comparison || presentation === 'tiles'
                ? 'grid grid-cols-1 gap-3 @sm:grid-cols-3'
                : 'surface-filter-grid'
        }
      >
        {options.map((option) => (
          <label
            key={option.value}
            className={`ui-choice-content flex min-w-0 cursor-pointer border rounded-control ${comparison ? 'p-2 border-transparent bg-transparent' : 'p-3'} ${comparison ? (value === option.value ? 'text-brand' : 'text-ink') : value === option.value ? 'border-brand bg-brand-soft text-ink' : 'border-border bg-surface text-ink'} ${disabled || option.disabled ? 'cursor-not-allowed opacity-50' : ''} ${comparison ? 'flex-col items-start' : 'items-start'}`}
          >
            {option.preview ? (
              <span
                aria-hidden="true"
                className={`pointer-events-none block w-full min-w-0 ${comparison ? `rounded-control border-2 ${value === option.value ? 'border-brand' : 'border-transparent'}` : ''}`}
              >
                {option.preview}
              </span>
            ) : null}
            <span
              className={`flex min-w-0 gap-2 ${tiles ? 'flex-col items-center' : 'items-start'}`}
            >
              <Radio
                value={option.value}
                disabled={disabled || option.disabled}
                size="small"
                {...(tiles
                  ? {
                      className: option.icon ? 'p-0' : 'sr-only',
                      icon: (
                        <span
                          aria-hidden="true"
                          className="ui-choice-icon grid size-5 place-items-center"
                        >
                          {option.icon}
                        </span>
                      ),
                      checkedIcon: (
                        <span
                          aria-hidden="true"
                          className="ui-choice-icon grid size-5 place-items-center"
                        >
                          {option.icon}
                        </span>
                      ),
                    }
                  : {})}
                slotProps={{
                  input: {
                    'aria-label': option.label,
                    'aria-describedby': option.description ? id + '-' + option.value : undefined,
                  },
                }}
              />
              {option.icon && !tiles ? (
                <span
                  aria-hidden="true"
                  className="ui-choice-icon grid size-5 shrink-0 place-items-center mt-2"
                >
                  {option.icon}
                </span>
              ) : null}
              <span className={`ui-choice-text min-w-0 ${tiles ? 'text-center' : 'pt-2'}`}>
                <span className="block font-semibold">{option.label}</span>
                {option.description ? (
                  <span
                    id={id + '-' + option.value}
                    className="mt-1 block text-xs leading-5 text-ink-muted"
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {error ? (
        <p id={id + '-error'} className="ui-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </FormControl>
  );
}
