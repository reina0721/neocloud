'use client';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Autocomplete from '@mui/material/Autocomplete';
import MuiTextField from '@mui/material/TextField';
import type { PopperProps } from '@mui/material/Popper';
import { forwardRef, useId } from 'react';
import { useAutocompleteMessages } from './autocomplete-messages';
import type { CommandMenuProps } from './command-menu';

// 命令结果参与窗口布局，由 DialogContent 统一滚动；普通 Combobox 仍使用浮层。
const CommandResults = forwardRef<HTMLDivElement, PopperProps>(function CommandResults(
  { children, id, role },
  ref,
) {
  return (
    <div ref={ref} className="ui-command-results" id={id} role={role}>
      {typeof children === 'function' ? children({ placement: 'bottom-start' }) : children}
    </div>
  );
});

export default function CommandMenuSurface({
  title,
  searchLabel,
  searchPlaceholder,
  emptyLabel,
  items,
  isOpen: open,
  onOpenChange: setOpen,
  onAction,
}: CommandMenuProps & Readonly<{ isOpen: boolean; onOpenChange: (open: boolean) => void }>) {
  const id = useId();
  const messages = useAutocompleteMessages();
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      aria-labelledby={id}
      fullWidth
      maxWidth="md"
      slotProps={{
        paper: {
          className: 'ui-overlay-surface ui-dialog-layout',
          sx: { alignSelf: 'flex-start', marginTop: 'min(12dvh, 6rem)', overflow: 'visible' },
        },
      }}
    >
      <DialogTitle
        id={id}
        className="border-b border-border px-5 py-4 text-base font-bold text-ink"
      >
        {title}
      </DialogTitle>
      <DialogContent className="ui-dialog-body p-3">
        <Autocomplete
          {...messages}
          open
          disablePortal
          slots={{ popper: CommandResults }}
          options={[...items]}
          autoHighlight
          clearOnBlur={false}
          getOptionLabel={(item) => item.label}
          noOptionsText={emptyLabel}
          filterOptions={(options, state) => {
            const query = state.inputValue.trim().toLocaleLowerCase();
            return options.filter((item) =>
              [item.label, item.description, ...(item.keywords ?? [])].some((value) =>
                value.toLocaleLowerCase().includes(query),
              ),
            );
          }}
          onChange={(_, item) => {
            if (item) {
              setOpen(false);
              onAction(item.id);
            }
          }}
          slotProps={{
            paper: { className: 'ui-overlay-surface' },
            listbox: { 'aria-label': title, className: 'max-h-80 overflow-auto p-2' },
          }}
          renderOption={(props, item) => {
            const { key, ...rest } = props;
            return (
              <li key={key} {...rest}>
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{item.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted">
                    {item.description}
                  </span>
                </span>
              </li>
            );
          }}
          renderInput={(params) => (
            <MuiTextField
              {...params}
              placeholder={searchPlaceholder}
              slotProps={{
                ...params.slotProps,
                htmlInput: {
                  ...params.slotProps.htmlInput,
                  'aria-label': searchLabel,
                  autoFocus: true,
                },
              }}
            />
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
