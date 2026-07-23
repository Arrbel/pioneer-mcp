import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import { parseDevices, runListDevices } from '../src/tools/list-devices.js';
import { parseBoards, runListBoards } from '../src/tools/list-boards.js';
import { runListEnvironments } from '../src/tools/list-environments.js';

/**
 * Read-layer tool tests. Pure parsers are tested directly; CLI-backed tools use
 * an injected runner so no real PlatformIO binary is touched.
 */

afterEach(() => {
  setProcessRunner();
  delete process.env.PLATFORMIO_CLI_PATH;
});

function jsonRunner(payload: unknown): ProcessRunner {
  return async () => ({
    stdout: JSON.stringify(payload),
    stderr: '',
    exitCode: 0,
  });
}

describe('parseDevices', () => {
  it('normalizes device records and drops entries without a port', () => {
    const devices = parseDevices(
      JSON.stringify([
        { port: 'COM3', description: 'USB Serial', hwid: 'USB VID:PID=10C4' },
        { description: 'no port here' },
      ])
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]?.port).toBe('COM3');
  });

  it('returns empty on invalid json', () => {
    expect(parseDevices('not json')).toEqual([]);
  });
});

describe('list_devices', () => {
  beforeEach(() => {
    process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
  });

  it('reports connected devices', async () => {
    setProcessRunner(jsonRunner([{ port: 'COM5', description: 'ESP32' }]));
    const response = await runListDevices();
    expect(response.status).toBe('ok');
    expect(response.data?.devices).toHaveLength(1);
  });

  it('warns when no devices are present', async () => {
    setProcessRunner(jsonRunner([]));
    const response = await runListDevices();
    expect(response.status).toBe('warning');
    expect(response.data?.devices).toHaveLength(0);
  });
});

describe('parseBoards', () => {
  it('normalizes board summaries', () => {
    const boards = parseBoards(
      JSON.stringify([
        {
          id: 'esp32dev',
          name: 'Espressif ESP32 Dev',
          platform: 'espressif32',
          mcu: 'ESP32',
        },
      ])
    );
    expect(boards[0]?.id).toBe('esp32dev');
    expect(boards[0]?.mcu).toBe('ESP32');
  });
});

describe('list_boards', () => {
  beforeEach(() => {
    process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
  });

  it('caps results and reports truncation', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `board${i}` }));
    setProcessRunner(jsonRunner(many));
    const response = await runListBoards({ query: 'board', limit: 2 });
    expect(response.data?.totalMatched).toBe(5);
    expect(response.data?.boards).toHaveLength(2);
    expect(response.data?.truncated).toBe(true);
    expect(response.status).toBe('warning');
  });

  it('warns when nothing matches', async () => {
    setProcessRunner(jsonRunner([]));
    const response = await runListBoards({ query: 'nonexistent' });
    expect(response.status).toBe('warning');
    expect(response.data?.totalMatched).toBe(0);
  });
});

describe('list_environments', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pioneer-envs-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('lists environments from config without touching the CLI', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[platformio]\ndefault_envs = a\n\n[env:a]\nboard = x\n\n[env:b]\nboard = y\n'
    );
    const response = await runListEnvironments({ projectDir });
    expect(response.data?.environments).toHaveLength(2);
    expect(response.data?.resolvedEnvironment).toBe('a');
    expect(response.data?.environmentResolution).toBe('default_envs');
  });

  it('errors when platformio.ini is missing', async () => {
    const response = await runListEnvironments({ projectDir });
    expect(response.status).toBe('error');
    expect(response.data).toBeNull();
  });
});
