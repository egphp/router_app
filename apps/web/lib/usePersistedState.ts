'use client';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Like useState, but persisted in localStorage under the given key.
 * On first render returns `initial`; once mounted, loads any saved value
 * and syncs subsequent writes. Safe for SSR — only touches localStorage in the browser.
 */
export function usePersistedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // ignore corrupt or unavailable storage
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on change
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota / private-mode errors
    }
  }, [key, value]);

  return [value, setValue];
}
