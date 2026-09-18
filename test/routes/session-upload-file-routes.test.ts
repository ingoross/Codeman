/**
 * @fileoverview Tests for POST /api/sessions/:id/upload-file — the non-image
 * half of the workspace upload pair — and for the guards it shares with
 * /paste-image.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * The per-file size cap is lowered to 2KB for this file (see the vi.hoisted
 * block) so the oversize path can be exercised with a few kilobytes instead of
 * pushing 25MB through busboy on every run.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, lstat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';

// Must run BEFORE the imports below, so config/buffer-limits.ts reads it.
const PREVIOUS_MAX_BYTES = vi.hoisted(() => {
  const prev = process.env.CODEMAN_MAX_UPLOAD_FILE_BYTES;
  process.env.CODEMAN_MAX_UPLOAD_FILE_BYTES = '2048';
  return prev;
});

// The real converter spawns a worker thread (TS worker file — not loadable
// under vitest). Nothing here uploads HEIC, but session-routes imports it.
vi.mock('../../src/web/heic-jpeg-converter.js', () => ({
  convertHeicToJpeg: vi.fn(async () => Buffer.from('ffd8ffe000104a4649460001', 'hex')),
}));

import { registerSessionRoutes, _resetPasteRateBuckets } from '../../src/web/routes/session-routes.js';
import { MAX_UPLOAD_FILE_BYTES } from '../../src/config/buffer-limits.js';

afterAll(() => {
  if (PREVIOUS_MAX_BYTES === undefined) delete process.env.CODEMAN_MAX_UPLOAD_FILE_BYTES;
  else process.env.CODEMAN_MAX_UPLOAD_FILE_BYTES = PREVIOUS_MAX_BYTES;
});

const BOUNDARY = 'codeman-upload-boundary';
/** PNG signature + the start of the IHDR chunk — imageMagicMatchesExt() needs 12 bytes. */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/** Mirrors production's uniform-envelope preSerialization hook (server.ts). */
async function createHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });

  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

