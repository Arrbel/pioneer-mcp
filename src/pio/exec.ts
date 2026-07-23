/**
 * PlatformIO CLI discovery and command execution.
 *
 * This is the single choke point through which every tool talks to the
 * PlatformIO Core CLI. It is deliberately injectable: the actual process
 * runner can be swapped out in tests so no real `pio` binary is required.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Environment variable used to force a specific PlatformIO CLI path. */
export const PLATFORMIO_PATH_ENV = 'PLATFORMIO_CLI_PATH';

/** Default command timeout (5 minutes — long enough for a cold build). */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Result of running a CLI command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A pluggable process runner so tests never spawn a real binary. */
export type ProcessRunner = (
  file: string,
  args: string[],
  timeoutMs: number
) => Promise<CommandResult>;

/** Options for {@link execPio}. */
export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

const PLACEHOLDER_MISSING = '__pioneer_pio_not_found__';

let cachedBinary: string | null = null;

/** Clears the cached binary path. Primarily for tests. */
export function resetPioCache(): void {
  cachedBinary = null;
}

/** Returns the conventional local PlatformIO binary path for this platform. */
function localDefaultPath(): string | undefined {
  if (process.platform === 'win32') {
    const profile = process.env.USERPROFILE?.trim();
    return profile
      ? `${profile}\\.platformio\\penv\\Scripts\\pio.exe`
      : undefined;
  }
  const home = process.env.HOME?.trim();
  return home ? `${home}/.platformio/penv/bin/pio` : undefined;
}

/** Ordered, de-duplicated list of candidate CLI paths to probe. */
export function candidatePaths(): string[] {
  const configured = process.env[PLATFORMIO_PATH_ENV]?.trim();
  const candidates = [configured, localDefaultPath(), 'pio', 'platformio'];
  return candidates.filter(
    (value, index, all): value is string =>
      Boolean(value) && all.indexOf(value) === index
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** The default runner: a real child process via execFile. */
const defaultRunner: ProcessRunner = async (file, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (isNotFoundError(error)) {
      throw error;
    }
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
};

let runner: ProcessRunner = defaultRunner;

/** Overrides the process runner (tests). Pass nothing to restore default. */
export function setProcessRunner(next?: ProcessRunner): void {
  runner = next ?? defaultRunner;
  resetPioCache();
}

/**
 * Resolves a callable PlatformIO binary, probing candidates in order.
 * Returns undefined if none respond to `--version`.
 */
export async function resolvePioBinary(): Promise<string | undefined> {
  if (cachedBinary === PLACEHOLDER_MISSING) return undefined;
  if (cachedBinary) return cachedBinary;

  for (const candidate of candidatePaths()) {
    try {
      const result = await runner(candidate, ['--version'], 5_000);
      // A response (even nonzero) means the binary exists and is callable.
      if (result.exitCode === 0 || result.stdout || result.stderr) {
        cachedBinary = candidate;
        return candidate;
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        cachedBinary = candidate;
        return candidate;
      }
    }
  }

  cachedBinary = PLACEHOLDER_MISSING;
  return undefined;
}

/** Whether `pio`/`platformio` is directly callable from PATH (not just penv). */
export async function isShellCallable(): Promise<boolean> {
  if (process.env[PLATFORMIO_PATH_ENV]?.trim()) return true;
  for (const name of ['pio', 'platformio']) {
    try {
      const result = await runner(name, ['--version'], 5_000);
      if (result.exitCode === 0 || result.stdout || result.stderr) return true;
    } catch (error) {
      if (!isNotFoundError(error)) return true;
    }
  }
  return false;
}

/** Thrown when no PlatformIO CLI can be resolved. */
export class PioNotFoundError extends Error {
  constructor() {
    super(
      'PlatformIO CLI not found. Install it from https://platformio.org/install/cli ' +
        `or set ${PLATFORMIO_PATH_ENV} to the pio executable path.`
    );
    this.name = 'PioNotFoundError';
  }
}

/**
 * Executes a PlatformIO CLI command and returns its structured result.
 * Throws {@link PioNotFoundError} if no CLI is available.
 */
export async function execPio(
  args: string[],
  options: ExecOptions = {}
): Promise<CommandResult> {
  const binary = await resolvePioBinary();
  if (!binary) {
    throw new PioNotFoundError();
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // cwd is applied by the caller-facing runner in production; the default
  // runner uses process.cwd unless the command itself is cwd-agnostic.
  return runWithCwd(binary, args, timeoutMs, options.cwd);
}

/** Runs the resolved binary, threading cwd through when supported. */
async function runWithCwd(
  binary: string,
  args: string[],
  timeoutMs: number,
  cwd?: string
): Promise<CommandResult> {
  if (!cwd) {
    return runner(binary, args, timeoutMs);
  }
  // The default runner ignores cwd, so for real execution we spawn with cwd
  // via a thin wrapper. Tests inject their own runner and control output.
  if (runner === defaultRunner) {
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        cwd,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      if (isNotFoundError(error)) throw new PioNotFoundError();
      const err = error as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        message?: string;
      };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }
  return runner(binary, args, timeoutMs);
}
