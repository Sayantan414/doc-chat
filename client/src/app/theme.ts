import { Injectable, effect, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'docchat-theme';

// Light, dark, or follow the OS. The choice is saved in localStorage; the
// inline script in index.html applies it before Angular starts (no flash).
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(readPreference());

  // matchMedia is missing in some environments (jsdom in the unit tests).
  private readonly media =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  private readonly systemDark = signal(this.media?.matches ?? false);

  constructor() {
    // Follow OS changes live while the preference is "system".
    this.media?.addEventListener('change', (e) => this.systemDark.set(e.matches));

    effect(() => {
      const pref = this.preference();
      const dark = pref === 'dark' || (pref === 'system' && this.systemDark());
      const root = document.documentElement;
      // Switch all colors at once: without this, elements with transition-colors
      // fade at their own pace and the page looks half-themed for a moment.
      root.classList.add('theme-switching');
      root.classList.toggle('dark', dark);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => root.classList.remove('theme-switching')),
      );
      try {
        localStorage.setItem(STORAGE_KEY, pref);
      } catch {
        // private mode or blocked storage: the choice just isn't remembered
      }
    });
  }

  // light -> dark -> system -> light
  cycle() {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    this.preference.update((p) => order[(order.indexOf(p) + 1) % order.length]);
  }
}

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // ignore
  }
  return 'system';
}
