'use client';
import MuiPagination from '@mui/material/Pagination';
export type PaginationControlProps = Readonly<{
  label: string;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  previousLabel: string;
  nextLabel: string;
  getPageLabel: (page: number) => string;
  disabled?: boolean;
}>;

export function PaginationControl({
  label,
  page,
  totalPages,
  onPageChange,
  previousLabel,
  nextLabel,
  getPageLabel,
  disabled = false,
}: PaginationControlProps) {
  const total = Math.max(1, totalPages);
  return (
    <MuiPagination
      aria-label={label}
      page={Math.min(Math.max(1, page), total)}
      count={total}
      disabled={disabled}
      onChange={(_, value) => onPageChange(value)}
      getItemAriaLabel={(type, value) =>
        type === 'previous'
          ? previousLabel
          : type === 'next'
            ? nextLabel
            : value
              ? getPageLabel(value)
              : label
      }
      className="max-w-full overflow-x-auto"
    />
  );
}
