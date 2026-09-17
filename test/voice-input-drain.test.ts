/**
 * @fileoverview Unit tests for the Deepgram stop/drain path in voice-input.js.
 *
 * Loads the browser module into a vm sandbox (no real DOM) and drives a fake
 * WebSocket + MediaRecorder against it. Focus: the last utterance survives a
 * manual stop (recorder flush -> CloseStream -> bounded wait for the tail) and
 * is inserted EXACTLY once on every exit — drained stop, drain timeout, a socket
 * that errors and closes, and a new recording started mid-drain. Web Speech is
 * covered as the "other providers keep their behaviour" guard.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SRC = readFileSync(resolve(import.meta.dirname, '../src/web/public/voice-input.js'), 'utf8');

/** Let pending microtasks and 0ms timers run. */
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeElement(): any {
  const el: any = {
    className: '',
    title: '',
    innerHTML: '',
    textContent: '',
    style: {},
    children: [] as any[],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    appendChild: (c: any) => {
      el.children.push(c);
      return c;
    },
    querySelector: () => null,
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };
  return el;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  constructor(public url: string) {}
  send(payload: unknown) {
    this.sent.push(payload);
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  /** Deliver a server frame, ignoring frames sent after the socket was detached. */
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class FakeMediaRecorder {
  static isTypeSupported = (mime: string) => mime === 'audio/webm;codecs=opus';
  state = 'inactive';
  ondataavailable: ((e: unknown) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

class FakeSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 1;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start() {}
  stop() {}
}

function loadVoiceHarness(settings: Record<string, unknown> = {}) {
  const sockets: FakeWebSocket[] = [];
  const inserted: string[] = [];
  const toasts: string[] = [];
  const config = { provider: 'deepgram', apiKey: 'k', insertMode: 'direct', ...settings };

  const app = {
    activeSessionId: 's1',
    terminal: null,
    _localEchoEnabled: false,
    _localEchoOverlay: null,
    _predictiveEcho: null,
    showToast: (msg: string) => toasts.push(msg),
    sendInput: (text: string) => {
      inserted.push(text);
      return Promise.resolve();
    },
  };

  const documentObj = {
    body: makeElement(),
    createElement: () => makeElement(),
    createTextNode: (text: string) => ({ textContent: text }),
    getElementById: () => null,
    querySelector: () => null,
  };

  const context = vm.createContext({
    window: { SpeechRecognition: FakeSpeechRecognition },
    document: documentObj,
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }),
      },
    },
    location: { protocol: 'https:', host: 'example.test' },
    localStorage: {
      getItem: () => JSON.stringify(config),
      setItem: () => {},
    },
    app,
    WebSocket: new Proxy(FakeWebSocket, {
      construct(target, args: any[]) {
        const ws = new target(args[0]);
        sockets.push(ws);
        return ws;
      },
    }),
    MediaRecorder: FakeMediaRecorder,
    URLSearchParams,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
    console,
  });

  vm.runInContext(SRC, context, { filename: 'voice-input.js' });
  const VoiceInput = vm.runInContext('VoiceInput', context);
  const DeepgramProvider = vm.runInContext('DeepgramProvider', context);
  // Keep the bounded wait short so the timeout path is testable in real time.
  DeepgramProvider.DRAIN_MS = 30;

  return { VoiceInput, DeepgramProvider, sockets, inserted, toasts };
}

/** Start a Deepgram recording and return the connected socket. */
async function startDeepgram(h: ReturnType<typeof loadVoiceHarness>) {
  h.VoiceInput.start();
  await tick();
  const ws = h.sockets[h.sockets.length - 1];
  ws.onopen?.();
  return ws;
}

function result(transcript: string, isFinal: boolean) {
  return { type: 'Results', is_final: isFinal, channel: { alternatives: [{ transcript }] } };
}

describe('Deepgram voice drain', () => {
  it('sends CloseStream on stop and inserts the tail that arrives after it', async () => {
    const h = loadVoiceHarness();
    const ws = await startDeepgram(h);

    ws.emit(result('open the config file', true));
    h.VoiceInput.stop();
    await tick();

    // The stop asks Deepgram to transcribe its buffered audio, and nothing is
    // inserted yet — the tail of the last utterance is still in flight.
    expect(ws.sent).toContain(JSON.stringify({ type: 'CloseStream' }));
    expect(h.inserted).toEqual([]);

    ws.emit(result('and run the tests', true));
    ws.emit({ type: 'Metadata' });
    await tick();

    expect(h.inserted).toEqual(['open the config file and run the tests']);
    expect(ws.closedWith).toBe(1000);
  });

  it('inserts once anyway when Deepgram never answers the CloseStream', async () => {
    const h = loadVoiceHarness();
    const ws = await startDeepgram(h);

    ws.emit(result('a single sentence', true));
    h.VoiceInput.stop();
    await tick(80); // DRAIN_MS is 30 in the harness

    expect(h.inserted).toEqual(['a single sentence']);
    expect(ws.closedWith).toBe(1000);
    expect(h.VoiceInput.isRecording).toBe(false);
  });

  it('inserts once, not twice, when the socket errors and closes on its own', async () => {
    const h = loadVoiceHarness();
    const ws = await startDeepgram(h);

    ws.emit(result('half a thought', true));
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onclose?.({ code: 1006 });
    await tick(80);

    expect(h.inserted).toEqual(['half a thought']);
    expect(h.toasts).toHaveLength(1);
  });

  it('flushes the pending transcript when a new recording starts mid-drain', async () => {
    const h = loadVoiceHarness();
    const first = await startDeepgram(h);

    first.emit(result('first dictation', true));
    h.VoiceInput.stop();
    await tick();
    expect(h.inserted).toEqual([]);

    const second = await startDeepgram(h);
    expect(h.inserted).toEqual(['first dictation']);

    second.emit(result('second dictation', true));
    h.VoiceInput.stop();
    await tick(80);

    expect(h.inserted).toEqual(['first dictation', 'second dictation']);
  });

  it('leaves Web Speech alone: its own final still inserts on the spot', async () => {
    const h = loadVoiceHarness({ provider: 'webspeech' });
    h.VoiceInput.start();
    await tick();

    h.VoiceInput._onWebSpeechResult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'plain browser dictation' }], { isFinal: true })],
    });

    expect(h.inserted).toEqual(['plain browser dictation']);
    expect(h.sockets).toHaveLength(0);
    expect(h.VoiceInput._draining).toBe(false);
    expect(h.VoiceInput.isRecording).toBe(false);
  });
});
