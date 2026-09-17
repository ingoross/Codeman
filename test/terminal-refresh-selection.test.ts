/**
 * @fileoverview A server-triggered buffer refresh must not eat a live selection.
 *
 * `_onSessionNeedsRefresh()` replaces the whole terminal buffer
 * (`clear()` + `reset()` + rewrite), and xterm drops the selection with it. The
 * refresh is server-triggered (SSE backpressure, gap recovery), so the user
 * never asked for it — highlighting a stack trace while a session is noisy used
 * to lose the highlight, repeatedly. The refresh now stands aside while text is
 * selected and is re-armed by `_onTerminalSelectionCleared()`, which xterm's
 * `onSelectionChange` calls the moment the selection goes (any keypress, any
 * click), so the gap it was sent to close still heals.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const APP_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
const TERMINAL_UI_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

/** Run constants.js + app.js in a vm and hand back the CodemanApp class. */
function loadAppHarness() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const fetchMock = vi.fn();
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    performance: { now: () => 0 },
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    fetch: fetchMock,
    document: { addEventListener: vi.fn(), getElementById: () => null, querySelector: () => null },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: { isTouchDevice: () => false },
  });
  const constants = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const appSource = readFileSync(resolve(dir, 'app.js'), 'utf8');
  vm.runInContext(`${constants}\n${appSource}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const CodemanApp = (context as { __CodemanApp: { prototype: object } }).__CodemanApp;
  return { CodemanApp, fetchMock };
}

/** Run terminal-ui.js in a vm and hand back the mixin it puts on CodemanApp.prototype. */
function loadTerminalMixin(): Record<string, unknown> {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
  });
  vm.runInContext(TERMINAL_UI_SOURCE, context);
  return FakeCodemanApp.prototype;
}

const terminalMixin = loadTerminalMixin();

/** Minimal app with the state `_onSessionNeedsRefresh` reads. */
function makeApp(hasSelection: boolean) {
  const { CodemanApp, fetchMock } = loadAppHarness();
  const app = Object.create(CodemanApp.prototype) as any;
  app._onTerminalSelectionCleared = terminalMixin._onTerminalSelectionCleared;
  app.activeSessionId = 'session-1';
  app.sessions = new Map([['session-1', { mode: 'shell' }]]);
  app.terminal = { hasSelection: () => hasSelection };
  app._isLoadingBuffer = false;
  app._terminalRefreshOwner = null;
  app._gapRecoveryDeferred = false;
  app._scheduleGapRecovery = vi.fn();
  return { app, fetchMock };
}

describe('a refresh stands aside for a live selection', () => {
  it('does not fetch or rewrite while text is selected, and remembers to come back', async () => {
    const { app, fetchMock } = makeApp(true);

    await app._onSessionNeedsRefresh({ id: 'session-1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(app._gapRecoveryDeferred).toBe(true);
    // Deferring is not rescheduling: no timer is left running for a selection
    // the user may leave standing for minutes.
    expect(app._scheduleGapRecovery).not.toHaveBeenCalled();
  });

  it('refreshes normally when nothing is selected', async () => {
    const { app, fetchMock } = makeApp(false);
    fetchMock.mockResolvedValue({ json: async () => ({ data: { terminalBuffer: '' } }) });

    await app._onSessionNeedsRefresh({ id: 'session-1' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(app._gapRecoveryDeferred).toBe(false);
  });

  it('a selection that starts DURING the fetch still saves the highlight', async () => {
    const { app, fetchMock } = makeApp(false);
    let selected = false;
    app.terminal = {
      hasSelection: () => selected,
      clear: vi.fn(),
      reset: vi.fn(),
    };
    fetchMock.mockImplementation(async () => {
      selected = true; // user starts dragging while the request is in flight
      return { json: async () => ({ data: { terminalBuffer: 'fresh' } }) };
    });

    await app._onSessionNeedsRefresh({ id: 'session-1' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(app.terminal.clear).not.toHaveBeenCalled();
    expect(app.terminal.reset).not.toHaveBeenCalled();
    expect(app._gapRecoveryDeferred).toBe(true);
  });

  it('releases the deferred refresh when the selection goes, once', () => {
    const { app } = makeApp(true);
    app._gapRecoveryDeferred = true;
    app._onTerminalSelectionCleared();
    expect(app._scheduleGapRecovery).toHaveBeenCalledOnce();
    expect(app._gapRecoveryDeferred).toBe(false);

    // A second clear (xterm fires onSelectionChange freely) does nothing.
    app._onTerminalSelectionCleared();
    expect(app._scheduleGapRecovery).toHaveBeenCalledOnce();
  });
});

describe('selection guard wiring', () => {
  it('xterm tells the app the selection is gone', () => {
    const cleared = TERMINAL_UI_SOURCE.slice(
      TERMINAL_UI_SOURCE.indexOf('this.terminal.onSelectionChange?.(() => {'),
      TERMINAL_UI_SOURCE.indexOf('this._autoCopyPending = true;')
    );
    expect(cleared).toContain('this._onTerminalSelectionCleared();');
  });

  it('both guards sit in _onSessionNeedsRefresh — before the fetch and before the rewrite', () => {
    const refresh = APP_SOURCE.slice(
      APP_SOURCE.indexOf('async _onSessionNeedsRefresh('),
      APP_SOURCE.indexOf('async _onSessionClearTerminal(')
    );
    const guards = refresh.match(/if \(this\.terminal\.hasSelection\?\.\(\)\) \{/g) || [];
    expect(guards).toHaveLength(2);
    // The second one has to come before the destructive write, not after it.
    expect(refresh.lastIndexOf('if (this.terminal.hasSelection?.()) {')).toBeLessThan(
      refresh.indexOf('this.terminal.clear();')
    );
  });
});
