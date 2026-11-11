/* Themes: Terminal (amber on black, the default), Dark and Light. Applied as early as possible so the sign-in screen matches; the Settings page and the top-bar
 * button change it. The choice is global (not per user). Version 3 of the preference moved everyone to Terminal once; after that the choice is theirs. */
import { store } from './lib.js';

export const THEMES = [['terminal', 'Terminal (amber on black)'], ['dark', 'Dark'], ['light', 'Light']];
const VERSION = 3;

export function currentTheme() {
  let v = store.get('ml.theme', null);
  if (store.get('ml.themeV', 0) < VERSION) { v = 'terminal'; store.set('ml.theme', v); store.set('ml.themeV', VERSION); }
  return THEMES.some((t) => t[0] === v) ? v : 'terminal';
}

export function applyTheme(t, save = true) {
  document.documentElement.dataset.theme = t; if (save) store.set('ml.theme', t);
  document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
}

applyTheme(currentTheme(), false);
