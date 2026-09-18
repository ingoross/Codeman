/**
 * @fileoverview Tests for sanitizeUploadFilename() — the one function standing
 * between an attacker-controlled `Content-Disposition: filename=` and a file
 * created inside a session's working directory.
 *
 * Port: N/A (pure function).
 */

import { describe, it, expect } from 'vitest';
import { sanitizeUploadFilename } from '../src/web/upload-filename.js';
import { MAX_UPLOAD_FILENAME_LENGTH } from '../src/config/buffer-limits.js';

/** Convenience: the name as it would actually be written. */
function name(raw: string | undefined | null): string {
  const { base, ext } = sanitizeUploadFilename(raw);
  return `${base}${ext}`;
}

describe('sanitizeUploadFilename', () => {
  describe('path traversal', () => {
    it.each([
      ['../../../../etc/passwd', 'passwd'],
      ['..\\..\\windows\\system32\\drivers.sys', 'drivers.sys'],
      ['/etc/shadow', 'shadow'],
      ['C:\\Users\\Public\\payload.dll', 'payload.dll'],
      ['./../report.pdf', 'report.pdf'],
      ['dir/sub/notes.csv', 'notes.csv'],
    ])('reduces %s to the leaf %s', (raw, expected) => {
      expect(name(raw)).toBe(expected);
    });

    it('leaves no separator in the result, whichever kind was used', () => {
      for (const raw of ['a/b/c.txt', 'a\\b\\c.txt', '//a//b.txt', '..', '../..', '/', '\\']) {
        const out = name(raw);
        expect(out).not.toContain('/');
        expect(out).not.toContain('\\');
      }
    });

    it('turns a bare `..` into the fallback rather than a parent reference', () => {
      expect(name('..')).toBe('file');
      expect(name('.')).toBe('file');
      expect(name('...')).toBe('file');
    });
  });

  describe('shell metacharacters', () => {
    // The saved path is inserted into the terminal input for the agent to act
    // on, so nothing in the name may be read as syntax by whatever runs next.
    it.each([
      'notes;rm -rf ~.txt',
      'a$(whoami).log',
      'b`id`.log',
      'c|tee /tmp/x.log',
      'd && curl evil.example.csv',
      'e\'quote".zip',
      'f>redirect.txt',
      'g*glob?.txt',
      'h with spaces.pdf',
      'i\tnewline\n.pdf',
    ])('leaves nothing but [A-Za-z0-9._-] in %j', (raw) => {
      expect(name(raw)).toMatch(/^[A-Za-z0-9._-]+$/);
    });

    it('collapses the substituted runs instead of emitting a wall of underscores', () => {
      expect(name('a   &&&   b.txt')).toBe('a_b.txt');
    });
  });

  describe('control and invisible characters', () => {
    it('strips NUL and other C0 control characters', () => {
      expect(name('evil\u0000.php.txt')).toBe('evil_.php.txt');
      // Trailing `_` is then trimmed off the base, so a substitution at the end
      // of a name does not leave a cosmetic tail behind.
      expect(name('bell\u0007.log')).toBe('bell.log');
    });

    it('DELETES a right-to-left override instead of substituting it', () => {
      // "report\u202Egnp.exe" renders as "reportexe.png" in a file listing.
      // Substituting would leave a name that still reads differently from the
      // one on disk; deleting makes the rendered name the stored name.
      expect(name('report\u202Egnp.exe')).toBe('reportgnp.exe');
      expect(name('a\u200bb\ufeffc.csv')).toBe('abc.csv');
    });
  });

  describe('hidden files and option-looking names', () => {
    it('never produces a name starting with a dot', () => {
      for (const raw of ['.bashrc', '..hidden.txt', '.ssh/authorized_keys', '.env']) {
        expect(name(raw).startsWith('.')).toBe(false);
      }
    });

    it('never produces a name starting with a dash', () => {
      // `-rf.txt` inserted into a terminal reads as an option, not a path.
      expect(name('-rf.txt')).toBe('rf.txt');
      expect(name('--force.log')).toBe('force.log');
    });

    it('keeps a dot-file readable rather than throwing it away', () => {
      expect(name('.bashrc')).toBe('bashrc');
    });
  });

  describe('extensions', () => {
    it('keeps the last extension of a multi-part name', () => {
      expect(sanitizeUploadFilename('archive.tar.gz')).toEqual({ base: 'archive.tar', ext: '.gz' });
    });

    it('preserves case', () => {
      expect(sanitizeUploadFilename('Report.PDF')).toEqual({ base: 'Report', ext: '.PDF' });
    });

    it('treats an absurdly long tail as part of the name, not as an extension', () => {
      const out = sanitizeUploadFilename(`data.${'x'.repeat(40)}`);
      expect(out.ext).toBe('');
    });

    it('reports no extension when there is none', () => {
      expect(sanitizeUploadFilename('LICENSE')).toEqual({ base: 'LICENSE', ext: '' });
    });
  });

  describe('length', () => {
    it('caps the total length and keeps the extension', () => {
      const out = name(`${'a'.repeat(500)}.csv`);
      expect(out.length).toBeLessThanOrEqual(MAX_UPLOAD_FILENAME_LENGTH);
      expect(out.endsWith('.csv')).toBe(true);
    });

    it('leaves room for the extension even when the extension is long', () => {
      const out = sanitizeUploadFilename(`${'a'.repeat(500)}.abcdefghijklmnop`);
      expect(`${out.base}${out.ext}`.length).toBeLessThanOrEqual(MAX_UPLOAD_FILENAME_LENGTH);
      expect(out.ext).toBe('.abcdefghijklmnop');
    });
  });

  describe('unicode', () => {
    it('keeps non-ASCII letters and digits — they cannot collide with a metacharacter', () => {
      expect(name('Angebot-Jänner.pdf')).toBe('Angebot-Jänner.pdf');
      expect(name('报告.csv')).toBe('报告.csv');
    });
  });

  describe('degenerate input', () => {
    it.each([undefined, null, '', '   ', '///', '???'])('falls back to `file` for %j', (raw) => {
      expect(name(raw)).toBe('file');
    });

    it('never returns an empty base', () => {
      for (const raw of ['', '.', '-', '_', '.-_', '\u202e']) {
        expect(sanitizeUploadFilename(raw).base.length).toBeGreaterThan(0);
      }
    });
  });
});
