import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import { runInspectProject } from '../src/tools/inspect-project.js';

/**
 * Integration test for the truth layer. A temp project supplies config truth;
 * an injected runner supplies execution truth (`pio project config`). No real
 * PlatformIO binary is required.
 *
 * The resolved-config runner emits the real CLI shape: a list of
 * `[section, [[key, value], ...]]` pairs, where framework is a list and
 * board/platform are scalars. Verified against PlatformIO 6.1.x.
 */

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'pioneer-inspect-'));
  process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
});

afterEach(async () => {
  setProcessRunner();
  delete process.env.PLATFORMIO_CLI_PATH;
  await rm(projectDir, { recursive: true, force: true });
});

/** Builds the `pio project config --json-output` list for given envs. */
function configListRunner(
  envs: Record<
    string,
    { platform?: string; board?: string; framework?: string[] }
  >
): ProcessRunner {
  const list = Object.entries(envs).map(([name, opts]) => {
    const options: Array<[string, unknown]> = [];
    if (opts.platform) options.push(['platform', opts.platform]);
    if (opts.board) options.push(['board', opts.board]);
    if (opts.framework) options.push(['framework', opts.framework]);
    return [`env:${name}`, options];
  });
  return async (_file, args) => {
    if (args.includes('config')) {
      return { stdout: JSON.stringify(list), stderr: '', exitCode: 0 };
    }
    return {
      stdout: 'PlatformIO Core, version 6.1.19',
      stderr: '',
      exitCode: 0,
    };
  };
}

describe('inspect_project', () => {
  it('reconciles config truth with resolved execution config', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[platformio]\ndefault_envs = esp32dev\n\n[env:esp32dev]\nplatform = espressif32\nboard = esp32dev\nframework = arduino\n'
    );
    setProcessRunner(
      configListRunner({
        esp32dev: {
          platform: 'espressif32',
          board: 'esp32dev',
          framework: ['arduino'],
        },
      })
    );

    const response = await runInspectProject({ projectDir });

    expect(response.status).toBe('ok');
    expect(response.data?.environmentResolution).toBe('default_envs');
    expect(response.data?.resolvedEnvironment).toBe('esp32dev');
    expect(response.data?.resolvedConfigAvailable).toBe(true);
    expect(response.data?.resolvedEnvironments[0]?.board).toBe('esp32dev');
    expect(response.data?.discrepancies).toHaveLength(0);
    expect(response.data?.meta.executionStatus).toBe('succeeded');
  });

  it('flags a discrepancy when config board differs from resolved board', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:only]\nboard = esp32dev\n'
    );
    setProcessRunner(
      configListRunner({
        only: { board: 'esp32-s3-devkitc-1' },
      })
    );

    const response = await runInspectProject({ projectDir });

    expect(response.status).toBe('warning');
    expect(response.data?.discrepancies).toHaveLength(1);
    expect(response.data?.discrepancies[0]?.field).toBe('board');
    expect(response.data?.discrepancies[0]?.executionValue).toBe(
      'esp32-s3-devkitc-1'
    );
  });

  it('degrades to partial when resolved config is unavailable', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:a]\nboard = x\n\n[env:b]\nboard = y\n'
    );
    setProcessRunner(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }));

    const response = await runInspectProject({ projectDir });

    expect(response.status).toBe('warning');
    expect(response.data?.resolvedConfigAvailable).toBe(false);
    expect(response.data?.environmentResolution).toBe('ambiguous');
    expect(response.data?.meta.executionStatus).toBe('partial');
    expect(response.nextActions.some((a) => a.includes('doctor'))).toBe(true);
  });

  it('errors when platformio.ini is absent', async () => {
    const response = await runInspectProject({ projectDir });
    expect(response.status).toBe('error');
    expect(response.data).toBeNull();
  });
});
