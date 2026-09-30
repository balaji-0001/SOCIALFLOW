import { useSyncExternalStore } from 'react';

/*
 * Colour theme for the whole site. "dark" is SocialFlow Aurora, "light" is the original light theme, "system" follows the
 * device. The choice is stored in this browser only. index.html applies it before the first paint so there is no flash.
 */

export type ThemeChoice = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'aurora' | 'light';

const KEY = 'socialflow:theme';
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function readChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

export function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') return media?.matches ? 'aurora' : 'light';
  return choice === 'light' ? 'light' : 'aurora';
}

export function applyTheme(choice: ThemeChoice = readChoice()): void {
  const resolved = resolve(choice);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.background = resolved === 'aurora' ? '#0b0b0e' : '#f9fafc';
  document.documentElement.style.colorScheme = resolved === 'aurora' ? 'dark' : 'light';
}

export function setTheme(choice: ThemeChoice): void {
  try { window.localStorage.setItem(KEY, choice); } catch { /* the choice just isn't remembered */ }
  applyTheme(choice);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onMedia = () => { if (readChoice() === 'system') { applyTheme('system'); listener(); } };
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) { applyTheme(); listener(); } };
  media?.addEventListener('change', onMedia);
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); media?.removeEventListener('change', onMedia); window.removeEventListener('storage', onStorage); };
};

/** The saved choice and what it currently resolves to. */
export function useTheme(): { choice: ThemeChoice; resolved: ResolvedTheme; set: (choice: ThemeChoice) => void; toggle: () => void } {
  const choice = useSyncExternalStore(subscribe, readChoice, () => 'dark' as ThemeChoice);
  const resolved = resolve(choice);
  return { choice, resolved, set: setTheme, toggle: () => setTheme(resolved === 'aurora' ? 'light' : 'dark') };
}
