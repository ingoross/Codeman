/**
 * @fileoverview Regression tests for quiet-period gap recovery ("missing lines").
 *
 * Two paths throw terminal output away on purpose: `batchTerminalWrite()` queues
 * live events while a buffer load runs and `_finishBufferLoad()` DISCARDS that
 * queue, and `_onSessionTerminal()` drops frames once the render queues pass
 * 128KB. Both leave the terminal showing a prefix of what the session printed,
 * and nothing repaired it — the old drop recovery was a fixed 2s timer that
 * armed once per burst (so it regularly fired mid-stream, re-opening the gap)
 * and `_onSessionNeedsRefresh()` returned silently whenever a buffer load
 * happened to be in flight.
 *
 * `_scheduleGapRecovery()` replaces it: a reload that waits for output to go
 * QUIET, is re-armed by every new frame, waits out an in-flight load instead of
 * dropping, and is floored so it cannot chain into itself.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts), the same way
 * test/terminal-buffer-flush.test.ts extracts the real mixin methods.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TERMINAL_UI_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
const APP_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

/**
 * Run terminal-ui.js in a vm against a fake CodemanApp and return the captured
 * prototype mixin.
 *
 * `setTimeout`/`clearTimeout`/`Date` are exposed as GETTERS onto the live
 * globals, not as the values they hold right now: the module is loaded once, at
 * import time, while `vi.useFakeTimers()` swaps those globals per test. A
 * snapshot taken here would pin the real timers inside the vm and the fake clock
 * would drive nothing.
 */
