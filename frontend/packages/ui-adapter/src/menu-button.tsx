'use client';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuList from '@mui/material/MenuList';
import Popper from '@mui/material/Popper';
import Paper from '@mui/material/Paper';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import Divider from '@mui/material/Divider';
import { useId, useState, type ReactNode } from 'react';
export type MenuAction = Readonly<{
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  selected?: boolean;
}>;

export type MenuChoice = Readonly<{
  id: string;
  label: string;
  icon?: ReactNode;
  value: string;
  selectedId: string;
  options: readonly MenuAction[];
}>;

export type MenuGroup = Readonly<{
  id: string;
  label: string;
  items: readonly (MenuAction | MenuChoice)[];
}>;

export type MenuButtonProps = Readonly<
  {
    label: ReactNode;
    ariaLabel: string;
    header?: ReactNode;
    submenuLayout?: 'adjacent' | 'stacked';
    defaultOpen?: boolean;
    isOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Trigger 控件高度：`sm` 用于工具条内与其它 sm 控件同排。 */
    triggerSize?: 'sm' | 'md' | 'lg';
    triggerVariant?: 'standard' | 'primary' | 'icon';
    onAction: (id: string) => void;
    selectedId?: string;
  } & (
    | { items: readonly MenuAction[]; groups?: never }
    | { items?: never; groups: readonly MenuGroup[] }
  )
>;

export function MenuButton({
  label,
  ariaLabel,
  items,
  groups,
  header,
  submenuLayout = 'adjacent',
  defaultOpen = false,
  isOpen,
  onOpenChange,
  triggerSize = 'md',
  triggerVariant = 'standard',
  onAction,
  selectedId,
}: MenuButtonProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = isOpen !== undefined;
  const open = controlled ? isOpen : internalOpen;
  const id = useId();
  const [choice, setChoice] = useState<{ item: MenuChoice; anchor: HTMLElement } | null>(null);
  const setOpen = (next: boolean) => {
    if (!next) setChoice(null);
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const act = (id: string) => {
    setOpen(false);
    onAction(id);
  };
  const renderAction = (item: MenuAction, selectable = false, selectedId?: string) => {
    const isSelectable = selectable || item.selected !== undefined;
    const isSelected = Boolean(item.selected || (selectable && item.id === selectedId));
    return (
      <MenuItem
        key={item.id}
        disabled={item.disabled}
        onClick={() => act(item.id)}
        role={isSelectable ? 'menuitemradio' : 'menuitem'}
        aria-checked={isSelectable ? isSelected : undefined}
        selected={isSelected}
        className={`ui-option ${item.tone === 'danger' ? 'text-danger' : ''}`}
      >
        {item.icon ? (
          <span aria-hidden="true" className="flex size-icon shrink-0 items-center">
            {item.icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{item.label}</span>
          {item.description ? (
            <span className="mt-0.5 block text-xs text-ink-muted">{item.description}</span>
          ) : null}
        </span>
        {isSelected ? (
          <span aria-hidden="true" className="shrink-0 font-semibold text-brand">
            ✓
          </span>
        ) : null}
      </MenuItem>
    );
  };
  const renderItem = (item: MenuAction | MenuChoice) =>
    'options' in item ? (
      <MenuItem
        key={item.id}
        aria-haspopup="menu"
        aria-expanded={choice?.item.id === item.id}
        onClick={(event) => setChoice({ item, anchor: event.currentTarget })}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setChoice({ item, anchor: event.currentTarget });
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            setChoice({ item, anchor: event.currentTarget });
          }
        }}
        className="ui-option"
      >
        {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
        <span className="flex-1">{item.label}</span>
        <span className="text-xs text-ink-muted">{item.value}</span>
        <span aria-hidden="true">›</span>
      </MenuItem>
    ) : (
      renderAction(item)
    );
  const entries = groups
    ? groups.flatMap((group, index) => [
        ...(index ? [<Divider key={group.id + '-divider'} />] : []),
        <ListSubheader
          key={group.id + '-header'}
          component="div"
          disableSticky
          className="px-3 py-1.5 text-xs font-semibold leading-5 text-ink-muted"
        >
          {index === 0 && header ? (
            <div className="mb-2 border-b border-border pb-2.5">{header}</div>
          ) : null}
          <span>{group.label}</span>
        </ListSubheader>,
        ...group.items.map(renderItem),
      ])
    : (items ?? []).map((item) => renderAction(item, selectedId !== undefined, selectedId));
  return (
    <>
      <Button
        ref={setAnchor}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        variant={
          triggerVariant === 'primary'
            ? 'contained'
            : triggerVariant === 'icon'
              ? 'text'
              : 'outlined'
        }
        className={`ui-overlay-trigger ${triggerVariant === 'primary' ? 'ui-overlay-trigger-primary' : ''} ${triggerSize === 'sm' ? 'min-h-control-sm' : triggerSize === 'lg' ? 'ui-icon-action-lg h-control-lg min-h-control-lg' : ''} ${triggerVariant === 'icon' ? `${triggerSize === 'lg' ? 'size-control-lg min-w-control-lg' : 'size-control-sm min-w-control-sm'} border-0 bg-transparent px-0` : ''}`}
      >
        {label}
      </Button>
      <Menu
        id={id}
        disableEnforceFocus={Boolean(choice)}
        open={Boolean(open && anchor)}
        anchorEl={anchor}
        onClose={(_, reason) => {
          if (reason === 'escapeKeyDown' && choice) {
            const target = choice.anchor;
            setChoice(null);
            target.focus();
          } else setOpen(false);
        }}
        slotProps={{
          paper: {
            className: `ui-overlay-surface ui-menu-surface min-w-56 ${groups ? 'ui-menu-surface-grouped' : ''}`,
            role: 'region',
            'aria-label': ariaLabel,
            tabIndex: 0,
          },
          list: { 'aria-label': ariaLabel },
        }}
      >
        {entries}
      </Menu>
      <Popper
        open={Boolean(open && choice)}
        anchorEl={choice?.anchor}
        placement={submenuLayout === 'stacked' ? 'bottom-start' : 'right-start'}
        sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
      >
        <Paper className="ui-overlay-surface ui-menu-surface min-w-44">
          <MenuList
            autoFocusItem
            aria-label={choice?.item.label}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'ArrowLeft') {
                event.preventDefault();
                event.stopPropagation();
                const target = choice?.anchor;
                setChoice(null);
                target?.focus();
              } else if (event.key === 'Tab') {
                event.preventDefault();
                setOpen(false);
              }
            }}
          >
            {choice?.item.options.map((item) => renderAction(item, true, choice.item.selectedId))}
          </MenuList>
        </Paper>
      </Popper>
    </>
  );
}
