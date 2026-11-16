import MuiToggleButton from '@mui/material/ToggleButton';
import {
  ToggleButton as AriaToggleButton,
  ToggleButtonGroup as AriaToggleButtonGroup,
} from 'react-aria-components/ToggleButtonGroup';
import { useId, type ReactNode } from 'react';
export type ToggleGroupOption = Readonly<{
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}>;

export type ToggleGroupProps = Readonly<{
  label: string;
  description?: string;
  options: readonly ToggleGroupOption[];
  selectedIds: readonly string[];
  onSelectionChange: (selectedIds: readonly string[]) => void;
  selectionMode?: 'single' | 'multiple';
  size?: 'sm' | 'md';
  disabled?: boolean;
}>;

export function ToggleGroup({
  label,
  description,
  options,
  selectedIds,
  onSelectionChange,
  selectionMode = 'single',
  size = 'md',
  disabled = false,
}: ToggleGroupProps) {
  const id = useId();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <span id={id} className="text-sm font-semibold text-ink">
        {label}
      </span>
      {description ? (
        <span id={id + '-description'} className="text-xs leading-5 text-ink-muted">
          {description}
        </span>
      ) : null}
      <AriaToggleButtonGroup
        aria-labelledby={id}
        {...(description ? { 'aria-describedby': id + '-description' } : {})}
        selectionMode={selectionMode}
        selectedKeys={new Set(selectedIds)}
        onSelectionChange={(keys) => onSelectionChange([...keys].map(String))}
        isDisabled={disabled}
        className={`inline-flex min-w-0 max-w-full rounded-panel border border-border bg-surface-muted p-1 ${selectionMode === 'multiple' ? 'flex-wrap gap-1' : 'gap-0 overflow-x-auto'}`}
      >
        {options.map((option) => (
          <MuiToggleButton
            component={AriaToggleButton}
            id={option.id}
            key={option.id}
            value={option.id}
            selected={selectedIds.includes(option.id)}
            isDisabled={Boolean(disabled || option.disabled)}
            className={`${size === 'sm' ? 'min-h-control-sm px-3' : 'min-h-control px-3.5'} gap-2 rounded-control border ${selectionMode === 'multiple' ? 'border-border' : 'border-transparent'} data-[selected]:bg-brand-soft data-[selected]:text-brand`}
          >
            {option.icon ? (
              <span
                aria-hidden="true"
                className="grid size-icon-sm shrink-0 place-items-center text-current [&>svg]:m-0"
              >
                {option.icon}
              </span>
            ) : null}
            <span>{option.label}</span>
          </MuiToggleButton>
        ))}
      </AriaToggleButtonGroup>
    </div>
  );
}