function loadTerminalMixin(): Record<string, unknown> {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const sandbox: Record<string, unknown> = {
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    document: { addEventListener: vi.fn() },
    // constants.js globals the mixin reads (loaded as a plain script in the app).
    GAP_RECOVERY_QUIET_MS: 1500,
    GAP_RECOVERY_MIN_INTERVAL_MS: 5000,
  };
  for (const name of ['setTimeout', 'clearTimeout', 'Date'] as const) {
    Object.defineProperty(sandbox, name, { get: () => globalThis[name], enumerable: true });
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(TERMINAL_UI_SOURCE, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

type GapApp = {
  activeSessionId: string | null;
  _isLoadingBuffer: boolean;
  _loadBufferQueue: string[] | null;
  _bufferLoadSeq: number;
  _bufferLoadOwner: string | null;
  _loadOverlapBytes: number;
  _gapRecoveryTimer: ReturnType<typeof setTimeout> | null;
  _gapRecoveryAt: number;
  _onSessionNeedsRefresh: () => void;
  batchTerminalWrite: (data: string) => void;
  _beginBufferLoad: (owner?: string) => string;
  _finishBufferLoad: (owner?: string, opts?: { flushQueued?: boolean }) => boolean;
  _scheduleGapRecovery: () => void;
};

/**
 * Stub carrying the buffer-load state plus the REAL begin/finish/schedule
 * methods. `batchTerminalWrite` is the real one too, but only its queue branch
 * is exercised — the write path below it needs a full xterm.
 */
function makeApp() {
  const refreshes: number[] = [];
  const app: GapApp = {
    activeSessionId: 'session-1',
    _isLoadingBuffer: false,
    _loadBufferQueue: null,
    _bufferLoadSeq: 0,
    _bufferLoadOwner: null,
    _loadOverlapBytes: 0,
    _gapRecoveryTimer: null,
    _gapRecoveryAt: 0,
    _onSessionNeedsRefresh: vi.fn(() => {
      refreshes.push(Date.now());
    }),
    batchTerminalWrite: mixin.batchTerminalWrite as GapApp['batchTerminalWrite'],
    _beginBufferLoad: mixin._beginBufferLoad as GapApp['_beginBufferLoad'],
    _finishBufferLoad: mixin._finishBufferLoad as GapApp['_finishBufferLoad'],
    _scheduleGapRecovery: mixin._scheduleGapRecovery as GapApp['_scheduleGapRecovery'],
  };
  return { app, refreshes };
}

describe('gap recovery — output discarded during a buffer load', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts the bytes queued during a load and arms a recovery when they are discarded', () => {
    const { app, refreshes } = makeApp();
    const owner = app._beginBufferLoad('load-1');
    app.batchTerminalWrite('twelve bytes');
    expect(app._loadOverlapBytes).toBe('twelve bytes'.length);
    expect(app._loadBufferQueue).toEqual(['twelve bytes']);

    app._finishBufferLoad(owner); // default: discard
    expect(app._loadOverlapBytes).toBe(0);
    expect(app._gapRecoveryTimer).not.toBeNull();
    expect(refreshes).toHaveLength(0); // not yet — output has to go quiet first

    vi.advanceTimersByTime(1500);
    expect(refreshes).toHaveLength(1);
  });

  it('does NOT arm a recovery when the queue was flushed instead of discarded (COD-144)', () => {
    const { app, refreshes } = makeApp();
    const owner = app._beginBufferLoad('load-2');
    app.batchTerminalWrite('prompt');
    // The replay writes through to xterm, which this stub does not have.
    app.batchTerminalWrite = vi.fn();

    app._finishBufferLoad(owner, { flushQueued: true });
    expect(app._gapRecoveryTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(refreshes).toHaveLength(0);
  });

  it('does NOT arm a recovery when nothing was discarded', () => {
    const { app, refreshes } = makeApp();
    const owner = app._beginBufferLoad('load-3');
    app._finishBufferLoad(owner);
    expect(app._gapRecoveryTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(refreshes).toHaveLength(0);
  });

  it('re-arming pushes the reload out, so it never lands mid-burst', () => {
    const { app, refreshes } = makeApp();
    app._scheduleGapRecovery();
    // A steady stream: every frame re-arms (this is what _onSessionTerminal does).
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      app._scheduleGapRecovery();
    }
    expect(refreshes).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    expect(refreshes).toHaveLength(1);
  });

  it('waits out an in-flight buffer load instead of dropping the recovery', () => {
    const { app, refreshes } = makeApp();
    app._beginBufferLoad('load-4');
    app._scheduleGapRecovery();

    vi.advanceTimersByTime(1500);
    expect(refreshes).toHaveLength(0); // still loading — rescheduled, not dropped
    expect(app._gapRecoveryTimer).not.toBeNull();

    app._isLoadingBuffer = false;
    vi.advanceTimersByTime(1500);
    expect(refreshes).toHaveLength(1);
  });

  it('floors consecutive reloads so a recovery cannot chain into itself', () => {
    const { app, refreshes } = makeApp();
    app._scheduleGapRecovery();
    vi.advanceTimersByTime(1500);
    expect(refreshes).toHaveLength(1);

    // The reload's own write window discarded a little output: re-armed at once.
    app._scheduleGapRecovery();
    vi.advanceTimersByTime(1500);
    expect(refreshes).toHaveLength(1); // held back by the 5s floor
    vi.advanceTimersByTime(3500);
    expect(refreshes).toHaveLength(2);
  });

  it('is a no-op without an active session', () => {
    const { app, refreshes } = makeApp();
    app.activeSessionId = null;
    app._scheduleGapRecovery();
    expect(app._gapRecoveryTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(refreshes).toHaveLength(0);
  });
});

describe('gap recovery — call sites in app.js', () => {
  it('the 128KB drop path arms the quiet-period recovery instead of a fixed timer', () => {
    expect(APP_SOURCE).toContain('if (queued + data.data.length > 131072)');
    const dropBlock = APP_SOURCE.slice(
      APP_SOURCE.indexOf('if (queued + data.data.length > 131072)'),
      APP_SOURCE.indexOf('this.batchTerminalWrite(data.data);')
    );
    expect(dropBlock).toContain('this._scheduleGapRecovery();');
    // The fixed 2s timer is gone for good.
    expect(APP_SOURCE).not.toContain('_clientDropRecoveryTimer');
  });

  it('every live frame re-arms a pending recovery', () => {
    expect(APP_SOURCE).toContain('if (this._gapRecoveryTimer) this._scheduleGapRecovery();');
  });

  it('a refresh that collides with a buffer load is retried, not dropped', () => {
    const refresh = APP_SOURCE.slice(APP_SOURCE.indexOf('async _onSessionNeedsRefresh('));
    const guard = refresh.slice(0, refresh.indexOf('_terminalRefreshOwner'));
    expect(guard).toContain('if (this._isLoadingBuffer) {');
    expect(guard).toContain('this._scheduleGapRecovery();');
  });

  it('a session switch drops a recovery armed for the session being left', () => {
    expect(APP_SOURCE).toContain("this._clearTimer('_gapRecoveryTimer');");
  });

  it('the quiet period and the floor live in constants.js, with the values this suite pins', () => {
    const constantsSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
    expect(constantsSource).toContain('const GAP_RECOVERY_QUIET_MS = 1500;');
    expect(constantsSource).toContain('const GAP_RECOVERY_MIN_INTERVAL_MS = 5000;');
  });
});
