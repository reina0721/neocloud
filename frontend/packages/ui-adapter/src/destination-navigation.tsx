'use client';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import type { MouseEvent, ReactNode } from 'react';

function follow(event: MouseEvent<HTMLElement>, onNavigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  onNavigate();
}
export type NavigationItemProps = Readonly<{
  href: string;
  label: string;
  icon: ReactNode;
  selected?: boolean;
  compact?: boolean;
  onNavigate: () => void;
}>;

/** 目的地采用真正的 Material ListItemButton；链接修饰键保持浏览器原生行为。 */
export function NavigationItem({
  href,
  label,
  icon,
  selected = false,
  compact = false,
  onNavigate,
}: NavigationItemProps) {
  const item = (
    <ListItemButton
      component="a"
      href={href}
      selected={selected}
      aria-current={selected ? 'page' : undefined}
      aria-label={label}
      className="ui-navigation-item"
      data-compact={compact}
      onClick={(event) => follow(event, onNavigate)}
    >
      <ListItemIcon className="ui-navigation-item-icon">
        <span aria-hidden="true">{icon}</span>
      </ListItemIcon>
      {compact ? null : (
        <ListItemText
          primary={label}
          slotProps={{ primary: { className: 'ui-navigation-item-label' } }}
        />
      )}
    </ListItemButton>
  );
  return compact ? (
    <Tooltip title={label} placement="right">
      {item}
    </Tooltip>
  ) : (
    item
  );
}
export type NavigationTab = Readonly<{ id: string; href: string; label: string; icon?: ReactNode }>;
/** Material Nav Tabs 选择真实目的地，不创建第二套路由或内容面板。 */
export function NavigationTabs({
  label,
  items,
  value,
  onNavigate,
}: Readonly<{
  label: string;
  items: readonly NavigationTab[];
  value?: string | undefined;
  onNavigate: (id: string) => void;
}>) {
  return (
    <Tabs
      component="nav"
      role="navigation"
      value={value ?? false}
      variant="scrollable"
      scrollButtons="auto"
      className="ui-navigation-tabs"
      slotProps={{ root: { 'aria-label': label }, list: { role: 'presentation' } }}
    >
      {items.map((item) => (
        <Tab
          key={item.id}
          component="a"
          role="link"
          tabIndex={0}
          value={item.id}
          href={item.href}
          label={item.label}
          icon={
            item.icon ? (
              <span aria-hidden="true" className="ui-navigation-tab-icon">
                {item.icon}
              </span>
            ) : undefined
          }
          iconPosition="start"
          aria-current={value === item.id ? 'page' : undefined}
          aria-selected={undefined}
          onClick={(event) => follow(event, () => onNavigate(item.id))}
        />
      ))}
    </Tabs>
  );
}
