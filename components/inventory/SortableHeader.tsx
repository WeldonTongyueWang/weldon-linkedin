import React from 'react';

export type SortDirection = 'asc' | 'desc';

interface SortableHeaderProps {
  label: string;
  sortKey: string;
  activeSortKey: string;
  sortDir: SortDirection;
  onChange: (sortKey: string, sortDir: SortDirection) => void;
  className?: string;
}

export const SortableHeader: React.FC<SortableHeaderProps> = ({
  label,
  sortKey,
  activeSortKey,
  sortDir,
  onChange,
  className,
}) => {
  const isActive = activeSortKey === sortKey;
  const ariaSort = isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
  const indicator = isActive ? (sortDir === 'desc' ? '↓' : '↑') : '↕';

  return (
    <th className={className} aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onChange(sortKey, isActive && sortDir === 'desc' ? 'asc' : 'desc')}
        className="inline-flex items-center gap-1 hover:text-slate-700"
      >
        {label}
        <span>{indicator}</span>
      </button>
    </th>
  );
};
