---
"aicodeman": patch
---

**A second browser window stops fighting the first one over which session you are looking at.** The active session — and now the selected case tab — lived in `localStorage`, which every tab and window of one origin shares. Two windows side by side is the whole point of opening a second one, and it was the one thing that did not work: window B's `selectSession()` wrote the shared key, window A read it back on its next SSE reconnect and jumped to B's session, and the case row did the same to B's project the moment it started remembering a selection.

`codeman-active-session` and `codeman-active-case` now go through one two-store accessor. `sessionStorage` holds the live value and is per window (surviving reload and browser session restore, which an in-memory field would not); `localStorage` keeps being written as the seed a **brand-new** window starts from, so opening a fresh window still lands on the session you left — nothing about the restore order changes for a single window. Each store is guarded separately: `sessionStorage` can be unavailable while `localStorage` works (Safari private mode, blocked site data) and neither may take the other down with it.

Tests: `test/per-window-ui-state.test.ts`.
