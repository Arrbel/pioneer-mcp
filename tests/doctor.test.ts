import { afterEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import { runDoctor } from '../src/tools/doctor.js';

/**
 * These tests prove the core design goal: doctor is fully testable with an
 * injected process runner and never touches a real PlatformIO binary or a
 * hardcoded user path.
 */

afterEach(() => {
  setProcessRunner(); // restore default
  delete process.env.PLATFORMIO_CLI_PATH;
});

function fakeRunner(version: string): ProcessRunner {
  return async (_file, _args, _timeout) => ({
    stdout: version,
    stderr: '',
    exitCode: 0,
  });
}

const notFoundRunner: ProcessRunner = async () => {
  const err = new Error('spawn ENOENT') as Error & { code: string };
  err.code = 'ENOENT';
  throw err;
};

describe('doctor', () => {
  it('reports ready when the CLI resolves and returns a version', async () => {
    process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
    setProcessRunner(fakeRunner('PlatformIO Core, version 6.1.19'));

    const response = await runDoctor();

    expect(response.status).toBe('ok');
    expect(response.data?.cliAvailable).toBe(true);
    expect(response.data?.cliVersion).toContain('6.1.19');
    expect(response.data?.detectedProblems).toHaveLength(0);
    expect(response.data?.readyForBuild).toBe(true);
    expect(response.data?.meta.executionStatus).toBe('succeeded');
  });

  it('reports platformio_cli_missing when no candidate responds', async () => {
    setProcessRunner(notFoundRunner);

    const response = await runDoctor();

    expect(response.status).toBe('error');
    expect(response.data?.cliAvailable).toBe(false);
    expect(response.data?.detectedProblems[0]?.code).toBe(
      'platformio_cli_missing'
    );
    expect(response.data?.readyForBuild).toBe(false);
    expect(response.data?.meta.failureCategory).toBe('platformio_cli_missing');
    expect(response.nextActions.length).toBeGreaterThan(0);
  });
});
