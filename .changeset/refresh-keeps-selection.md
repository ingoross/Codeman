---
"aicodeman": patch
---

**Fix: a server-triggered buffer refresh no longer eats a live selection.** `_onSessionNeedsRefresh()` replaces the whole terminal buffer (`clear()` + `reset()` + rewrite) and xterm drops the selection with it — so on a noisy session, highlighting a stack trace to copy it lost the highlight again and again, for a refresh the user never asked for. The refresh now stands aside while text is selected (checked before the fetch AND again before the rewrite, because a drag can start while the request is in flight) and sets `_gapRecoveryDeferred`; `_onTerminalSelectionCleared()`, called from xterm's `onSelectionChange` the moment the selection goes, re-arms the recovery so the gap still heals. Deferring rather than polling means no timer is left running for a selection the user leaves standing. Scroll position was already preserved across a refresh (#259). Tests: `test/terminal-refresh-selection.test.ts`.
