/**
 * @fileoverview Which session and which case a window is looking at are facts
 * about THAT WINDOW.
 *
 * localStorage is shared by every tab and window of one origin, so two windows
 * side by side — the whole point of opening a second one — overwrote each
 * other's choice: window B's selectSession() wrote `codeman-active-session`,
 * window A read it back on its next reconnect and jumped to B's session. The
 * same applied to the case row the moment it started remembering a selection.
 *
 * The fix is a two-store accessor, and both halves matter:
 *
 *  - sessionStorage holds the LIVE value and is per window, surviving reload
 *    and session restore where an in-memory field would not;
 *  - localStorage keeps being written as the SEED a brand-new window starts
 *    from, which is exactly what shipped before — drop it and opening a fresh
 *    window would land on the welcome screen instead of the session you left.
 *
 * Losing either half is silent: with no seed the restore just stops happening,
 * with no per-window store the windows go back to fighting. Both directions are
 * pinned below, along with the separate-guard rule — sessionStorage can be
 * unavailable while localStorage works (and the reverse), and neither may take
 * the other down with it.
 *
 * Builds a JSDOM window in-test under the default node env, same shape as
 * test/case-tabs.test.ts. Do NOT declare a per-file jsdom environment: it
 * externalizes node:fs under vite and the readFileSync calls below stop
 * working. ⚠ Do not name that directive in a comment either, vitest matches the
 * string anywhere in the file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const APP = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const PANELS_UI = readFileSync(new URL('../src/web/public/panels-ui.js', import.meta.url), 'utf-8');

const SESSION_KEY = 'codeman-active-session';
const CASE_KEY = 'codeman-active-case';

interface WindowState {
  readWindowState(key: string): string | null;
  writeWindowState(key: string, value: string): void;
  clearWindowState(key: string): void;
  _persistActiveCaseTab(value: string): void;
}

/** One browser window: its own sessionStorage, a localStorage we can pre-seed. */
function openWindow(seed: Record<string, string> = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & typeof globalThis & { __state: WindowState };
  for (const [key, value] of Object.entries(seed)) win.localStorage.setItem(key, value);

  (win as unknown as { eval: (s: string) => void }).eval(
    [
      `var MobileDetection = { getDeviceType: () => 'desktop', isHandheldDevice: () => false,
         isMobile: () => false, isTouchDevice: () => false };`,
      CONSTANTS,
      APP,
      // The accessors are module-level functions, deliberately not on the class:
      // panels-ui.js calls them too. Handed out here rather than re-implemented.
      `window.__state = { readWindowState, writeWindowState, clearWindowState,
         _persistActiveCaseTab: CodemanApp.prototype._persistActiveCaseTab };`,
    ].join('\n')
  );
  return { dom, win, state: win.__state };
}

describe('per-window UI state', () => {
  it('writes both stores and reads this window first', () => {
    const { win, state } = openWindow();
    state.writeWindowState(SESSION_KEY, 'sess-a');
    expect(win.sessionStorage.getItem(SESSION_KEY)).toBe('sess-a');
    expect(win.localStorage.getItem(SESSION_KEY)).toBe('sess-a');

    // A stale seed from another window must never win over this window's own
    // choice — that is the bug this whole mechanism exists for.
    win.localStorage.setItem(SESSION_KEY, 'sess-b');
    expect(state.readWindowState(SESSION_KEY)).toBe('sess-a');
  });

  it('still restores a brand-new window from the seed, exactly as before', () => {
    const { state } = openWindow({ [SESSION_KEY]: 'sess-a', [CASE_KEY]: 'alpha' });
    expect(state.readWindowState(SESSION_KEY)).toBe('sess-a');
    expect(state.readWindowState(CASE_KEY)).toBe('alpha');
  });

  it("keeps two windows out of each other's way", () => {
    const a = openWindow();
    a.state.writeWindowState(SESSION_KEY, 'sess-a');
    a.state.writeWindowState(CASE_KEY, 'alpha');

    // Window B opens later: it seeds from A, then picks its own project.
    const b = openWindow({
      [SESSION_KEY]: a.win.localStorage.getItem(SESSION_KEY)!,
      [CASE_KEY]: a.win.localStorage.getItem(CASE_KEY)!,
    });
    expect(b.state.readWindowState(CASE_KEY)).toBe('alpha');
    b.state.writeWindowState(SESSION_KEY, 'sess-b');
    b.state.writeWindowState(CASE_KEY, 'beta');

    // A's next reconnect reads its own store, not B's.
    expect(a.state.readWindowState(SESSION_KEY)).toBe('sess-a');
    expect(a.state.readWindowState(CASE_KEY)).toBe('alpha');
  });

  it('clears both stores, so a forgotten session cannot come back as a seed', () => {
    const { win, state } = openWindow({ [SESSION_KEY]: 'sess-a' });
    state.writeWindowState(SESSION_KEY, 'sess-a');
    state.clearWindowState(SESSION_KEY);
    expect(win.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(win.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(state.readWindowState(SESSION_KEY)).toBeNull();
  });

  it('survives one store throwing without taking the other down', () => {
    const { win, state } = openWindow();
    const broken = {
      getItem() {
        throw new Error('storage disabled');
      },
      setItem() {
        throw new Error('storage disabled');
      },
      removeItem() {
        throw new Error('storage disabled');
      },
    };
    Object.defineProperty(win, 'sessionStorage', { value: broken, configurable: true });

    state.writeWindowState(SESSION_KEY, 'sess-a');
    expect(win.localStorage.getItem(SESSION_KEY)).toBe('sess-a');
    expect(state.readWindowState(SESSION_KEY)).toBe('sess-a');
    state.clearWindowState(SESSION_KEY);
    expect(win.localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('routes the case row through the same accessor', () => {
    const { win, state } = openWindow();
    state._persistActiveCaseTab('alpha');
    expect(win.sessionStorage.getItem(CASE_KEY)).toBe('alpha');
    expect(win.localStorage.getItem(CASE_KEY)).toBe('alpha');
  });

  it('leaves no direct localStorage access to either key behind', () => {
    // A single missed call site is the whole bug back: one window writing the
    // shared key directly re-syncs every other window on its next reconnect.
    for (const source of [APP, PANELS_UI]) {
      expect(source).not.toMatch(/localStorage\.(get|set|remove)Item\('codeman-active-(session|case)'/);
    }
    expect(APP).toContain(`writeWindowState('${SESSION_KEY}', sessionId)`);
  });
});
