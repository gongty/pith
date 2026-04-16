import { $ } from './utils.js';

export function initTheme() {
  if (localStorage.getItem('kb-theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  updThemeIcon();
}

export function toggleTheme() {
  const d = document.documentElement.getAttribute('data-theme') === 'dark';
  if (d) { document.documentElement.removeAttribute('data-theme'); localStorage.setItem('kb-theme', 'light'); }
  else { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('kb-theme', 'dark'); }
  updThemeIcon();
  // re-render is handled by app.js via window.toggleTheme
}

function updThemeIcon() {
  const d = document.documentElement.getAttribute('data-theme') === 'dark';
  $('themeIcon').innerHTML = d
    ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>'
    : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
}
