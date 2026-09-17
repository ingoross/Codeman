/**
 * @fileoverview Case (project) tabs: the row above the session strip.
 *
 * The row is a FILTER, never a second renderer. Three things about that can
 * break silently and are pinned here.
 *
 * 1. IT SHARES ONE CLASS AND ONE PASS with the sidebar filter box.
 *    `applySidebarFilter()` toggles `tab-filtered-out` for both, because the
 *    sidebar count and the arrow-key walk already skip that class — a second
 *    class would have to be added to both selectors to stay honest, and the one
 *    that got forgotten would leave a hidden row being counted or stepped onto.
 *
 * 2. A FILTER MUST ALWAYS BE CLEARABLE. The CSS that hides the class is scoped
 *    per filter (`html[data-session-list="sidebar"]` for the box,
 *    `html[data-case-filter='on'] for the row) so a class that leaked cannot
 *    hide a session while nothing on screen brings it back.
 *    `activeCaseFilter()` is the JS half of the same rule: it returns null
 *    whenever the row is off screen or the remembered case has no sessions.
 *
 * 3. HANDHELDS DO NOT GET THE ROW. Their header is fixed and capped (44px on a
 *    phone, 48px on a tablet), so a second row is clipped rather than squeezed,
 *    and the phone overview already groups the same sessions by case. Gated in
 *    CSS (mobile.css under 768px) and in JS at the SAME raw width, because
 *    either alone leaves a window between a resize and the next render, and a
 *    boundary that drifts by a pixel leaves a filter no control can clear.
 *
 * Builds a JSDOM window in-test under the default node env, same shape as
 * test/session-list-layout.test.ts. Do NOT declare a per-file jsdom
 * environment: it externalizes node:fs under vite and the readFileSync calls
 * below stop working. ⚠ Do not name that directive in a comment either, vitest
 * matches the string anywhere in the file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const APP_SOURCE = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const MOBILE_OVERVIEW = readFileSync(new URL('../src/web/public/mobile-overview.js', import.meta.url), 'utf-8');
const INDEX_HTML = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const STYLES_CSS = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf-8');
const MOBILE_CSS = readFileSync(new URL('../src/web/public/mobile.css', import.meta.url), 'utf-8');

interface CaseInfo {
  name: string;
  path: string;
}

interface SessionRow {
  id: string;
  name?: string;
  workingDir?: string;
}

interface CaseApp {
  sessions: Map<string, SessionRow>;
  sessionOrder: string[];
  cases: CaseInfo[];
  tabAlerts: Map<string, string>;
  activeSessionId: string | null;
  activeCaseTab: string;
  _sidebarFilter: string;
  _elemCache: Record<string, unknown>;
  $(id: string): Element | null;
  resolveSessionCaseName(session: SessionRow | undefined): string;
  caseTabGroups(): Map<string, { count: number; alert: boolean }>;
  activeCaseFilter(): string | null;
  _caseTabsAvailable(): boolean;
  _renderCaseTabsImmediate(): void;
  selectCaseTab(value: string): void;
  _followSessionCase(id: string): void;
  applySidebarFilter(query?: string): void;
  selectSession(id: string): void;
  isSessionSidebarActive(): boolean;
  updateSidebarCount(): void;
  reorderCaseTab(dragged: string, target: string, insertBefore: boolean): void;
  saveCaseOrder(order: string[]): void;
}

/** The parts of index.html this feature touches, minus everything it does not. */
const SHELL = `
  <header class="header">
    <div class="tabs-column">
      <div class="case-tabs" id="caseTabs" role="tablist" aria-label="Case tabs" aria-orientation="horizontal"></div>
      <div class="session-tabs-host" id="sessionTabsHost">
        <div class="session-tabs" id="sessionTabs" role="tablist" aria-label="Session tabs" aria-orientation="horizontal"></div>
      </div>
    </div>
  </header>
  <main class="main">
    <aside class="session-sidebar" id="sessionSidebar">
      <span class="session-sidebar-count" id="sessionSidebarCount"></span>
      <div class="session-sidebar-list" id="sessionSidebarList"></div>
    </aside>
  </main>
`;

/** Neutral fixture: three cases under one root, plus a session outside them all. */
const CASES: CaseInfo[] = [
  { name: 'alpha', path: '/srv/cases/alpha' },
  { name: 'beta', path: '/srv/cases/beta' },
  { name: 'gamma', path: '/srv/cases/gamma' },
];

