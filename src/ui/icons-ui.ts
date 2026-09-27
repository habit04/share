/**
 * Additional original line-art icons for the chrome / dialogs owned by the UI layer.
 * Kept in a separate module so the tail of `icons.ts` stays free for other feature areas;
 * importing this module registers them into the shared `icons` record.
 */
import { icons } from './icons';

const wrap = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

Object.assign(icons, {
  history: wrap('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path class="ac" d="M4 4v4h4"/><path d="M12 8v4l3 2"/>'),
  command: wrap('<path d="M5 7l5 5-5 5"/><path class="ac" d="M12 17h7"/>'),
  palette: wrap('<rect x="3" y="4" width="18" height="16"/><path d="M3 9h18"/><path class="ac" d="M7 13h4v4H7zM13 13h4v4h-4z"/>'),
  unlock: wrap('<rect x="6" y="11" width="12" height="9"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>'),
  eye: wrap('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeoff: wrap('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><path class="ac" d="M4 4l16 16"/>'),
  sun: wrap('<circle cx="12" cy="12" r="4"/><path class="ac" d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  options: wrap('<path d="M4 7h10M4 12h16M4 17h8"/><circle class="ac" cx="17" cy="7" r="2"/><circle class="ac" cx="15" cy="17" r="2"/>'),
  keyboard: wrap('<rect x="2" y="6" width="20" height="12" rx="1"/><path d="M6 10h1M10 10h1M14 10h1M18 10h1M6 14h1M10 14h4M18 14h1"/>'),
  exit: wrap('<path d="M10 4H4v16h6"/><path class="ac" d="M14 8l4 4-4 4M18 12H9"/>'),
  export: wrap('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path class="ac" d="M12 9v8M9 14l3 3 3-3"/>'),
  qp: wrap('<rect x="3" y="5" width="18" height="14"/><path class="ac" d="M7 9h6M7 12h10M7 15h4"/>'),
  clean: wrap('<rect x="3" y="4" width="18" height="16"/><path class="ac" d="M7 8l10 8M17 8L7 16"/>'),
  isolate: wrap('<circle cx="12" cy="12" r="3"/><path d="M4 4l4 4M20 4l-4 4M4 20l4-4M20 20l-4-4" stroke-dasharray="2 2"/>'),
  match: wrap('<path d="M4 18h16"/><path d="M4 6h8"/><path class="ac" d="M14 6h6M17 3v6"/>'),
  current: wrap('<path class="ac" d="M12 3l9 5-9 5-9-5z"/><path d="M5 17l7 4 7-4"/><path d="M12 13v8"/>'),
  swatch: wrap('<rect x="4" y="4" width="16" height="16" fill="currentColor" stroke="none"/>'),
  linetype: wrap('<path d="M3 8h18"/><path d="M3 12h5M11 12h5M19 12h2"/><path class="ac" d="M3 16h3M9 16h1M13 16h3M19 16h2"/>'),
  lineweight: wrap('<path d="M3 7h18" stroke-width="1"/><path d="M3 12h18" stroke-width="2.2"/><path class="ac" d="M3 18h18" stroke-width="3.6"/>'),
  tab: wrap('<path d="M3 8h8l2-3h8v14H3z"/><path class="ac" d="M3 8h18"/>'),
  coords: wrap('<path d="M4 20V4M4 20h16"/><circle class="ac" cx="13" cy="11" r="2"/><path d="M13 11V20M13 11H4" stroke-dasharray="2 2"/>'),
  workspace: wrap('<rect x="3" y="4" width="18" height="16"/><path d="M3 9h18M9 9v11"/>'),
  autosave: wrap('<path d="M4 4h13l3 3v13H4z"/><path class="ac" d="M12 9v6M9 12l3 3 3-3"/>'),
  recover: wrap('<path d="M6 3h8l4 4v14H6z"/><path class="ac" d="M9 15l2 2 4-4"/>'),
  drag: wrap('<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>'),
  autohide: wrap('<path d="M4 4v16"/><path class="ac" d="M9 12h11M16 8l4 4-4 4"/>'),
  angle: wrap('<path d="M4 20h16L4 6z"/><path class="ac" d="M11 20a7 7 0 0 0-3-6"/>'),
  scaleList: wrap('<path d="M3 17L17 3"/><path d="M3 21h18M21 3v18"/><path class="ac" d="M7 17l2-2M11 13l2-2"/>'),
});
