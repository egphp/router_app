'use client';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Like useState, but persisted in localStorage under the given key.
 *
 * Returns the initial value on the very first render (so server-side render +
 * the first client render match — required to avoid React hydration errors),
 * then on mount reads the saved value and applies it. Subsequent writes are
 * persisted automatically. Safe for SSR — only touches localStorage in the browser.
 */
export function usePersistedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const hydrated = useRef(false);

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // ignore corrupt or unavailable storage
    }
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on change — but only AFTER hydration, so we don't clobber the saved
  // value with `initial` during the brief moment before useEffect reads from storage.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota / private-mode errors
    }
  }, [key, value]);

  return [value, setValue];
}
