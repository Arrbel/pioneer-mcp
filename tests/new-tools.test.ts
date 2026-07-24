import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setProcessRunner, type ProcessRunner } from '../src/pio/exec.js';
import {
  parseRawBoards,
  runGetBoardInfo,
} from '../src/tools/get-board-info.js';
import { runInitProject } from '../src/tools/init-project.js';
import { runGenerateCompileCommands } from '../src/tools/generate-compile-commands.js';

/**
 * Unit tests for the v0.2 tool additions: get_board_info, init_project,
 * generate_compile_commands. All CLI interaction goes through an injected
 * runner; init/compiledb side effects are simulated by the runner writing the
 * files the real CLI would produce, so no real PlatformIO binary is touched.
 */

afterEach(() => {
  setProcessRunner();
  delete process.env.PLATFORMIO_CLI_PATH;
});

/** A board record shaped like a `pio boards <id> --json-output` entry. */
function board(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Board ${id}`,
    platform: 'atmelavr',
    mcu: 'ATMEGA328P',
    frameworks: ['arduino'],
    ...extra,
  };
}

function boardsRunner(payload: unknown): ProcessRunner {
  return async (_file, args) => {
    if (args.includes('boards')) {
      return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 };
    }
    return {
      stdout: 'PlatformIO Core, version 6.1.19',
      stderr: '',
      exitCode: 0,
    };
  };
}

describe('parseRawBoards', () => {
  it('parses board records and ignores non-objects', () => {
    const raws = parseRawBoards(JSON.stringify([board('uno'), 42, null]));
    expect(raws).toHaveLength(1);
    expect(raws[0]?.id).toBe('uno');
  });

  it('returns empty on invalid json', () => {
    expect(parseRawBoards('nope')).toEqual([]);
  });
});

describe('get_board_info', () => {
  beforeEach(() => {
    process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
  });

  it('selects the exact id and reports substring near-misses as alternatives', async () => {
    setProcessRunner(
      boardsRunner([
        board('uno', {
          fcpu: 16000000,
          ram: 2048,
          rom: 32256,
          vendor: 'Arduino',
          url: 'https://example.com',
          debug: { tools: { simavr: {}, 'avr-stub': {} } },
        }),
        board('uno_mini'),
        board('uno_r4_minima'),
      ])
    );

    const response = await runGetBoardInfo({ boardId: 'uno' });

    expect(response.status).toBe('ok');
    expect(response.data?.board.id).toBe('uno');
    expect(response.data?.board.ram).toBe(2048);
    expect(response.data?.board.debugTools).toContain('simavr');
    expect(response.data?.alternatives).toEqual(['uno_mini', 'uno_r4_minima']);
  });

  it('errors when no exact id matches even though substrings do', async () => {
    setProcessRunner(boardsRunner([board('uno_mini'), board('uno_r4_minima')]));
    const response = await runGetBoardInfo({ boardId: 'uno' });
    expect(response.status).toBe('error');
    expect(response.data).toBeNull();
  });

  it('errors when nothing matches at all', async () => {
    setProcessRunner(boardsRunner([]));
    const response = await runGetBoardInfo({ boardId: 'ghost' });
    expect(response.status).toBe('error');
  });
});

describe('init_project', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pioneer-init-'));
    process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  /** Simulates `pio project init` by writing the ini the CLI would create. */
  function initRunner(): ProcessRunner {
    return async (_file, args) => {
      if (args.includes('init')) {
        // Mirror the real CLI: append an [env:<board>] section.
        const boardIdx = args.indexOf('-b');
        const boardId = boardIdx >= 0 ? args[boardIdx + 1] : 'unknown';
        const iniPath = join(projectDir, 'platformio.ini');
        let existing = '';
        try {
          existing = await readFile(iniPath, 'utf8');
        } catch {
          existing = '';
        }
        const section = `[env:${boardId}]\nplatform = atmelavr\nboard = ${boardId}\nframework = arduino\n`;
        await writeFile(
          iniPath,
          existing ? `${existing}\n${section}` : section
        );
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return {
        stdout: 'PlatformIO Core, version 6.1.19',
        stderr: '',
        exitCode: 0,
      };
    };
  }

  it('initializes a fresh project and confirms the environment landed', async () => {
    setProcessRunner(initRunner());
    const response = await runInitProject({ projectDir, board: 'uno' });
    expect(response.status).toBe('ok');
    expect(response.data?.extendedExisting).toBe(false);
    expect(response.data?.environmentPresent).toBe(true);
  });

  it('reports extending an existing project', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:esp32dev]\nboard = esp32dev\n'
    );
    setProcessRunner(initRunner());
    const response = await runInitProject({ projectDir, board: 'uno' });
    expect(response.status).toBe('ok');
    expect(response.data?.extendedExisting).toBe(true);
    expect(response.data?.environmentPresent).toBe(true);
  });

  it('errors when the CLI init fails', async () => {
    setProcessRunner(async (_file, args) =>
      args.includes('init')
        ? { stdout: '', stderr: 'unknown board', exitCode: 1 }
        : { stdout: 'v6', stderr: '', exitCode: 0 }
    );
    const response = await runInitProject({ projectDir, board: 'bogus' });
    expect(response.status).toBe('error');
    expect(response.data).toBeNull();
  });
});

describe('generate_compile_commands', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pioneer-compiledb-'));
    process.env.PLATFORMIO_CLI_PATH = '/fake/pio';
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:uno]\nplatform = atmelavr\nboard = uno\n'
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reports the output path when compiledb writes the database', async () => {
    setProcessRunner(async (_file, args) => {
      if (args.includes('run')) {
        await writeFile(
          join(projectDir, 'compile_commands.json'),
          '[]',
          'utf8'
        );
        return { stdout: 'done', stderr: '', exitCode: 0 };
      }
      return { stdout: 'v6', stderr: '', exitCode: 0 };
    });

    const response = await runGenerateCompileCommands({ projectDir });
    expect(response.status).toBe('ok');
    expect(response.data?.outputPath).toContain('compile_commands.json');
  });

  it('warns when compiledb succeeds but no file is produced', async () => {
    setProcessRunner(async (_file, args) =>
      args.includes('run')
        ? { stdout: 'done', stderr: '', exitCode: 0 }
        : { stdout: 'v6', stderr: '', exitCode: 0 }
    );
    const response = await runGenerateCompileCommands({ projectDir });
    expect(response.status).toBe('warning');
    expect(response.data?.outputPath).toBeUndefined();
  });

  it('errors on ambiguous environment resolution', async () => {
    await writeFile(
      join(projectDir, 'platformio.ini'),
      '[env:a]\nboard = x\n\n[env:b]\nboard = y\n'
    );
    setProcessRunner(async () => ({ stdout: 'v6', stderr: '', exitCode: 0 }));
    const response = await runGenerateCompileCommands({ projectDir });
    expect(response.status).toBe('error');
  });
});
