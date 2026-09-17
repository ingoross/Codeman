/**
 * @fileoverview xterm's hidden input must not be treated as prose by an IME.
 *
 * xterm creates `.xterm-helper-textarea` as a plain `<textarea>`, so a virtual
 * keyboard offers predictions, auto-corrects and auto-capitalises into it — and
 * whatever it decides goes straight to the PTY, where `ls` arriving as `Ls` or
 * a silently rewritten flag is not a typo the user can see happening.
 * `_quietHelperTextarea()` sets the hints that turn all of that off.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const TERMINAL_UI_SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

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

const mixin = loadTerminalMixin();
const quietHelperTextarea = mixin._quietHelperTextarea as (container: unknown) => void;

function makeContainer(hasHelper = true) {
  const attrs: Record<string, string> = {};
  const helper = { setAttribute: (name: string, value: string) => (attrs[name] = value) };
  const container = {
    querySelector: vi.fn((selector: string) => (hasHelper && selector === '.xterm-helper-textarea' ? helper : null)),
  };
  return { container, attrs };
}

describe('xterm helper textarea', () => {
  it('turns off every keyboard guess that would reach the PTY', () => {
    const { container, attrs } = makeContainer();

    quietHelperTextarea.call({}, container);

    expect(attrs).toEqual({
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      'data-gramm': 'false',
    });
    expect(container.querySelector).toHaveBeenCalledWith('.xterm-helper-textarea');
  });

  it('is a no-op when the textarea or the container is missing', () => {
    const { container } = makeContainer(false);
    expect(() => quietHelperTextarea.call({}, container)).not.toThrow();
    expect(() => quietHelperTextarea.call({}, null)).not.toThrow();
    expect(() => quietHelperTextarea.call({}, {})).not.toThrow();
  });

  it('runs right after the terminal is opened, before anything can focus it', () => {
    const open = TERMINAL_UI_SOURCE.indexOf('this.terminal.open(container);');
    const quiet = TERMINAL_UI_SOURCE.indexOf('this._quietHelperTextarea(container);');
    expect(open).toBeGreaterThan(-1);
    expect(quiet).toBeGreaterThan(open);
    // Nothing between the two lines — the textarea exists only after open().
    expect(TERMINAL_UI_SOURCE.slice(open, quiet).trim()).toBe('this.terminal.open(container);');
  });
});
