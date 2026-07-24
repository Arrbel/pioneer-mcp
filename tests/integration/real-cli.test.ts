/**
 * Real-CLI integration tests.
 *
 * Unlike the unit tests, these run the ACTUAL PlatformIO binary — no injected
 * runner — to lock our assumptions about `pio` output formats. This is the one
 * place mocks cannot lie: it caught that `pio project metadata` carries no
 * board/platform/framework and that `pio project config` is the correct source.
 *
 * The whole suite self-skips when no real PlatformIO CLI resolves, so the
 * default `npm test` stays green on machines/CI without PlatformIO installed.
 * To run locally, ensure `pio` is on PATH or set PLATFORMIO_CLI_PATH.
 *
 * Every command used here (`project config`, `boards`, static ini parsing) runs
 * offline with no toolchain download, so the suite is fast and network-free.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resetPioCache,
  resolvePioBinary,
  setProcessRunner,
} from '../../src/pio/exec.js';
import { runInspectProject } from '../../src/tools/inspect-project.js';
import { runListBoards } from '../../src/tools/list-boards.js';
import { runListEnvironments } from '../../src/tools/list-environments.js';

// Use the real process runner (undo any mock a prior file may have set) and
// probe for an actual binary before deciding whether to run.
setProcessRunner();
resetPioCache();
const pioBinary = await resolvePioBinary();
const pioAvailable = Boolean(pioBinary);

if (!pioAvailable) {
  console.warn(
    '[integration] No PlatformIO CLI resolved — skipping real-CLI tests. ' +
      'Install PlatformIO or set PLATFORMIO_CLI_PATH to run them.'
  );
}

const UNO_INI =
  '[env:uno]\n' +
  'platform = atmelavr\n' +
  'board = uno\n' +
  'framework = arduino\n' +
  'monitor_speed = 115200\n';

describe.skipIf(!pioAvailable)('real PlatformIO CLI', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pioneer-realcli-'));
    await writeFile(join(projectDir, 'platformio.ini'), UNO_INI, 'utf8');
  });

  afterAll(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('inspect_project resolves real execution-truth config', async () => {
    const response = await runInspectProject({ projectDir });

    expect(response.status).not.toBe('error');
    expect(response.data?.resolvedConfigAvailable).toBe(true);

    const uno = response.data?.resolvedEnvironments.find(
      (e) => e.name === 'uno'
    );
    expect(uno).toBeDefined();
    expect(uno?.board).toBe('uno');
    expect(uno?.platform).toBe('atmelavr');
    expect(uno?.framework).toContain('arduino');

    // Static parse and resolved config agree on this simple project.
    expect(response.data?.discrepancies).toHaveLength(0);

    // A lone environment resolves without ambiguity.
    expect(response.data?.resolvedEnvironment).toBe('uno');
  });

  it('inspect_project errors on a directory with no platformio.ini', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'pioneer-realcli-empty-'));
    try {
      const response = await runInspectProject({ projectDir: emptyDir });
      expect(response.status).toBe('error');
      expect(response.data).toBeNull();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('list_environments reads the declared environment', async () => {
    const response = await runListEnvironments({ projectDir });
    expect(response.status).not.toBe('error');
    const names = response.data?.environments.map((e) => e.name) ?? [];
    expect(names).toContain('uno');
  });

  it('list_boards finds the uno board in the real catalog', async () => {
    const response = await runListBoards({ query: 'uno' });
    expect(response.status).not.toBe('error');
    const board = response.data?.boards.find((b) => b.id === 'uno');
    expect(board).toBeDefined();
    expect(board?.platform).toBe('atmelavr');
    expect(board?.frameworks).toContain('arduino');
  });
});
