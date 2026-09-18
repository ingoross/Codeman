---
'aicodeman': patch
---

**Tests for the workspace file upload, aimed at the parts that write to disk.** Three new suites plus one addition, all on neutral fixtures (`report.pdf`, `notes.csv`, `archive.zip`, `server.log`):

- `test/upload-filename.test.ts` — the sanitiser on its own: traversal in both separator flavours, absolute paths, bare `..`, shell metacharacters, C0 controls, a right-to-left override, dot-files, dash-leading names, multi-part extensions, the length cap, and the non-ASCII letters that are deliberately kept.
- `test/routes/session-upload-file-routes.test.ts` — the route: the file lands in `.claude-files` while an image still lands in `.claude-images`; mode is never executable; a traversal attempt writes nothing outside the working directory; `.claude-files` as a symlink is refused with 403 and the target stays empty; a symlink planted at the target *filename* is not written through and the next suffix wins; collisions go `-1`, `-2`; oversize is 413 with a reason; empty is 400; the 30/min budget is shared with `paste-image` rather than granted twice; cross-origin is 403 and `X-Codeman-CSRF` is the non-browser way in; an unknown session 404s before the filesystem is touched; a remote session is refused on both routes; a docker session writes normally.
- `test/upload-attachment-routing.test.ts` — the client splitter: images to `/paste-image`, everything else to `/upload-file`, one `sendInput` for the whole batch in drop order, the batch cap announced rather than silent, a dropped folder skipped with an honest message, and the server's reason surfaced on failure.
- `test/auth-security.test.ts` gains an unauthenticated POST to both upload routes. There is no per-route auth allowlist to add an entry to — the hook covers everything under `/api/` — which is why this is an assertion against a running server rather than a line in a list.

The route suite lowers `CODEMAN_MAX_UPLOAD_FILE_BYTES` to 2KB for its own file so the oversize path costs kilobytes instead of pushing 25MB through busboy on every run.
