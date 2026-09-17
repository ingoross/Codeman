---
"aicodeman": patch
---

**Fix: a forced resize now actually repaints, and a second browser window re-asserts its own size.** Three parts of the same problem — all clients of a session share one PTY, so the size it is at is not necessarily the size this window can render.

- `Session.resize(..., { force: true })` re-posted the same dimensions when they already matched, which repaints nothing: SIGWINCH (from the kernel's `TIOCSWINSZ` and from tmux's `resize-window` alike) is delivered only when the size actually MOVES. The forced path now steps one row away and comes straight back (`RESIZE_PROBE_SETTLE_MS`), so the second post is guaranteed to change the height and the CLI redraws its screen. At the row floor the probe steps UP, where stepping down would repeat the size and trigger nothing. A resize from another client during the probe window wins: the restore stands down instead of stomping it.
- `_ptyCols`/`_ptyRows` are seeded from the real tmux window size when the PTY is attached, instead of being left at the 120x40 spawn default. After a Codeman restart onto a restored pane of some other size, a client whose own size happened to be the default had its resize dropped as a no-op and went on drawing against a pane it did not fit.
- `onTabVisible()` (re-fit + re-post the size) now also runs on window `focus`, not only on `visibilitychange`: a second browser window on the same desktop becomes the one you are looking at without `visibilitychange` firing. Deliberately unforced, so alt-tabbing back does not jiggle the pane every time.

Tests: `test/session-resize-arbitration.test.ts` (4 new cases), `test/terminal-size-reassert.test.ts`.