function multipartBody(fieldName: string, filename: string, mimetype: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

describe('session upload-file route', () => {
  let harness: LocalHarness;
  let workDir: string;

  /** POST a file, same-origin by default. */
  async function upload(
    options: {
      filename?: string;
      bytes?: Buffer;
      mimetype?: string;
      field?: string;
      path?: string;
      headers?: Record<string, string>;
    } = {}
  ) {
    const field = options.field ?? 'file';
    const body = multipartBody(
      field,
      options.filename ?? 'report.pdf',
      options.mimetype ?? 'application/pdf',
      options.bytes ?? Buffer.from('%PDF-1.4 neutral fixture')
    );
    return harness.app.inject({
      method: 'POST',
      url: options.path ?? `/api/sessions/${harness.ctx._sessionId}/upload-file`,
      headers: {
        host: 'codeman.test',
        origin: 'http://codeman.test',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        ...options.headers,
      },
      payload: body,
    });
  }

  beforeEach(async () => {
    harness = await createHarness();
    _resetPasteRateBuckets();
    workDir = await mkdtemp(join(tmpdir(), 'codeman-upload-'));
    harness.ctx._session.workingDir = workDir;
  });

  afterEach(async () => {
    await harness.app.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // ========== happy path ==========

  describe('happy path', () => {
    it('stores a non-image under .claude-files with its own name', async () => {
      const res = await upload({ filename: 'report.pdf' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.filename).toBe('report.pdf');
      expect(body.data.path).toBe(join(workDir, '.claude-files', 'report.pdf'));
      expect(await readFile(body.data.path, 'utf8')).toBe('%PDF-1.4 neutral fixture');
    });

    it.each([
      ['notes.csv', 'text/csv'],
      ['archive.zip', 'application/zip'],
      ['server.log', 'text/plain'],
      ['data.json', 'application/json'],
    ])('accepts %s without sniffing its content', async (filename, mimetype) => {
      const res = await upload({ filename, mimetype, bytes: Buffer.from('not really a ' + filename) });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.filename).toBe(filename);
    });

    it('creates the file readable but NEVER executable', async () => {
      const res = await upload({ filename: 'script.sh', bytes: Buffer.from('#!/bin/sh\necho hi\n') });
      const { path } = JSON.parse(res.body).data;
      const mode = (await stat(path)).mode & 0o777;
      expect(mode & 0o111).toBe(0); // no execute bit for anyone
      expect(mode & 0o400).toBe(0o400); // still readable by the agent
    });

    it('leaves the image route on .claude-images — the two directories stay apart', async () => {
      const imageRes = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: multipartBody('image', 'shot.png', 'image/png', PNG_BYTES),
      });
      expect(imageRes.statusCode).toBe(200);
      expect(JSON.parse(imageRes.body).data.path).toMatch(/\/\.claude-images\/paste-\d+-[a-f0-9]{8}\.png$/);

      const fileRes = await upload({ filename: 'notes.csv', mimetype: 'text/csv' });
      expect(JSON.parse(fileRes.body).data.path).toBe(join(workDir, '.claude-files', 'notes.csv'));

      expect(await readdir(join(workDir, '.claude-files'))).toEqual(['notes.csv']);
    });
  });

  // ========== filename handling ==========

  describe('filename handling', () => {
    it.each([
      ['../../../../etc/passwd', 'passwd'],
      ['..\\..\\evil.dll', 'evil.dll'],
      ['/etc/shadow', 'shadow'],
      ['sub/dir/notes.csv', 'notes.csv'],
    ])('refuses to leave .claude-files for %s', async (filename, expected) => {
      const res = await upload({ filename });
      expect(res.statusCode).toBe(200);
      const { path } = JSON.parse(res.body).data;
      expect(path).toBe(join(workDir, '.claude-files', expected));
      // The parent of the written file is the upload dir and nothing else.
      expect(path.startsWith(join(workDir, '.claude-files') + '/')).toBe(true);
    });

    it('writes nothing outside the working directory for a traversal attempt', async () => {
      const outside = join(workDir, '..', `codeman-escape-${process.pid}.txt`);
      await upload({ filename: `../../${`codeman-escape-${process.pid}.txt`}` });
      await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('strips the shell syntax a terminal would otherwise act on', async () => {
      const res = await upload({ filename: 'notes;rm -rf ~.csv' });
      const { filename } = JSON.parse(res.body).data;
      expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(filename).not.toContain(';');
      expect(filename).not.toContain(' ');
    });

    it('never creates a hidden file', async () => {
      const res = await upload({ filename: '.env' });
      expect(JSON.parse(res.body).data.filename.startsWith('.')).toBe(false);
    });
  });

  // ========== collisions ==========

  describe('collisions', () => {
    it('suffixes -1, -2, … and never overwrites', async () => {
      const first = await upload({ filename: 'report.pdf', bytes: Buffer.from('one') });
      const second = await upload({ filename: 'report.pdf', bytes: Buffer.from('two') });
      const third = await upload({ filename: 'report.pdf', bytes: Buffer.from('three') });

      expect(JSON.parse(first.body).data.filename).toBe('report.pdf');
      expect(JSON.parse(second.body).data.filename).toBe('report-1.pdf');
      expect(JSON.parse(third.body).data.filename).toBe('report-2.pdf');

      const dir = join(workDir, '.claude-files');
      expect(await readFile(join(dir, 'report.pdf'), 'utf8')).toBe('one');
      expect(await readFile(join(dir, 'report-1.pdf'), 'utf8')).toBe('two');
      expect(await readFile(join(dir, 'report-2.pdf'), 'utf8')).toBe('three');
    });

    it('suffixes an extensionless name before the end, not after an extension', async () => {
      await upload({ filename: 'LICENSE' });
      const second = await upload({ filename: 'LICENSE' });
      expect(JSON.parse(second.body).data.filename).toBe('LICENSE-1');
    });
  });

  // ========== symlinks ==========

  describe('symlink safety', () => {
    it('refuses when .claude-files is a symlink to somewhere else', async () => {
      const elsewhere = await mkdtemp(join(tmpdir(), 'codeman-elsewhere-'));
      await symlink(elsewhere, join(workDir, '.claude-files'));

      const res = await upload({ filename: 'report.pdf' });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/\.claude-files is not a regular directory/);
      expect(await readdir(elsewhere)).toEqual([]);

      await rm(elsewhere, { recursive: true, force: true });
    });

    it('does not write THROUGH a symlink planted at the target filename', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'codeman-target-'));
      const target = join(outsideDir, 'target.txt');
      await writeFile(target, 'original');
      await mkdir(join(workDir, '.claude-files'));
      await symlink(target, join(workDir, '.claude-files', 'report.pdf'));

      const res = await upload({ filename: 'report.pdf', bytes: Buffer.from('attacker') });

      // The name is taken by something we refuse to follow → next suffix wins.
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.filename).toBe('report-1.pdf');
      expect(await readFile(target, 'utf8')).toBe('original');
      expect((await lstat(join(workDir, '.claude-files', 'report.pdf'))).isSymbolicLink()).toBe(true);

      await rm(outsideDir, { recursive: true, force: true });
    });

    it('refuses when .claude-files exists as a regular file', async () => {
      await writeFile(join(workDir, '.claude-files'), 'not a directory');
      const res = await upload({ filename: 'report.pdf' });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/not a regular directory/);
    });
  });

  // ========== limits ==========

  describe('limits', () => {
    it('rejects a file past MAX_UPLOAD_FILE_BYTES with 413', async () => {
      const res = await upload({ filename: 'big.bin', bytes: Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1, 0x41) });

      expect(res.statusCode).toBe(413);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      // Client-visible, not a bare 413: the user has to know it was the size.
      expect(body.error).toMatch(/large/i);
      await expect(stat(join(workDir, '.claude-files', 'big.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects an empty file', async () => {
      const res = await upload({ filename: 'empty.txt', bytes: Buffer.alloc(0) });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Empty file/);
    });

    it('rate-limits after 30 uploads per session, sharing the budget with paste-image', async () => {
      // 15 through each route — an attacker must not get 30 on EACH endpoint.
      for (let i = 0; i < 15; i++) {
        expect((await upload({ filename: `f${i}.txt` })).statusCode).toBe(200);
      }
      for (let i = 0; i < 15; i++) {
        const res = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
          headers: {
            host: 'codeman.test',
            origin: 'http://codeman.test',
            'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
          payload: multipartBody('image', 'shot.png', 'image/png', PNG_BYTES),
        });
        expect(res.statusCode).toBe(200);
      }

      const refused = await upload({ filename: 'one-too-many.txt' });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('60');
      expect(JSON.parse(refused.body).error).toMatch(/Rate limit/);
    });
  });

  // ========== request shape ==========

  describe('request shape', () => {
    it('rejects a cross-origin POST (CSRF)', async () => {
      const res = await upload({ headers: { origin: 'http://evil.example' } });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/CSRF/);
    });

    it('accepts a non-browser client that supplies X-Codeman-CSRF', async () => {
      const body = multipartBody('file', 'report.pdf', 'application/pdf', Buffer.from('x'));
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/upload-file`,
        headers: {
          host: 'codeman.test',
          'x-codeman-csrf': '1',
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects a non-browser client with neither Origin, Referer nor the header', async () => {
      const body = multipartBody('file', 'report.pdf', 'application/pdf', Buffer.from('x'));
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/upload-file`,
        headers: { host: 'codeman.test', 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a body that is not multipart', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/upload-file`,
        headers: { host: 'codeman.test', origin: 'http://codeman.test' },
        payload: { file: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/multipart/);
    });

    it('rejects the wrong field name', async () => {
      const res = await upload({ field: 'image' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/expected "file"/);
    });

    it('404s an unknown session before touching the filesystem', async () => {
      const res = await upload({ path: '/api/sessions/does-not-exist/upload-file' });
      expect(res.statusCode).toBe(404);
      await expect(stat(join(workDir, '.claude-files'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  // ========== session modes ==========

  describe('session modes', () => {
    it('refuses a remote (SSH) session, whose workingDir is on another host', async () => {
      harness.ctx._session.remote = { host: 'example.test', username: 'dev', sessionName: 'work' } as never;
      harness.ctx._session.workingDir = 'dev@example.test:work';

      const res = await upload({ filename: 'report.pdf' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/remote \(SSH\)/);
      // The pseudo-path is RELATIVE — the refusal is what stops it landing
      // under the server's own cwd.
      await expect(stat(join(process.cwd(), 'dev@example.test:work'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a remote session on the image route too', async () => {
      harness.ctx._session.remote = { host: 'example.test', username: 'dev', sessionName: 'work' } as never;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        },
        payload: multipartBody('image', 'shot.png', 'image/png', PNG_BYTES),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/remote \(SSH\)/);
    });

    it('writes normally for a docker session — workingDir is the bind-mount host side', async () => {
      harness.ctx._session.docker = { containerWorkdir: '/workspace' } as never;

      const res = await upload({ filename: 'report.pdf' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.path).toBe(join(workDir, '.claude-files', 'report.pdf'));
    });
  });
});