const SESSIONS: SessionRow[] = [
  { id: 's1', name: 'w1-alpha', workingDir: '/srv/cases/alpha' },
  { id: 's2', name: 'w2-alpha', workingDir: '/srv/cases/alpha/packages/api' },
  { id: 's3', name: 'w1-beta', workingDir: '/srv/cases/beta' },
  { id: 's4', name: 'scratch', workingDir: '/srv/scratch' },
];

function boot(options: { viewportWidth?: number; sessions?: SessionRow[]; cases?: CaseInfo[] } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${SHELL}</body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & typeof globalThis & { __CodemanApp: new () => CaseApp };

  // _caseTabsAvailable() mirrors `@media (max-width: 768px)` in mobile.css off
  // the raw width, so the harness has to say which side of it we are on.
  Object.defineProperty(win, 'innerWidth', {
    value: options.viewportWidth ?? 1440,
    configurable: true,
    writable: true,
  });

  // app.js assigns window.MobileDetection at top level from the global that
  // mobile-handlers.js declares, so it has to exist before the source runs.
  // mobile-overview.js is loaded too, deliberately: resolveSessionCaseName()
  // delegates to its `_mobileOverviewCaseFor()` rather than owning a third copy
  // of the longest-prefix workingDir → case match, and a stub here would leave
  // the shipped delegation untested.
  (win as unknown as { eval: (s: string) => void }).eval(
    [
      `var MobileDetection = { getDeviceType: () => 'desktop', isHandheldDevice: () => false,
         isMobile: () => false, isTouchDevice: () => false };`,
      CONSTANTS,
      APP_SOURCE,
      MOBILE_OVERVIEW,
      'window.__CodemanApp = CodemanApp;',
    ].join('\n')
  );

  // Object.create, not `new`: the constructor boots SSE, timers and the whole
  // terminal stack. Only the case row is under test here.
  const app = Object.create(win.__CodemanApp.prototype) as CaseApp;
  app.sessions = new Map((options.sessions ?? SESSIONS).map((s) => [s.id, s]));
  app.sessionOrder = [...app.sessions.keys()];
  app.cases = options.cases ?? CASES;
  app.tabAlerts = new Map();
  app.activeSessionId = null;
  app.activeCaseTab = '*';
  app._sidebarFilter = '';
  app._elemCache = {};
  app.selectSession = vi.fn();
  app.saveCaseOrder = vi.fn();
  app.isSessionSidebarActive = () => false;

  // The strip as the session renderer leaves it: one row per session in
  // sessionOrder, carrying the data-id and aria-label the filter pass reads.
  const strip = win.document.getElementById('sessionTabs')!;
  strip.innerHTML = app.sessionOrder
    .map((id) => {
      const session = app.sessions.get(id)!;
      return `<div class="session-tab" data-id="${id}" role="tab" aria-label="${session.name} session" title="${session.workingDir}"></div>`;
    })
    .join('');

  return { dom, win, app };
}

const caseRow = (win: Window) => win.document.getElementById('caseTabs')!;
const chips = (win: Window) =>
  [...caseRow(win).querySelectorAll('.case-tab')].map((el) => (el as HTMLElement).dataset.case);
const visibleIds = (win: Window) =>
  [...win.document.querySelectorAll('.session-tab:not(.tab-filtered-out)')].map((el) => (el as HTMLElement).dataset.id);

