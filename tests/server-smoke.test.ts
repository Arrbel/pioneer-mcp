import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

/**
 * End-to-end smoke test: connect a real MCP client to the server over an
 * in-memory transport and confirm the doctor tool is listed and callable.
 */
describe('server', () => {
  it('lists registered tools and responds to a doctor call', async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('doctor');
    expect(names).toContain('inspect_project');
    expect(names).toContain('list_environments');
    expect(names).toContain('list_devices');
    expect(names).toContain('list_boards');
    expect(names).toContain('get_board_info');
    expect(names).toContain('init_project');
    expect(names).toContain('generate_compile_commands');
    expect(names).toContain('build_project');
    expect(names).toContain('clean_project');
    expect(names).toContain('upload_firmware');
    expect(names).toContain('open_monitor_session');
    expect(names).toContain('read_monitor_session');
    expect(names).toContain('close_monitor_session');
    expect(names).toHaveLength(14);

    const result = await client.callTool({ name: 'doctor', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.type).toBe('text');
    const parsed = JSON.parse(content[0]!.text) as { data?: unknown };
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('data');

    await client.close();
    await server.close();
  });
});
