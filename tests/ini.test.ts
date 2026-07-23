import { describe, expect, it } from 'vitest';
import { parsePlatformIOIni, resolveEnvironment } from '../src/pio/ini.js';

/**
 * Pure-function tests for the config-truth layer: no filesystem, no CLI.
 * The environment resolution state machine is the highest-value logic here.
 */

describe('parsePlatformIOIni', () => {
  it('extracts environments, defaults, and per-env fields', () => {
    const ini = [
      '[platformio]',
      'default_envs = esp32dev',
      '',
      '[env:esp32dev]',
      'platform = espressif32',
      'board = esp32dev',
      'framework = arduino',
      'monitor_speed = 115200',
      '',
      '[env:nano]',
      'platform = atmelavr',
      'board = nanoatmega328',
    ].join('\n');

    const config = parsePlatformIOIni(ini);

    expect(config.defaultEnvironments).toEqual(['esp32dev']);
    expect(config.environments).toHaveLength(2);
    const esp = config.environments.find((e) => e.name === 'esp32dev');
    expect(esp?.board).toBe('esp32dev');
    expect(esp?.monitorSpeed).toBe(115200);
    expect(esp?.isDefault).toBe(true);
    expect(config.environments.find((e) => e.name === 'nano')?.isDefault).toBe(
      false
    );
  });

  it('flags interpolation and extends as complexity signals', () => {
    const ini = [
      '[env:base]',
      'board = esp32dev',
      '',
      '[env:derived]',
      'extends = env:base',
      'upload_port = ${sysenv.UPLOAD_PORT}',
    ].join('\n');

    const config = parsePlatformIOIni(ini);

    expect(config.complexitySignals).toContain('extends_present');
    expect(config.complexitySignals).toContain('sysenv_interpolation_present');
    expect(config.warnings.length).toBeGreaterThan(0);
  });
});

describe('resolveEnvironment', () => {
  it('resolves from default_envs when it matches an existing env', () => {
    const config = parsePlatformIOIni(
      '[platformio]\ndefault_envs = a\n\n[env:a]\nboard = x\n\n[env:b]\nboard = y'
    );
    const result = resolveEnvironment(config);
    expect(result.environmentResolution).toBe('default_envs');
    expect(result.resolvedEnvironment).toBe('a');
  });

  it('falls back to the single environment when no default is set', () => {
    const config = parsePlatformIOIni('[env:only]\nboard = x');
    const result = resolveEnvironment(config);
    expect(result.environmentResolution).toBe('single_environment_fallback');
    expect(result.resolvedEnvironment).toBe('only');
  });

  it('is ambiguous with multiple envs and no default', () => {
    const config = parsePlatformIOIni(
      '[env:a]\nboard = x\n\n[env:b]\nboard = y'
    );
    const result = resolveEnvironment(config);
    expect(result.environmentResolution).toBe('ambiguous');
    expect(result.resolvedEnvironment).toBeUndefined();
  });

  it('is not_resolved when default_envs points at a missing env', () => {
    const config = parsePlatformIOIni(
      '[platformio]\ndefault_envs = ghost\n\n[env:real]\nboard = x'
    );
    const result = resolveEnvironment(config);
    expect(result.environmentResolution).toBe('not_resolved');
  });

  it('is not_resolved when no environments exist', () => {
    const config = parsePlatformIOIni('[platformio]\nsrc_dir = src');
    const result = resolveEnvironment(config);
    expect(result.environmentResolution).toBe('not_resolved');
  });
});
