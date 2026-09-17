---
"aicodeman": patch
---

**The case row is drag-reorderable, and the order is the one the rest of the app already uses.** Case chips drag exactly like session tabs — same grab cursor, same insertion edge — and the result is persisted through the existing `PUT /api/cases/order`, which is already the one owner of case order: it writes `caseOrder` into `settings.json`, `GET /api/cases` sorts by it, and it broadcasts `case:order-changed`. So a drag in the header also reorders the Run dropdown and the Case Manager list, follows you to your other devices, and cannot end up disagreeing with either. Nothing is kept in `localStorage`, and `PUT /api/tab-layout` is deliberately untouched — that model orders session/webview *refs* inside user-made groups, and a case is neither (it is derived from a session's `workingDir` and has no ref of its own).

Only real case chips are draggable: **All** is an anchor and **Other** is not a case, so neither has a position to persist. And only the slots held by cases that are *on the row* are permuted — a case with no live sessions has no chip to drag, and letting a drag push it to the end would silently reshuffle the Run dropdown around entries the user cannot see. Reordering by keyboard already exists and is unchanged: Case Manager → move up/down writes the very same order.

Tests: `test/case-tabs.test.ts`.
