/**
 * @fileoverview Re-asserting this client's terminal size when its window comes back.
 *
 * All clients of a session share ONE PTY, so a phone or a second browser window
 * can leave it at a size this window cannot render. `onTabVisible()` re-fits and
 * re-posts the size for exactly that reason, but it only ran on
 * `visibilitychange` — and a second window on the same desktop becomes the one
 * you are looking at WITHOUT that event firing (both windows stay visible). The
 * `focus` listener closes that hole.
 *
 * The server half is pinned in test/session-resize-arbitration.test.ts (the
 * forced-resize probe) plus the `_ptyCols` seeding asserted at the bottom here.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(new URL('../src/web/public/notification-manager.js', import.meta.url), 'utf8');
const SESSION_SOURCE = readFileSync(new URL('../src/session.ts', import.meta.url), 'utf8');

const openWindows: JSDOM[] = [];

type App = {
  activeSessionId: string | null;
  fitAddon: { fit: ReturnType<typeof vi.fn> };
  sendResize: ReturnType<typeof vi.fn>;
  sessions: Map<unknown, unknown>;
};

function loadManager() {
  const dom = new JSDOM('<!doctype html><body><span id="notifBadge"></span><div id="notifList"></div></body>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  openWindows.push(dom);
  // JSDOM has no viewport, so document.hidden is true out of the box — the
  // opposite of the browser case this covers.
  Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  win.MobileDetection = { getDeviceType: () => 'desktop' };
  win.STUCK_THRESHOLD_DEFAULT_MS = 600_000;
  win.GROUPING_TIMEOUT_MS = 5_000;
  win.NOTIFICATION_LIST_CAP = 100;
  win.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame;

  win.eval(`
    ${SOURCE}
    window.__testNotificationManager = NotificationManager;
  `);
  const NotificationManager = (win as unknown as { __testNotificationManager: new (app: App) => object })
    .__testNotificationManager;
  const app: App = {
    activeSessionId: 'session-1',
    fitAddon: { fit: vi.fn() },
    sendResize: vi.fn(() => Promise.resolve(false)),
    sessions: new Map(),
  };
  new NotificationManager(app);
  return { dom, win, app };
}

afterEach(() => {
  for (const dom of openWindows.splice(0)) dom.window.close();
});

describe('window focus re-asserts this client’s terminal size', () => {
  it('re-fits and re-posts the size when the window is focused', () => {
    const { win, app } = loadManager();

    win.dispatchEvent(new win.Event('focus'));

    expect(app.fitAddon.fit).toHaveBeenCalledOnce();
    expect(app.sendResize).toHaveBeenCalledWith('session-1');
  });

  it('ignores a focus event delivered to a hidden document', () => {
    const { dom, win, app } = loadManager();
    Object.defineProperty(dom.window.document, 'hidden', { value: true, configurable: true });

    win.dispatchEvent(new win.Event('focus'));

    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('does nothing without an active session', () => {
    const { win, app } = loadManager();
    app.activeSessionId = null;

    win.dispatchEvent(new win.Event('focus'));

    expect(app.sendResize).not.toHaveBeenCalled();
  });

  it('does NOT force the resize — alt-tabbing must not jiggle the pane every time', () => {
    const onTabVisible = SOURCE.slice(SOURCE.indexOf('onTabVisible() {'), SOURCE.indexOf('// Utilities'));
    expect(onTabVisible).toContain('this.app.sendResize(this.app.activeSessionId)');
    expect(onTabVisible).not.toContain('force: true');
  });
});

describe('the PTY size the server remembers matches the pane it attached to', () => {
  it('seeds _ptyCols/_ptyRows from the queried tmux window size', () => {
    // Without this, the fields stay at the 120x40 spawn default while the
    // restored pane is whatever the last client left, and resize() drops a
    // matching-by-accident post as a no-op.
    const attach = SESSION_SOURCE.slice(
      SESSION_SOURCE.indexOf('const { cols: ptyCols, rows: ptyRows }'),
      SESSION_SOURCE.indexOf('return { isRestored };')
    );
    expect(attach).toContain('this._ptyCols = ptyCols;');
    expect(attach).toContain('this._ptyRows = ptyRows;');
  });
});
