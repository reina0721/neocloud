'use client';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import type { MouseEvent } from 'react';
import type { MobileNavigationItem } from './mobile-navigation';
export default function MobileNavigationSurface({
  label,
  value,
  items,
  onSelect,
}: Readonly<{
  label: string;
  value?: string | undefined;
  items: readonly MobileNavigationItem[];
  onSelect: (id: string) => void;
}>) {
  return (
    <BottomNavigation
      component="nav"
      aria-label={label}
      showLabels
      value={value}
      className="ui-mobile-navigation"
    >
      {items.map((item) => (
        <BottomNavigationAction
          key={item.id}
          value={item.id}
          label={item.label}
          icon={
            <span aria-hidden="true" className="size-5">
              {item.icon}
            </span>
          }
          {...(item.href
            ? {
                component: 'a',
                href: item.href,
                'aria-current': value === item.id ? ('page' as const) : undefined,
              }
            : {})}
          onClick={(event: MouseEvent<HTMLElement>) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            onSelect(item.id);
          }}
          sx={{
            minWidth: 0,
            padding: '0.5rem 0.25rem',
            color: 'var(--color-ink-muted)',
            '&.Mui-selected': { color: 'var(--color-brand)' },
            '& .MuiBottomNavigationAction-label': { fontSize: '0.6875rem', marginTop: '0.25rem' },
          }}
        />
      ))}
    </BottomNavigation>
  );
}
