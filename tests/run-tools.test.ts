import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import { parseMemoryUsage } from '../src/pio/run.js';
import { runBuildProject } from '../src/tools/build-project.js';
import { runCleanProject } from '../src/tools/clean-project.js';
import { runUploadFirmware } from '../src/tools/upload-firmware.js';

/**
 * Mutating-tool tests. The critical behaviors: (1) refuse to run when the
 * environment is ambiguous, (2) surface build/upload success and failure
 * faithfully, (3) never touch a real binary (injected runner).
 */

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'pioneer-run-'));
  process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
});

afterEach(async () => {
  setProcessRunner();
  delete process.env.PLATFORMIO_CLI_PATH;
  await rm(projectDir, { recursive: true, force: true });
});

const BUILD_OK = [
  'Processing esp32dev...',
  'RAM:   [=         ]  13.4% (used 43980 bytes from 327680 bytes)',
  'Flash: [==        ]  18.6% (used 243697 bytes from 1310720 bytes)',
  '========= [SUCCESS] Took 12.34 seconds =========',
].join('\n');

/** A runner that returns a version for probes and a scripted run outcome. */
function runRunner(
  exitCode: number,
  stdout: string,
  stderr = ''
): ProcessRunner {
  return async (_file, args) => {
    if (args.includes('run')) return { stdout, stderr, exitCode };
    return {
      stdout: 'PlatformIO Core, version 6.1.19',
      stderr: '',
      exitCode: 0,
    };
  };
}

async function writeIni(body: string): Promise<void> {
  await writeFile(join(projectDir, 'platformio.ini'), body);
}

describe('parseMemoryUsage', () => {
  it('extracts RAM and Flash usage', () => {
    const usage = parseMemoryUsage(BUILD_OK);
    expect(usage?.ramPercent).toBe(13.4);
    expect(usage?.ramUsedBytes).toBe(43980);
    expect(usage?.flashUsedBytes).toBe(243697);
  });

  it('returns undefined when no usage lines exist', () => {
    expect(parseMemoryUsage('nothing here')).toBeUndefined();
  });
});

describe('build_project', () => {
  it('builds the resolved default environment and reports memory', async () => {
    await writeIni(
      '[platformio]\ndefault_envs = esp32dev\n\n[env:esp32dev]\nboard = esp32dev\n'
    );
    setProcessRunner(runRunner(0, BUILD_OK));

    const response = await runBuildProject({ projectDir });

    expect(response.status).toBe('ok');
    expect(response.data?.environment).toBe('esp32dev');
    expect(response.data?.environmentSource).toBe('default_envs');
    expect(response.data?.memoryUsage?.flashUsedBytes).toBe(243697);
  });

  it('refuses to build when the environment is ambiguous', async () => {
    await writeIni('[env:a]\nboard = x\n\n[env:b]\nboard = y\n');
    setProcessRunner(runRunner(0, BUILD_OK));

    const response = await runBuildProject({ projectDir });

    expect(response.status).toBe('error');
    expect(response.data).toBeNull();
    expect(response.summary.toLowerCase()).toContain('specify an environment');
  });

  it('reports a failed build with a diagnostic tail', async () => {
    await writeIni('[env:only]\nboard = x\n');
    setProcessRunner(
      runRunner(1, '', "src/main.cpp:10:3: error: 'foo' was not declared")
    );

    const response = await runBuildProject({ projectDir });

    expect(response.status).toBe('error');
    expect(response.data?.succeeded).toBe(false);
    expect(response.data?.meta.failureCategory).toBe('build_failed');
    expect(response.data?.outputTail).toContain('was not declared');
  });
});

describe('clean_project', () => {
  it('cleans the single environment', async () => {
    await writeIni('[env:only]\nboard = x\n');
    setProcessRunner(runRunner(0, 'Done cleaning'));

    const response = await runCleanProject({ projectDir });

    expect(response.status).toBe('ok');
    expect(response.data?.environment).toBe('only');
    expect(response.data?.environmentSource).toBe(
      'single_environment_fallback'
    );
  });
});

describe('upload_firmware', () => {
  it('uploads to an explicit environment and port', async () => {
    await writeIni('[env:esp32dev]\nboard = esp32dev\n');
    setProcessRunner(runRunner(0, 'Writing at 0x00010000... [SUCCESS]'));

    const response = await runUploadFirmware({
      projectDir,
      environment: 'esp32dev',
      uploadPort: 'COM5',
    });

    expect(response.status).toBe('ok');
    expect(response.data?.uploadPort).toBe('COM5');
    expect(response.data?.environmentSource).toBe('explicit');
    expect(response.data?.meta.operationType).toBe('upload');
  });

  it('reports upload failure with a retry hint', async () => {
    await writeIni('[env:esp32dev]\nboard = esp32dev\n');
    setProcessRunner(
      runRunner(1, '', 'A fatal error occurred: Failed to connect to ESP32')
    );

    const response = await runUploadFirmware({
      projectDir,
      environment: 'esp32dev',
    });

    expect(response.status).toBe('error');
    expect(response.data?.meta.failureCategory).toBe('upload_failed');
    expect(response.data?.meta.retryHint).toBeTruthy();
    expect(response.nextActions.length).toBeGreaterThan(0);
  });
});
