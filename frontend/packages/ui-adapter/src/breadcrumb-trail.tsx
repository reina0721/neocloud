'use client';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import MuiLink from '@mui/material/Link';
import type { MouseEvent, ReactNode } from 'react';
export type BreadcrumbItem = Readonly<{
  id: string;
  label: string;
  content?: ReactNode;
  href?: string;
  disabled?: boolean;
  icon?: ReactNode;
  onNavigate?: () => void;
}>;

export type BreadcrumbTrailProps = Readonly<{
  label: string;
  items: readonly BreadcrumbItem[];
}>;

export function BreadcrumbTrail({ label, items }: BreadcrumbTrailProps) {
  return (
    <Breadcrumbs
      aria-label={label}
      expandText={label}
      maxItems={4}
      separator="/"
      className="ui-breadcrumbs text-sm text-ink-muted"
    >
      {items.map((item, index) =>
        index === items.length - 1 ? (
          <span
            key={item.id}
            className="inline-flex min-w-0 items-center gap-2 font-medium text-ink"
          >
            {item.icon ? (
              <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
                {item.icon}
              </span>
            ) : null}
            <span aria-current="page" className="max-w-60 truncate">
              {item.label}
            </span>
          </span>
        ) : item.content ? (
          <span key={item.id}>{item.content}</span>
        ) : item.href && !item.disabled ? (
          <MuiLink
            key={item.id}
            href={item.href}
            className="inline-flex min-w-0 items-center gap-2 text-ink-muted"
            underline="hover"
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (
                !item.onNavigate ||
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              item.onNavigate();
            }}
          >
            {item.icon ? (
              <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
                {item.icon}
              </span>
            ) : null}
            <span className="max-w-40 truncate">{item.label}</span>
          </MuiLink>
        ) : (
          <span key={item.id} aria-disabled={item.disabled}>
            {item.label}
          </span>
        ),
      )}
    </Breadcrumbs>
  );
}
