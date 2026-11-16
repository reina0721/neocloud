'use client';
import { useAutocompleteMessages } from './autocomplete-messages';
import Autocomplete from '@mui/material/Autocomplete';
import MuiTextField from '@mui/material/TextField';
import { useId } from 'react';
import type { FieldTextProps } from './field-contract';
import type { SelectOption } from './select-field';
export type ComboFieldProps = FieldTextProps &
  Readonly<{
    value?: string | null;
    options: readonly SelectOption[];
    placeholder: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
  }>;

export function ComboField({
  label,
  hint,
  error,
  value,
  options,
  placeholder,
  disabled = false,
  onValueChange,
}: ComboFieldProps) {
  const id = useId();
  const messages = useAutocompleteMessages();
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <Autocomplete
        {...messages}
        id={id}
        options={[...options]}
        {...(value === undefined
          ? {}
          : { value: options.find((option) => option.value === value) ?? null })}
        getOptionLabel={(option) => option.label}
        getOptionDisabled={(option) => Boolean(option.disabled)}
        isOptionEqualToValue={(a, b) => a.value === b.value}
        disabled={disabled}
        openOnFocus
        autoHighlight
        onChange={(_, option) => {
          if (option) onValueChange?.(option.value);
        }}
        slotProps={{
          paper: { className: 'ui-overlay-surface' },
          listbox: { className: 'ui-listbox' },
        }}
        renderInput={(params) => (
          <MuiTextField
            {...params}
            placeholder={placeholder}
            error={Boolean(error)}
            helperText={error || hint}
            slotProps={{
              htmlInput: { ...params.slotProps.htmlInput, 'aria-label': label },
              input: params.slotProps.input,
              formHelperText: { className: error ? 'ui-field-error' : 'ui-field-hint' },
            }}
          />
        )}
      />
    </div>
  );
}
