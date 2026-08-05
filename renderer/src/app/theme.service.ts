import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'custos.theme';

/**
 * Owns the app's light/dark/system theme. Writes `data-theme` on <html>, which
 * flips every design token in tokens.css at once. "System" removes the attribute
 * and lets the OS preference (via the media query in tokens.css) take over.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>('system');
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    this.media.addEventListener('change', () => {
      if (this.mode() === 'system') this.apply();
    });
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    this.setMode(saved ?? 'system');
  }

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    this.apply();
  }

  /** The concrete theme in effect right now. */
  get resolved(): 'light' | 'dark' {
    if (this.mode() === 'system') return this.media.matches ? 'dark' : 'light';
    return this.mode() as 'light' | 'dark';
  }

  private apply(): void {
    const root = document.documentElement;
    if (this.mode() === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.mode());
  }
}
