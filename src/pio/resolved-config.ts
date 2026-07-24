/**
 * Execution-truth layer: the project configuration PlatformIO itself resolves,
 * via `pio project config --json-output`.
 *
 * This is authoritative where our static platformio.ini parse is only a best
 * guess. PlatformIO applies `extends`, `extra_configs`, and `${...}`
 * interpolation here, so when this disagrees with the static parse (see ini.ts)
 * inspect_project should trust these values.
 *
 * The CLI emits a list of `[section, [[key, value], ...]]` pairs — NOT the
 * `pio project metadata` output, which carries compiler/build info but no
 * resolved board/platform/framework. That distinction was verified against a
 * real PlatformIO 6.1.x install.
 */

import { execPio, PioNotFoundError, type CommandResult } from './exec.js';

export interface ResolvedEnvironment {
  name: string;
  board?: string;
  platform?: string;
  framework?: string[];
}

export interface ResolvedConfigResult {
  /** True if the CLI produced usable resolved config. */
  available: boolean;
  environments: ResolvedEnvironment[];
  /** Reason resolution is unavailable, when available === false. */
  unavailableReason?: string;
}

/** A single [key, value] option pair; value may be a scalar or a list. */
type OptionPair = [string, unknown];
/** A single [section, options] pair. */
type SectionPair = [string, OptionPair[]];

function toStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string');
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string') return [value];
  return undefined;
}

/**
 * Parses `pio project config --json-output`. Returns one entry per `[env:*]`
 * section with the resolved board/platform/framework.
 */
export function parseResolvedConfig(stdout: string): ResolvedEnvironment[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const environments: ResolvedEnvironment[] = [];
  for (const section of parsed as SectionPair[]) {
    if (!Array.isArray(section) || typeof section[0] !== 'string') continue;
    const [name, options] = section;
    if (!name.startsWith('env:') || !Array.isArray(options)) continue;

    const env: ResolvedEnvironment = { name: name.slice('env:'.length) };
    for (const pair of options) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
      const [key, value] = pair;
      if (key === 'board') env.board = toStringValue(value);
      else if (key === 'platform') env.platform = toStringValue(value);
      else if (key === 'framework') env.framework = toStringList(value);
    }
    environments.push(env);
  }
  return environments;
}

/** Loads the PlatformIO-resolved project configuration from the CLI. */
export async function loadResolvedConfig(
  projectDir: string
): Promise<ResolvedConfigResult> {
  let result: CommandResult;
  try {
    result = await execPio(['project', 'config', '--json-output'], {
      cwd: projectDir,
    });
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return {
        available: false,
        environments: [],
        unavailableReason: 'PlatformIO CLI not found.',
      };
    }
    return {
      available: false,
      environments: [],
      unavailableReason:
        error instanceof Error ? error.message : 'Unknown error running CLI.',
    };
  }

  if (result.exitCode !== 0) {
    return {
      available: false,
      environments: [],
      unavailableReason:
        result.stderr.trim() ||
        `pio project config exited with code ${result.exitCode}.`,
    };
  }

  const environments = parseResolvedConfig(result.stdout);
  if (environments.length === 0) {
    return {
      available: false,
      environments: [],
      unavailableReason:
        'PlatformIO returned no environment configuration (project may be uninitialized).',
    };
  }

  return { available: true, environments };
}
