import MuiAvatar from '@mui/material/Avatar';
import type { ReactNode } from 'react';
export type AvatarPresence = Readonly<{
  label: string;
  tone: 'neutral' | 'success' | 'warning';
}>;

export type AvatarProps = Readonly<{
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
  presence?: AvatarPresence;
}>;

function initials(name: string) {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}` : name.slice(0, 2))
    .toLocaleUpperCase()
    .slice(0, 2);
}

export function Avatar({ name, src, size = 'md', presence }: AvatarProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <MuiAvatar
        src={src}
        alt={name}
        aria-label={name}
        className={`shrink-0 bg-surface-inset text-ink ${size === 'lg' ? 'size-12 text-base' : size === 'sm' ? 'size-7 text-xs' : 'size-9 text-sm'}`}
      >
        {initials(name)}
      </MuiAvatar>
      {presence ? (
        <span
          role="img"
          aria-label={presence.label}
          className={`absolute bottom-0 right-0 rounded-full border-2 border-surface ${size === 'lg' ? 'size-3.5' : size === 'sm' ? 'size-2.5' : 'size-3'} ${presence.tone === 'success' ? 'bg-success' : presence.tone === 'warning' ? 'bg-warning' : 'bg-ink-muted'}`}
        />
      ) : null}
    </span>
  );
}
export type UserIdentityProps = Readonly<{
  name: string;
  description?: ReactNode;
  avatarSrc?: string;
  avatarSize?: 'sm' | 'md' | 'lg';
  presence?: AvatarPresence;
}>;

export function UserIdentity({
  name,
  description,
  avatarSrc,
  avatarSize = 'md',
  presence,
}: UserIdentityProps) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-3">
      <Avatar
        name={name}
        size={avatarSize}
        {...(avatarSrc ? { src: avatarSrc } : {})}
        {...(presence ? { presence } : {})}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{name}</span>
        {description ? (
          <span className="mt-0.5 block truncate text-xs text-ink-muted">{description}</span>
        ) : null}
      </span>
    </span>
  );
}
