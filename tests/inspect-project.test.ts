import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import { runInspectProject } from '../src/tools/inspect-project.js';

/**
 * Integration test for the truth layer. A temp project supplies config truth;
 * an injected runner supplies execution truth (pio project metadata). No real
 * PlatformIO binary is required.
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

function metadataRunner(metadata: unknown): ProcessRunner {
  return async (_file, args) => {
    if (args.includes('metadata')) {
      return { stdout: JSON.stringify(metadata), stderr: '', exitCode: 0 };
    }
    return { stdout: 'PlatformIO Core, version 6.1.19', stderr: '', exitCode: 0 };
  };
}

describe('inspect_project', () => {
  it('reconciles config truth with execution metadata', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[platformio]\ndefault_envs = esp32dev\n\n[env:esp32dev]\nplatform = espressif32\nboard = esp32dev\nframework = arduino\n'
    );
    setProcessRunner(
      metadataRunner({
        esp32dev: {
          board_config: { name: 'esp32dev' },
          platform: { name: 'espressif32' },
          frameworks: ['arduino'],
        },
      })
    );

    const response = await runInspectProject({ projectDir });

    expect(response.status).toBe('ok');
    expect(response.data?.environmentResolution).toBe('default_envs');
    expect(response.data?.resolvedEnvironment).toBe('esp32dev');
    expect(response.data?.metadataAvailable).toBe(true);
    expect(response.data?.discrepancies).toHaveLength(0);
    expect(response.data?.meta.executionStatus).toBe('succeeded');
  });

  it('flags a discrepancy when config board differs from metadata board', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:only]\nboard = esp32dev\n'
    );
    setProcessRunner(
      metadataRunner({
        only: { board_config: { name: 'esp32-s3-devkitc-1' } },
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

  it('degrades to partial when metadata is unavailable', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:a]\nboard = x\n\n[env:b]\nboard = y\n'
    );
    setProcessRunner(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }));

    const response = await runInspectProject({ projectDir });

    expect(response.status).toBe('warning');
    expect(response.data?.metadataAvailable).toBe(false);
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
