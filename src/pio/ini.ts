/**
 * Minimal platformio.ini parser + environment resolution state machine.
 *
 * This gives the "config truth" half of inspect_project: what the static
 * platformio.ini says, plus how an environment would be resolved from it.
 * The "execution truth" half comes from `pio project metadata` (see metadata.ts).
 *
 * We deliberately do NOT try to fully replicate PlatformIO's interpolation
 * engine. Instead we detect features that make static parsing unreliable and
 * surface them as complexity signals, so an agent knows when to trust the CLI
 * metadata over our parse.
 */

/** A single [env:<name>] section, distilled to fields agents care about. */
export interface EnvironmentSummary {
  name: string;
  platform?: string;
  board?: string;
  framework?: string;
  monitorSpeed?: number;
  monitorPort?: string;
  uploadPort?: string;
  isDefault: boolean;
}

/** Result of parsing platformio.ini. */
export interface ParsedConfig {
  defaultEnvironments: string[];
  environments: EnvironmentSummary[];
  warnings: string[];
  /** Features that make static parsing potentially inaccurate. */
  complexitySignals: string[];
}

/** How an environment was (or wasn't) resolved from static config. */
export type EnvironmentResolution =
  'default_envs' | 'single_environment_fallback' | 'ambiguous' | 'not_resolved';

export interface ResolutionResult {
  resolvedEnvironment?: string;
  environmentResolution: EnvironmentResolution;
  resolutionReason: string;
  resolutionWarnings: string[];
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parses platformio.ini contents into a structured config summary. */
export function parsePlatformIOIni(contents: string): ParsedConfig {
  const sections = new Map<string, Record<string, string>>();
  let currentSection = '';
  let currentKey = '';
  const warnings = new Set<string>();
  const signals = new Set<string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      currentKey = '';
      if (!sections.has(currentSection)) sections.set(currentSection, {});
      continue;
    }

    if (!currentSection) continue;

    // Continuation line (indented, belongs to previous multi-line key).
    if (currentKey && /^\s+/.test(rawLine)) {
      const section = sections.get(currentSection) ?? {};
      const existing = section[currentKey] ?? '';
      section[currentKey] = existing ? `${existing}\n${line}` : line;
      sections.set(currentSection, section);
      continue;
    }

    const sep = line.indexOf('=');
    if (sep === -1) continue;

    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    currentKey = key;

    if (key === 'extends') {
      warnings.add(
        'Project uses `extends`; parsed config may differ from PlatformIO resolution. Trust CLI metadata.'
      );
      signals.add('extends_present');
    }
    if (key === 'extra_configs') {
      warnings.add(
        'Project uses `extra_configs`; parsed config may omit settings from other files.'
      );
      signals.add('extra_configs_present');
    }
    if (value.includes('${sysenv.')) {
      warnings.add(
        'Project uses ${sysenv.*} interpolation; runtime values depend on the shell environment.'
      );
      signals.add('sysenv_interpolation_present');
      signals.add('default_env_override_possible');
    }
    if (value.includes('${this.')) {
      warnings.add(
        'Project uses ${this.*} interpolation; parsed values may not match final resolution.'
      );
      signals.add('this_interpolation_present');
    }

    const section = sections.get(currentSection) ?? {};
    section[key] = value;
    sections.set(currentSection, section);
  }

  const platformio = sections.get('platformio') ?? {};
  const defaultEnvironments = parseList(platformio.default_envs);

  const environments: EnvironmentSummary[] = Array.from(sections.entries())
    .filter(([name]) => name.startsWith('env:'))
    .map(([name, options]) => {
      const envName = name.slice('env:'.length);
      const monitorSpeed = options.monitor_speed
        ? Number(options.monitor_speed)
        : undefined;
      return {
        name: envName,
        platform: options.platform,
        board: options.board,
        framework: options.framework,
        monitorSpeed:
          monitorSpeed !== undefined && Number.isFinite(monitorSpeed)
            ? monitorSpeed
            : undefined,
        monitorPort: options.monitor_port,
        uploadPort: options.upload_port,
        isDefault: defaultEnvironments.includes(envName),
      };
    });

  return {
    defaultEnvironments,
    environments,
    warnings: Array.from(warnings),
    complexitySignals: Array.from(signals),
  };
}

/** Resolves which environment applies, given only static config. */
export function resolveEnvironment(config: ParsedConfig): ResolutionResult {
  if (config.defaultEnvironments.length > 0) {
    const resolved = config.defaultEnvironments[0];
    const match = config.environments.find((e) => e.name === resolved);
    if (!match) {
      return {
        environmentResolution: 'not_resolved',
        resolutionReason:
          'default_envs is configured but none of the listed environments exist in platformio.ini.',
        resolutionWarnings: [
          `default_envs entry '${resolved}' matches no [env:<name>] section.`,
        ],
      };
    }
    return {
      resolvedEnvironment: resolved,
      environmentResolution: 'default_envs',
      resolutionReason: `Resolved from default_envs (${config.defaultEnvironments.join(', ')}).`,
      resolutionWarnings: [],
    };
  }

  if (config.environments.length === 1) {
    return {
      resolvedEnvironment: config.environments[0]?.name,
      environmentResolution: 'single_environment_fallback',
      resolutionReason: 'Resolved from the only environment defined.',
      resolutionWarnings: [],
    };
  }

  if (config.environments.length > 1) {
    return {
      environmentResolution: 'ambiguous',
      resolutionReason:
        'Multiple environments defined and no default_envs entry found.',
      resolutionWarnings: [
        'Environment selection is ambiguous until a specific environment is provided or default_envs is set.',
      ],
    };
  }

  return {
    environmentResolution: 'not_resolved',
    resolutionReason: 'No [env:<name>] sections found in platformio.ini.',
    resolutionWarnings: ['Project defines no PlatformIO environments.'],
  };
}
