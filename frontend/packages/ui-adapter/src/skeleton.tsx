'use client';
import MuiSkeleton from '@mui/material/Skeleton';
export type SkeletonProps = Readonly<{
  className?: string;
}>;

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <MuiSkeleton
      data-slot="skeleton"
      variant="rounded"
      animation="pulse"
      className={`block rounded-control bg-surface-muted ${className}`}
      aria-hidden="true"
    />
  );
}
