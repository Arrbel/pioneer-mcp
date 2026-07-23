/**
 * Persistent serial monitor sessions.
 *
 * Why this exists (the core MCP-over-CLI advantage): opening a serial port
 * toggles DTR/RTS, which resets most dev boards. A one-shot capture therefore
 * only ever sees the boot banner and misses everything after. A persistent
 * session keeps a single `pio device monitor` process alive across multiple
 * reads, so an agent can open once, then poll output over time without
 * re-resetting the board on every read.
 *
 * Like the exec layer, the process spawner is injectable so tests never spawn a
 * real monitor or need a physical device.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolvePioBinary, PioNotFoundError } from './exec.js';

/** Max buffered lines per session; oldest are dropped when exceeded. */
export const MONITOR_BUFFER_LINES = 2000;

/** A live monitor child process, abstracted for testability. */
export interface MonitorProcess {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
  readonly pid?: number;
}

/** Spawns a monitor process for the given binary/args. */
export type MonitorSpawner = (binary: string, args: string[]) => MonitorProcess;

const defaultSpawner: MonitorSpawner = (binary, args) => {
  const child = spawn(binary, args, { windowsHide: true });
  return {
    pid: child.pid,
    onData(listener) {
      child.stdout?.on('data', (buf: Buffer) => listener(buf.toString('utf8')));
      child.stderr?.on('data', (buf: Buffer) => listener(buf.toString('utf8')));
    },
    onExit(listener) {
      child.on('exit', (code) => listener(code));
    },
    kill() {
      child.kill();
    },
  };
};

let spawner: MonitorSpawner = defaultSpawner;

/** Overrides the monitor spawner (tests). Pass nothing to restore default. */
export function setMonitorSpawner(next?: MonitorSpawner): void {
  spawner = next ?? defaultSpawner;
}

export type SessionStatus = 'running' | 'exited';

interface Session {
  id: string;
  port: string;
  baud?: number;
  process: MonitorProcess;
  status: SessionStatus;
  exitCode: number | null;
  createdAt: number;
  /** Completed lines, capped at MONITOR_BUFFER_LINES. */
  lines: string[];
  /** Partial trailing text not yet terminated by a newline. */
  pending: string;
  /** Monotonic count of lines ever produced (survives ring-buffer drops). */
  totalProduced: number;
  /** Monotonic index of the next line the caller has not yet read. */
  readCursor: number;
}

const sessions = new Map<string, Session>();

function appendData(session: Session, chunk: string): void {
  session.pending += chunk;
  const parts = session.pending.split(/\r?\n/);
  session.pending = parts.pop() ?? '';
  for (const line of parts) {
    session.lines.push(line);
    session.totalProduced += 1;
    if (session.lines.length > MONITOR_BUFFER_LINES) {
      session.lines.shift();
    }
  }
}

export interface OpenResult {
  sessionId: string;
  port: string;
  baud?: number;
  pid?: number;
}

/** Opens a persistent monitor session. Throws PioNotFoundError if no CLI. */
export async function openSession(
  port: string,
  baud?: number
): Promise<OpenResult> {
  const binary = await resolvePioBinary();
  if (!binary) throw new PioNotFoundError();

  const args = ['device', 'monitor', '--port', port];
  // Only pass --baud when explicit; otherwise platformio.ini monitor_speed wins.
  if (baud) args.push('--baud', String(baud));

  const proc = spawner(binary, args);
  const session: Session = {
    id: randomUUID(),
    port,
    baud,
    process: proc,
    status: 'running',
    exitCode: null,
    createdAt: Date.now(),
    lines: [],
    pending: '',
    totalProduced: 0,
    readCursor: 0,
  };

  proc.onData((chunk) => appendData(session, chunk));
  proc.onExit((code) => {
    session.status = 'exited';
    session.exitCode = code;
  });

  sessions.set(session.id, session);
  return { sessionId: session.id, port, baud, pid: proc.pid };
}

export interface ReadResult {
  found: boolean;
  status?: SessionStatus;
  exitCode?: number | null;
  lines: string[];
  /** Lines lost from the buffer before the read cursor (ring overflow). */
  droppedLines: number;
  hasMore: boolean;
}

/**
 * Reads output from a session. By default returns only lines produced since the
 * previous read (advancing the cursor); pass fromStart to return the full
 * retained buffer without advancing incremental semantics.
 */
export function readSession(sessionId: string, fromStart = false): ReadResult {
  const session = sessions.get(sessionId);
  if (!session) {
    return { found: false, lines: [], droppedLines: 0, hasMore: false };
  }

  const bufferStart = session.totalProduced - session.lines.length;

  if (fromStart) {
    session.readCursor = session.totalProduced;
    return {
      found: true,
      status: session.status,
      exitCode: session.exitCode,
      lines: [...session.lines],
      droppedLines: 0,
      hasMore: false,
    };
  }

  const start = Math.max(session.readCursor, bufferStart);
  const droppedLines = Math.max(0, bufferStart - session.readCursor);
  const sliceFrom = start - bufferStart;
  const lines = session.lines.slice(sliceFrom);
  session.readCursor = session.totalProduced;

  return {
    found: true,
    status: session.status,
    exitCode: session.exitCode,
    lines,
    droppedLines,
    hasMore: false,
  };
}

export interface CloseResult {
  found: boolean;
  port?: string;
  totalLines?: number;
}

/** Closes a session, killing its process and removing it from the store. */
export function closeSession(sessionId: string): CloseResult {
  const session = sessions.get(sessionId);
  if (!session) return { found: false };
  if (session.status === 'running') {
    session.process.kill();
  }
  sessions.delete(sessionId);
  return { found: true, port: session.port, totalLines: session.totalProduced };
}

/** Returns lightweight metadata for all open sessions. */
export function listSessions(): {
  sessionId: string;
  port: string;
  status: SessionStatus;
}[] {
  return Array.from(sessions.values()).map((s) => ({
    sessionId: s.id,
    port: s.port,
    status: s.status,
  }));
}

/** Closes every session. Primarily for test cleanup and shutdown. */
export function closeAllSessions(): void {
  for (const id of Array.from(sessions.keys())) closeSession(id);
}
