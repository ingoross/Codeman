---
"aicodeman": patch
---

**A case row above the session tabs, filtering the list you already have.** With a dozen sessions spread over four projects the strip stops being a list of your work and becomes a list of everything, and the only way to narrow it was the sidebar's text box — which means typing a project name you already clicked once to create.

The header now carries a second row: one tab per case that currently has sessions, plus **All** (the default, so nothing changes until you pick something) and **Other** for sessions started outside every case. Picking one narrows the session list to that case.

It is a filter, not a second tab implementation. Rows are hidden with the same `tab-filtered-out` class and in the same single pass (`applySidebarFilter()`) the sidebar filter box uses, so the sidebar count and the arrow-key walk skip them for free, and everything about how sessions are *rendered* is untouched: `sessionOrder` still drives the strip, the Alt+N badges still count the whole strip rather than renumbering per project, the incremental render path still diffs the full session set, and drag-reordering still rewrites one global order. It works in all three session-list layouts — header strip, sidebar, vertical rail — because the row stays in the header while `#sessionTabs` is re-parented out of it.

A session's case is the longest `case.path` that prefixes its `workingDir`, resolved through `_mobileOverviewCaseFor()` (mobile-overview.js) rather than a third copy of that match. The row is ordered by `GET /api/cases`, which is already sorted by the persisted `caseOrder`.

Two rules keep a filter from stranding you: it disappears below two cases (nothing to choose), and a remembered case with no sessions left falls back to All rather than hiding everything. Selecting a session from outside the filter — Alt+N, `Ctrl+Shift+[`/`]`, the command palette — moves the row onto that session's case instead of hiding it. Handhelds keep the overview home screen, which already groups the same sessions by case and has room to show them; their header is fixed and capped (44px on a phone, 48px on a tablet), so a second row would be clipped rather than fit.

Tests: `test/case-tabs.test.ts`.
