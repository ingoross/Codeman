/**
 * @fileoverview Turn a client-supplied upload filename into one that is safe to
 * create inside a session's workspace.
 *
 * The name on a multipart part is attacker-controlled — it is whatever string
 * the client put in `Content-Disposition: filename=`, not something the browser
 * validated — and POST /api/sessions/:id/upload-file writes a file named after
 * it. Two separate things have to hold:
 *
 *  1. It must not address anything but a leaf inside the target directory. So
 *     everything up to the last separator is dropped (`../../etc/passwd` →
 *     `passwd`, `C:\windows\x.dll` → `x.dll`), and the result can no longer
 *     contain a separator at all, which also makes an absolute path from the
 *     client meaningless rather than dangerous.
 *  2. It must be inert once it exists. The saved path is inserted verbatim into
 *     the terminal input for the agent to act on, so a file called
 *     `notes;rm -rf ~.txt` would arrive at a shell prompt as two words. Hence an
 *     ALLOWLIST — letters, digits, `.`, `_`, `-` — instead of a blocklist of
 *     metacharacters that a future shell or agent might extend.
 *
 * Non-ASCII letters and digits survive (`Angebot-Jänner.pdf`, `报告.csv`): no
 * UTF-8 byte of a non-ASCII codepoint can collide with an ASCII metacharacter,
 * so they are inert for the same reason ASCII letters are. Invisible and
 * direction-changing codepoints are the exception and are deleted, because their
 * whole purpose is to make the rendered name differ from the stored one.
 */

import { MAX_UPLOAD_FILENAME_LENGTH } from '../config/buffer-limits.js';

/** Used when the client sends nothing that survives sanitisation. */
const FALLBACK_BASE = 'file';

/**
 * Zero-width, bidi-override and BOM codepoints — DELETED, not substituted.
 * `report\u202Egnp.exe` renders as `reportexe.png` in every file listing and
 * picker while still being an `.exe`; substituting would leave a name that reads
 * differently from the one on disk, which is the problem, not the fix.
 */
const INVISIBLE_CODEPOINTS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/** Anything that is not a letter, a digit, `.`, `_` or `-` becomes `_`. */
const NON_ALLOWLISTED = /[^\p{L}\p{N}._-]/gu;

/** Longest accepted extension, so `file.<300 chars>` cannot eat the length budget. */
const MAX_EXT_LENGTH = 16;

export interface SanitizedUploadName {
  /** Name without the extension, never empty, never starting with `.` or `-`. */
  base: string;
  /** Extension including the leading dot (`.pdf`), or `''` when there is none. */
  ext: string;
}

/**
 * Sanitise one client-supplied filename into a `{ base, ext }` pair. Split
 * rather than joined so the caller can suffix collisions as `name-1.pdf` instead
 * of `name.pdf-1`. Total length is capped at MAX_UPLOAD_FILENAME_LENGTH with the
 * extension preserved — a long name is truncated by us, not rejected by the
 * filesystem with ENAMETOOLONG.
 *
 * Total, never throws: every input has a safe answer, worst case `file`.
 */
export function sanitizeUploadFilename(raw: string | undefined | null): SanitizedUploadName {
  // Path components first: whatever the client meant by a separator, only the
  // last segment survives. Split on BOTH separators so a Windows client (or an
  // attacker sending `..\..\x`) cannot smuggle one past a POSIX-only check.
  const segments = String(raw ?? '').split(/[/\\]/);
  const leaf = segments[segments.length - 1] ?? '';

  const cleaned = leaf.replace(INVISIBLE_CODEPOINTS, '').replace(NON_ALLOWLISTED, '_').replace(/_{2,}/g, '_');

  // An extension only exists when a dot has something before it: `.bashrc` is a
  // hidden file, not an empty name with a `.bashrc` extension.
  const dot = cleaned.lastIndexOf('.');
  const rawExt = dot > 0 ? cleaned.slice(dot + 1) : '';
  const hasExt = rawExt.length > 0 && rawExt.length <= MAX_EXT_LENGTH && /^[\p{L}\p{N}]+$/u.test(rawExt);
  const ext = hasExt ? `.${rawExt}` : '';

  // Leading dots make the file hidden (invisible in the Files panel, easy to
  // miss in a review); a leading dash makes the inserted path look like an
  // option to whatever the agent runs next (`cat -rf.txt`). Trailing dots and
  // underscores are cosmetic, and a trailing dot is invalid on Windows shares.
  let base = (hasExt ? cleaned.slice(0, dot) : cleaned).replace(/^[.\-_]+/, '').replace(/[.\-_]+$/, '');
  if (!base) base = FALLBACK_BASE;

  const budget = Math.max(1, MAX_UPLOAD_FILENAME_LENGTH - ext.length);
  if (base.length > budget) {
    // Re-strip: truncation can expose a new trailing separator character.
    base = base.slice(0, budget).replace(/[.\-_]+$/, '') || FALLBACK_BASE;
  }

  return { base, ext };
}
