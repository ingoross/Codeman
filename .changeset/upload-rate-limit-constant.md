---
'aicodeman': patch
---

**The upload count limit is now a named, overridable constant.** The 30 uploads/min per (IP, session) token bucket was a literal in `session-routes.ts` and a number repeated in its own error message. It moves to `MAX_UPLOADS_PER_MINUTE` in `config/buffer-limits.ts`, beside `MAX_UPLOAD_FILE_BYTES`, with a `CODEMAN_MAX_UPLOADS_PER_MINUTE` override — so both halves of "how much can one caller commit to disk" (how big, how often) are configured in one place, and the 429 message tracks the constant instead of contradicting it when an operator retunes it. No behaviour change at the default.
