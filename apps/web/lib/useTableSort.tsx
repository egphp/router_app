'use client';
import * as React from 'react';
import { useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import { usePersistedState } from './usePersistedState';

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> { key: K; dir: SortDir; }

/**
 * Persistent multi-column sort state. Each table gets its own storageKey so
 * preferences live independently across tables and survive reloads.
 *
 * Click behavior:
 *  - Click a new column → sort by it (uses its `defaultDir`, default 'desc')
 *  - Click the same column → reverse direction
 *  - Numeric/date columns default to 'desc' (largest first)
 *  - Text columns default to 'asc' (A→Z)
 */
export function useTableSort<K extends string>(
  storageKey: string,
  initial: SortState<K>,
) {
  const [state, setState] = usePersistedState<SortState<K>>(storageKey, initial);

  const onSort = useCallback((key: K, defaultDir: SortDir = 'desc') => {
    setState((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      }
      return { key, dir: defaultDir };
    });
  }, [setState]);

  /** Force a specific (key, dir) — used by composite columns that own multiple keys. */
  const setSort = useCallback((key: K, dir: SortDir) => {
    setState({ key, dir });
  }, [setState]);

  /** Indicator helper for headers: returns " ↑" / " ↓" / "" */
  const indicator = useCallback((key: K): string => {
    if (state.key !== key) return '';
    return state.dir === 'asc' ? ' ↑' : ' ↓';
  }, [state]);

  return useMemo(() => ({ sort: state, onSort, setSort, indicator }), [state, onSort, setSort, indicator]);
}

/** Sort a number ascending or descending based on dir. */
export function sortNum(a: number, b: number, dir: SortDir): number {
  return dir === 'asc' ? a - b : b - a;
}

/** Sort a string locale-aware. */
export function sortStr(a: string, b: string, dir: SortDir): number {
  const c = (a || '').localeCompare(b || '');
  return dir === 'asc' ? c : -c;
}

/** Generic sortable <th>. Click toggles direction; first click uses defaultDir. */
export function SortHeader<K extends string>({
  label, k, sort, onSort, indicator, align = 'right', defaultDir = 'desc', className, hint, children,
}: {
  label?: string;
  k: K;
  sort: SortState<K>;
  onSort: (k: K, d?: SortDir) => void;
  indicator: (k: K) => string;
  align?: 'left' | 'right' | 'center';
  defaultDir?: SortDir;
  className?: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <th
      onClick={() => onSort(k, defaultDir)}
      title={hint ?? (label ? `Sort by ${label}` : 'Sort')}
      className={clsx(
        'px-3 py-2 cursor-pointer select-none hover:text-slate-200 transition',
        align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right',
        sort.key === k && 'text-accent',
        className,
      )}
    >
      {children ?? label}{indicator(k)}
    </th>
  );
}