describe('case tab row', () => {
  it('groups sessions by the case their working directory lives in, subdirectories included', () => {
    const { app } = boot();
    expect([...app.caseTabGroups()].map(([name, g]) => [name, g.count])).toEqual([
      ['alpha', 2],
      ['beta', 1],
      ['', 1],
    ]);
  });

  it('follows the case order the server sent and keeps the uncased bucket last', () => {
    // GET /api/cases is already sorted by the persisted caseOrder, so the row
    // must not re-sort it — reversing the list here has to reverse the row.
    const { app } = boot({ cases: [...CASES].reverse() });
    expect([...app.caseTabGroups().keys()]).toEqual(['beta', 'alpha', '']);
  });

  it('renders All plus one chip per case, with the tab semantics the session strip uses', () => {
    const { win, app } = boot();
    app._renderCaseTabsImmediate();
    expect(chips(win)).toEqual(['*', 'alpha', 'beta', '']);
    const all = caseRow(win).querySelector('.case-tab')!;
    expect(all.getAttribute('role')).toBe('tab');
    expect(all.getAttribute('aria-selected')).toBe('true');
    expect(all.getAttribute('tabindex')).toBe('0');
    expect(caseRow(win).getAttribute('role')).toBe('tablist');
    // The counts are the sessions the chip would filter to, All being all of them.
    expect([...caseRow(win).querySelectorAll('.case-tab-count')].map((el) => el.textContent)).toEqual([
      '4',
      '2',
      '1',
      '1',
    ]);
  });

  it('drops the row when there is only one case to choose', () => {
    const single = boot({ sessions: SESSIONS.filter((s) => s.workingDir?.startsWith('/srv/cases/alpha')) });
    single.app._renderCaseTabsImmediate();
    expect(caseRow(single.win).innerHTML).toBe('');
    expect(caseRow(single.win).hasAttribute('hidden')).toBe(true);
  });

  it('drops the row on every handheld width, phone and tablet alike', () => {
    // The tablet header is FIXED and max-height: 48px, so a second row is
    // clipped rather than squeezed. 768 is the boundary mobile.css uses and the
    // one _caseTabsAvailable() has to agree with exactly.
    for (const viewportWidth of [393, 768]) {
      const handheld = boot({ viewportWidth });
      handheld.app._renderCaseTabsImmediate();
      expect(handheld.app._caseTabsAvailable()).toBe(false);
      expect(caseRow(handheld.win).innerHTML).toBe('');
    }
    expect(boot({ viewportWidth: 769 }).app._caseTabsAvailable()).toBe(true);
  });

  it('narrows the session strip to the selected case and opens the gate the CSS needs', () => {
    const { win, app } = boot();
    app.selectCaseTab('alpha');
    expect(visibleIds(win)).toEqual(['s1', 's2']);
    expect(win.document.documentElement.dataset.caseFilter).toBe('on');
    expect(win.document.getElementById('sessionSidebarCount')!.textContent).toBe('2');

    app.selectCaseTab('*');
    expect(visibleIds(win)).toEqual(['s1', 's2', 's3', 's4']);
    expect(win.document.documentElement.dataset.caseFilter).toBe('off');
  });

  it('collects the sessions outside every case under one bucket', () => {
    const { win, app } = boot();
    app.selectCaseTab('');
    expect(visibleIds(win)).toEqual(['s4']);
  });

  it('moves the terminal onto the filtered case when the active session is not in it', () => {
    const { app } = boot();
    app.activeSessionId = 's4';
    app.selectCaseTab('alpha');
    expect(app.selectSession).toHaveBeenCalledWith('s1');

    // Already inside the case: nothing to move.
    (app.selectSession as ReturnType<typeof vi.fn>).mockClear();
    app.activeSessionId = 's1';
    app.selectCaseTab('alpha');
    expect(app.selectSession).not.toHaveBeenCalled();
  });

  it('follows a session selected from outside the filter instead of hiding it', () => {
    // Alt+N, Ctrl+Shift+[/] and the command palette all walk the whole strip
    // order, so they can land on a session the row says is not there.
    const { win, app } = boot();
    app.selectCaseTab('alpha');
    app._followSessionCase('s3');
    expect(app.activeCaseTab).toBe('beta');
    expect(visibleIds(win)).toEqual(['s3']);
  });

  it('never hides the list for a case that has no sessions left', () => {
    const { win, app } = boot();
    app.activeCaseTab = 'gamma'; // configured, but nothing running in it
    expect(app.activeCaseFilter()).toBeNull();
    app.applySidebarFilter('');
    expect(visibleIds(win)).toEqual(['s1', 's2', 's3', 's4']);
    // ...and the row normalizes the stale choice back to All rather than
    // painting a selected chip that is not in it.
    app._renderCaseTabsImmediate();
    expect(app.activeCaseTab).toBe('*');
  });

  it('never filters a handheld, whatever case the last desktop window left behind', () => {
    const { win, app } = boot({ viewportWidth: 393 });
    app.activeCaseTab = 'alpha';
    app.applySidebarFilter('');
    expect(app.activeCaseFilter()).toBeNull();
    expect(visibleIds(win)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('combines with the sidebar filter box in one pass over one class', () => {
    const { win, app } = boot();
    app.isSessionSidebarActive = () => true;
    win.document.documentElement.dataset.sidebar = 'expanded';
    app.selectCaseTab('alpha');
    app.applySidebarFilter('packages');
    // Inside the case AND matching the needle.
    expect(visibleIds(win)).toEqual(['s2']);
  });

  it('leaves web-tab rows alone — they are in the strip but belong to no case', () => {
    const { win, app } = boot();
    const strip = win.document.getElementById('sessionTabs')!;
    strip.insertAdjacentHTML(
      'beforeend',
      '<div class="session-tab" data-webview-id="w-1" role="tab" aria-label="Dashboard tab"></div>'
    );
    app.selectCaseTab('alpha');
    const webTab = strip.querySelector('[data-webview-id]')!;
    expect(webTab.classList.contains('tab-filtered-out')).toBe(false);
  });
});

describe('case tab drag reordering', () => {
  it('offers the drag affordance to real cases only', () => {
    const { win, app } = boot();
    app._renderCaseTabsImmediate();
    const draggable = [...caseRow(win).querySelectorAll('.case-tab')].map((el) => el.getAttribute('draggable'));
    // All (anchor) and Other (not a case) have no position to persist.
    expect(draggable).toEqual([null, 'true', 'true', null]);
  });

  it('moves a case and persists the whole list through the case-order endpoint', () => {
    const { win, app } = boot();
    app._renderCaseTabsImmediate();
    app.reorderCaseTab('beta', 'alpha', true);
    expect(chips(win)).toEqual(['*', 'beta', 'alpha', '']);
    // saveCaseOrder (session-ui.js) PUTs /api/cases/order, which is the one
    // owner of case order — the Run dropdown and the Case Manager read it back.
    expect(app.saveCaseOrder).toHaveBeenCalledWith(['beta', 'alpha', 'gamma']);
  });

  it('inserts after the target when the drop lands on its right half', () => {
    const { win, app } = boot();
    app._renderCaseTabsImmediate();
    app.reorderCaseTab('alpha', 'beta', false);
    expect(chips(win)).toEqual(['*', 'beta', 'alpha', '']);
  });

  it('leaves a case with no sessions exactly where it was', () => {
    // `gamma` has no chip to drag, so a drag between the two visible cases must
    // not shuffle it — the Run dropdown reads this same order, and moving a
    // case the user cannot see would look like corruption.
    const { app } = boot();
    app._renderCaseTabsImmediate();
    app.cases = [
      { name: 'alpha', path: '/srv/cases/alpha' },
      { name: 'gamma', path: '/srv/cases/gamma' },
      { name: 'beta', path: '/srv/cases/beta' },
    ];
    app.reorderCaseTab('beta', 'alpha', true);
    expect(app.cases.map((c) => c.name)).toEqual(['beta', 'gamma', 'alpha']);
  });
});

describe('case tab markup and styling contract', () => {
  it('keeps the row OUTSIDE the host that gets re-parented', () => {
    // applySessionListLayout() moves #sessionTabs into the sidebar or the tab
    // rail and hides #sessionTabsHost. The case row has to keep filtering
    // whichever list is on screen, so it must not live inside that host.
    const dom = new JSDOM(INDEX_HTML);
    const row = dom.window.document.getElementById('caseTabs')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('role')).toBe('tablist');
    expect(dom.window.document.getElementById('sessionTabsHost')!.contains(row)).toBe(false);
    expect(row.closest('.tabs-column')).not.toBeNull();
    expect(dom.window.document.getElementById('sessionTabs')!.closest('.tabs-column')).not.toBeNull();
  });

  it('hides filtered rows only while a case tab is selected', () => {
    expect(STYLES_CSS).toContain("html[data-case-filter='on'] .session-tab.tab-filtered-out");
    // The sidebar box keeps its own scope; neither filter may be widened into
    // an unscoped rule that hides tabs no control can bring back.
    expect(STYLES_CSS).toContain('html[data-session-list="sidebar"] .session-tab.tab-filtered-out');
    expect(STYLES_CSS).not.toMatch(/^\.session-tab\.tab-filtered-out/m);
  });

  it('persists the row order server-side, never in localStorage', () => {
    // `PUT /api/cases/order` is the upstream owner of case order. A private
    // localStorage copy here would drift from the Run dropdown and the Case
    // Manager, which both read the server's list back.
    expect(APP_SOURCE).toContain('this.saveCaseOrder?.(');
    expect(APP_SOURCE).not.toMatch(/localStorage\.\w+Item\('codeman-case/);
  });

  it('drops the row on handhelds in CSS as well as in JS, at the same width', () => {
    const handheldBlock = MOBILE_CSS.slice(
      MOBILE_CSS.indexOf('@media (max-width: 768px)'),
      MOBILE_CSS.indexOf('@media (max-width: 768px) and (min-width: 600px)')
    );
    expect(handheldBlock).toContain('.case-tabs {\n    display: none;\n  }');
    // The JS gate must name the same boundary, or a filter survives on a width
    // whose row is hidden and nothing on screen can clear it.
    expect(APP_SOURCE).toContain('return window.innerWidth > 768;');
  });
});
