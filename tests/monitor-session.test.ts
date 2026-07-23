import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import {
  setMonitorSpawner,
  closeAllSessions,
  type MonitorProcess,
  type MonitorSpawner,
} from '../src/pio/monitor.js';
import {
  runOpenMonitorSession,
  runReadMonitorSession,
  runCloseMonitorSession,
} from '../src/tools/monitor-session.js';

/**
 * Monitor-session tests. A fake spawner lets us push scripted serial output and
 * drive exit, proving the persistent read model (open once, read incrementally)
 * without any real device or `pio device monitor` process.
 */

const versionRunner: ProcessRunner = async () => ({
  stdout: 'PlatformIO Core, version 6.1.19',
  stderr: '',
  exitCode: 0,
});

/** A controllable fake monitor process. */
class FakeProcess implements MonitorProcess {
  pid = 4242;
  private dataListeners: ((chunk: string) => void)[] = [];
  private exitListeners: ((code: number | null) => void)[] = [];
  killed = false;

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }
  kill(): void {
    this.killed = true;
  }
  emit(chunk: string): void {
    for (const l of this.dataListeners) l(chunk);
  }
  exit(code: number | null): void {
    for (const l of this.exitListeners) l(code);
  }
}

let fake: FakeProcess;

beforeEach(() => {
  process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
  setProcessRunner(versionRunner);
  fake = new FakeProcess();
  const spawner: MonitorSpawner = () => fake;
  setMonitorSpawner(spawner);
});

afterEach(() => {
  closeAllSessions();
  setMonitorSpawner();
  setProcessRunner();
  delete process.env.PLATFORMIO_CLI_PATH;
});

async function openSessionId(): Promise<string> {
  const opened = await runOpenMonitorSession({ port: 'COM5', baud: 115200 });
  return opened.data!.sessionId;
}

describe('monitor session lifecycle', () => {
  it('opens, reads incrementally, and closes', async () => {
    const sessionId = await openSessionId();

    fake.emit('boot line 1\nboot line 2\n');
    const first = await runReadMonitorSession({ sessionId });
    expect(first.data?.lines).toEqual(['boot line 1', 'boot line 2']);

    // A second read returns only new lines (incremental cursor).
    fake.emit('runtime line 3\n');
    const second = await runReadMonitorSession({ sessionId });
    expect(second.data?.lines).toEqual(['runtime line 3']);

    const closed = await runCloseMonitorSession({ sessionId });
    expect(closed.status).toBe('ok');
    expect(fake.killed).toBe(true);
    expect(closed.data?.totalLines).toBe(3);
  });

  it('buffers partial lines until a newline arrives', async () => {
    const sessionId = await openSessionId();
    fake.emit('partial ');
    const empty = await runReadMonitorSession({ sessionId });
    expect(empty.data?.lines).toEqual([]);
    fake.emit('completed\n');
    const done = await runReadMonitorSession({ sessionId });
    expect(done.data?.lines).toEqual(['partial completed']);
  });

  it('reports the exited status after the process ends', async () => {
    const sessionId = await openSessionId();
    fake.emit('last words\n');
    fake.exit(0);
    const read = await runReadMonitorSession({ sessionId });
    expect(read.status).toBe('warning');
    expect(read.data?.status).toBe('exited');
    expect(read.data?.lines).toEqual(['last words']);
  });

  it('errors when reading an unknown session', async () => {
    const read = await runReadMonitorSession({ sessionId: 'does-not-exist' });
    expect(read.status).toBe('error');
    expect(read.data).toBeNull();
  });

  it('fromStart returns the full retained buffer', async () => {
    const sessionId = await openSessionId();
    fake.emit('a\nb\nc\n');
    await runReadMonitorSession({ sessionId }); // advance cursor past all
    const full = await runReadMonitorSession({ sessionId, fromStart: true });
    expect(full.data?.lines).toEqual(['a', 'b', 'c']);
  });
});
