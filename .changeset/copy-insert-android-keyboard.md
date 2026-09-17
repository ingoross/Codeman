---
"aicodeman": patch
---

**Ctrl+Insert copies the selection, and on-screen keyboards stop editing your commands.** Two small terminal-input fixes:

- `Ctrl+Insert` joins `Ctrl+C` and `Ctrl+Shift+C` on the `copy-selection` shortcut (rebindable and disablable like the others). Firefox reserves `Ctrl+Shift+C` for its devtools, so the explicit copy chord never reached the page there at all — `Ctrl+Insert` is the one no browser takes. Like `Ctrl+Shift+C` it is swallowed rather than forwarded when the selection is empty; only `Ctrl+C` still falls through, so the interrupt is never lost.
- xterm's hidden `.xterm-helper-textarea` now carries `autocomplete`/`autocorrect`/`autocapitalize`/`spellcheck` (plus `data-gramm`). xterm creates it as a plain `<textarea>`, so a virtual keyboard treated the terminal like a message box — Gboard showed its suggestion strip, auto-corrected words on the way in and capitalised the first letter of every command, and those guesses went straight to the PTY.

Tests: `test/terminal-helper-textarea.test.ts`, plus new cases in `test/terminal-copy-selection.test.ts`.
