/**
 * Fake `codex app-server` child for AppServerClient tests: speaks the JSONL
 * wire from docs/PROTOCOL_NOTES.md and replays captured fixtures from
 * scripts/fixtures/appserver — no real codex binary in CI.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import type { AppServerChildProcess, SpawnAppServer } from '../../src/codex/index.js';

export interface WireMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/fixtures/appserver',
);

/** Parsed lines of a captured fixture (inbound server messages only). */
export function loadFixture(name: string): WireMessage[] {
  const raw = fs.readFileSync(path.join(fixturesDir, name), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as WireMessage);
}

/** The notification lines of a fixture, in capture order. */
export function fixtureNotifications(name: string): WireMessage[] {
  return loadFixture(name).filter((msg) => msg.method !== undefined && msg.id === undefined);
}

export class FakeAppServer extends EventEmitter implements AppServerChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  pid = 4242;
  killed = false;
  exited = false;

  /** Everything the client wrote, parsed, in order. */
  readonly received: WireMessage[] = [];
  /** Respond to `initialize` automatically (fixture 01 shape). */
  autoInitialize = true;

  private buffer = '';
  private handlers = new Map<string, (msg: WireMessage) => void>();
  private waiters: Array<{
    predicate: (msg: WireMessage) => boolean;
    resolve: (msg: WireMessage) => void;
  }> = [];

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.ingest(String(chunk));
        cb();
      },
    });
  }

  /** Register a scripted reaction to a client request/notification method. */
  onMethod(method: string, handler: (msg: WireMessage) => void): void {
    this.handlers.set(method, handler);
  }

  /** Raw line to the client. */
  send(msg: WireMessage): void {
    if (this.exited) return;
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  notifyClient(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /** Server→client request (e.g. mcpServer/elicitation/request). */
  serverRequest(id: number | string, method: string, params: unknown): void {
    this.send({ id, method, params });
  }

  /** Resolves with the first received message matching `predicate` (past or future). */
  waitFor(predicate: (msg: WireMessage) => boolean, timeoutMs = 5_000): Promise<WireMessage> {
    const existing = this.received.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('FakeAppServer.waitFor timed out')),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitNow(null, signal ?? 'SIGTERM');
    return true;
  }

  /** Simulate an unexpected child death. */
  exitNow(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('exit', code, signal));
  }

  /** Simulate a spawn failure (e.g. ENOENT) — emits 'error', like node does. */
  failSpawn(message = 'spawn codex ENOENT'): void {
    this.exited = true;
    setImmediate(() => this.emit('error', new Error(message)));
  }

  private ingest(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const msg = JSON.parse(line) as WireMessage;
      this.received.push(msg);
      this.dispatch(msg);
    }
  }

  private dispatch(msg: WireMessage): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(msg)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(msg);
      }
    }
    if (msg.method === undefined) return;
    const handler = this.handlers.get(msg.method);
    if (handler !== undefined) {
      handler(msg);
      return;
    }
    if (this.autoInitialize && msg.method === 'initialize' && msg.id !== undefined) {
      this.respond(msg.id, {
        userAgent: 'fake/0.144.4',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      });
    }
  }
}

/**
 * spawnFn stand-in: hands out a fresh FakeAppServer per spawn and records
 * every spawn (bin, args, child, timestamp) for restart/arg assertions.
 */
export function fakeSpawner(configure?: (fake: FakeAppServer, spawnIndex: number) => void): {
  spawnFn: SpawnAppServer;
  spawns: Array<{ bin: string; args: string[]; child: FakeAppServer; at: number }>;
} {
  const spawns: Array<{ bin: string; args: string[]; child: FakeAppServer; at: number }> = [];
  const spawnFn: SpawnAppServer = (bin, args) => {
    const child = new FakeAppServer();
    configure?.(child, spawns.length);
    spawns.push({ bin, args, child, at: Date.now() });
    return child;
  };
  return { spawnFn, spawns };
}
