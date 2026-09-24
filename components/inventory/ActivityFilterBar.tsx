import React from 'react';
import { Check, Download, RotateCcw } from 'lucide-react';

interface ActivityFilterBarProps {
  fromDate: string;
  toDate: string;
  onChangeFrom: (value: string) => void;
  onChangeTo: (value: string) => void;
  rightSideControls?: React.ReactNode;
  onApply: () => void;
  onReset: () => void;
  onExport: () => void;
  exportDisabled?: boolean;
}

const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';

export const ActivityFilterBar: React.FC<ActivityFilterBarProps> = ({
  fromDate,
  toDate,
  onChangeFrom,
  onChangeTo,
  rightSideControls,
  onApply,
  onReset,
  onExport,
  exportDisabled = false,
}) => (
  <div className="mt-3 flex flex-wrap items-end gap-2">
    <div className="w-full sm:w-[210px]">
      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">From</label>
      <input
        type="date"
        value={fromDate}
        onChange={(event) => onChangeFrom(event.target.value)}
        className={filterFieldClass}
      />
    </div>
    <div className="w-full sm:w-[210px]">
      <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">To</label>
      <input
        type="date"
        value={toDate}
        onChange={(event) => onChangeTo(event.target.value)}
        className={filterFieldClass}
      />
    </div>
    {rightSideControls && (
      <div className="w-full sm:min-w-[220px] sm:flex-1">
        {rightSideControls}
      </div>
    )}
    <div className="ml-auto flex w-full sm:w-auto items-center justify-end gap-2">
      <button
        type="button"
        onClick={onApply}
        title="Confirm"
        aria-label="Confirm filters"
        className="inline-flex min-h-11 px-5 whitespace-nowrap items-center justify-center border border-indigo-300 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-semibold"
      >
        <Check className="w-4 h-4 mr-1.5" />
        Apply
      </button>
      <button
        type="button"
        onClick={onReset}
        title="Reset filters"
        aria-label="Clear filters and show all"
        className="inline-flex w-11 min-h-11 items-center justify-center border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
      >
        <RotateCcw className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={onExport}
        disabled={exportDisabled}
        title="Download CSV"
        aria-label="Download CSV"
        className="inline-flex w-11 min-h-11 items-center justify-center border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        <Download className="w-4 h-4" />
      </button>
    </div>
  </div>
);
