/**
 * @fileoverview Unit tests for the client-side attachment router in
 * image-input.js.
 *
 * `_uploadAndInsertAttachments()` is the single pipeline behind the terminal
 * drop, the toolbar paperclip and the mobile paste dialog. It splits a batch by
 * MIME — images keep the normalize-then-/paste-image path, everything else goes
 * verbatim to /upload-file — and then inserts every saved path into the terminal
 * in ONE send, in the order the files arrived. These tests pin the routing and
 * the ordering, since a batch that silently posts a pdf to the image endpoint
 * fails with a magic-byte error the user cannot act on.
 *
 * Loads the browser module into a vm sandbox with fake DOM/network globals.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface FakeFile {
  name: string;
  type: string;
  size: number;
}

interface PostedUpload {
  url: string;
  field: string;
  file: FakeFile;
}

interface Harness {
  app: Record<string, unknown>;
  posts: PostedUpload[];
  sent: string[];
  toasts: Array<{ message: string; tone: string }>;
  /** Next response per URL substring; default is a success naming the file. */
  failWith: (message: string) => void;
}

function file(name: string, type: string, size = 128): FakeFile {
  return { name, type, size };
}

function loadHarness(): Harness {
  const posts: PostedUpload[] = [];
  const sent: string[] = [];
  const toasts: Array<{ message: string; tone: string }> = [];
  let failure: string | null = null;

  class FakeFormData {
    entries: Array<[string, FakeFile]> = [];
    append(field: string, value: FakeFile) {
      this.entries.push([field, value]);
    }
  }

  const context = vm.createContext({
    window: { addEventListener: () => {} },
    document: { createElement: () => ({ style: {} }), body: { appendChild: () => {} }, getElementById: () => null },
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    console: { warn: () => {}, log: () => {} },
    FormData: FakeFormData,
    fetch: async (url: string, init: { body: FakeFormData }) => {
      const [field, value] = init.body.entries[0];
      posts.push({ url, field, file: value });
      if (failure) {
        return {
          ok: false,
          status: 413,
          json: async () => ({ error: failure }),
        };
      }
      const dir = url.includes('/paste-image') ? '.claude-images' : '.claude-files';
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { path: `/work/${dir}/${value.name}`, filename: value.name } }),
      };
    },
  });

  vm.runInContext('class CodemanApp {}', context);
  const src = readFileSync(resolve(import.meta.dirname, '../src/web/public/image-input.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => Record<string, unknown>;

  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  // The real one decodes through <canvas>, which the sandbox has no business
  // providing; the routing decision under test happens before it.
  app._normalizeImageForUpload = async (f: FakeFile) => f;
  app.sendInput = async (text: string) => {
    sent.push(text);
  };
  app.showToast = (message: string, tone: string) => {
    toasts.push({ message, tone });
  };

  return {
    app,
    posts,
    sent,
    toasts,
    failWith(message: string) {
      failure = message;
    },
  };
}

async function attach(h: Harness, files: FakeFile[]): Promise<void> {
  await (h.app._uploadAndInsertAttachments as (f: unknown) => Promise<void>).call(h.app, files);
}

describe('client attachment routing', () => {
  it('sends an image to /paste-image as field "image"', async () => {
    const h = loadHarness();
    await attach(h, [file('shot.png', 'image/png')]);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].url).toBe('/api/sessions/session-1/paste-image');
    expect(h.posts[0].field).toBe('image');
    expect(h.sent).toEqual(['/work/.claude-images/shot.png']);
  });

  it.each([
    ['report.pdf', 'application/pdf'],
    ['notes.csv', 'text/csv'],
    ['archive.zip', 'application/zip'],
    ['server.log', 'text/plain'],
    ['unknown.bin', ''],
  ])('sends %s to /upload-file as field "file"', async (name, type) => {
    const h = loadHarness();
    await attach(h, [file(name, type)]);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].url).toBe('/api/sessions/session-1/upload-file');
    expect(h.posts[0].field).toBe('file');
    expect(h.sent).toEqual([`/work/.claude-files/${name}`]);
  });

  it('splits a mixed batch and inserts every path in ONE send, in drop order', async () => {
    const h = loadHarness();
    await attach(h, [
      file('report.pdf', 'application/pdf'),
      file('shot.png', 'image/png'),
      file('notes.csv', 'text/csv'),
    ]);

    // Requests run concurrently, so POST order is not the contract — which
    // endpoint each file reached is. The INSERT order below is the contract.
    expect(h.posts.filter((p) => p.url.endsWith('/paste-image')).map((p) => p.file.name)).toEqual(['shot.png']);
    expect(
      h.posts
        .filter((p) => p.url.endsWith('/upload-file'))
        .map((p) => p.file.name)
        .sort()
    ).toEqual(['notes.csv', 'report.pdf']);
    expect(h.sent).toEqual([
      '/work/.claude-files/report.pdf /work/.claude-images/shot.png /work/.claude-files/notes.csv',
    ]);
  });

  it('caps the batch and says so instead of truncating silently', async () => {
    const h = loadHarness();
    const cap = h.app._maxBatchUploads as number;
    await attach(
      h,
      Array.from({ length: cap + 5 }, (_, i) => file(`f${i}.txt`, 'text/plain'))
    );

    expect(h.posts).toHaveLength(cap);
    expect(h.toasts[h.toasts.length - 1].message).toContain(`max ${cap} per batch`);
  });

  it('skips a dropped folder (a 0-byte entry) with an honest message', async () => {
    const h = loadHarness();
    await attach(h, [file('some-folder', '', 0)]);

    expect(h.posts).toHaveLength(0);
    expect(h.toasts[0].tone).toBe('error');
    expect(h.toasts[0].message).toMatch(/folders and empty files are skipped/);
  });

  it('surfaces the server reason rather than a bare failure count', async () => {
    const h = loadHarness();
    h.failWith('File too large (max 25MB)');
    await attach(h, [file('big.bin', 'application/octet-stream')]);

    expect(h.sent).toEqual([]);
    const last = h.toasts[h.toasts.length - 1];
    expect(last.tone).toBe('error');
    expect(last.message).toContain('File too large (max 25MB)');
  });

  it('does nothing without an active session', async () => {
    const h = loadHarness();
    h.app.activeSessionId = null;
    await attach(h, [file('report.pdf', 'application/pdf')]);

    expect(h.posts).toHaveLength(0);
    expect(h.sent).toEqual([]);
  });

  it('keeps _uploadAndInsertImages working as the image-only entry point', async () => {
    const h = loadHarness();
    await (h.app._uploadAndInsertImages as (f: unknown) => Promise<void>).call(h.app, [file('shot.png', 'image/png')]);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].url).toBe('/api/sessions/session-1/paste-image');
  });
});
