# Pioneer MCP

A board-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server that turns the [PlatformIO](https://platformio.org) Core CLI into a **structured execution layer** for AI agents.

Instead of making an agent parse raw CLI text, Pioneer inspects real PlatformIO projects, resolves environments, builds and uploads firmware, and monitors serial output — returning structured JSON with `status`, `summary`, `data`, `warnings`, and `nextActions`.

> **Status:** early development (`v0.1`). The tool surface and verification matrix are still growing. See [Scope](#scope) and [Verification boundary](#verification-boundary) for exactly what is and isn't claimed.

## Requirements

- **Node.js 18+**
- **[PlatformIO Core CLI](https://platformio.org/install/cli)** (`pip install platformio`, the official installer, or Homebrew)

Pioneer discovers the CLI from `PATH`, the `PLATFORMIO_CLI_PATH` environment variable, or the default `~/.platformio/penv` location — and works with both the `pio` and `platformio` command names.

## Quick start

```bash
npx -y pioneer-mcp
```

MCP client configuration (Claude Desktop, Cline, Cursor, etc.):

```json
{
  "mcpServers": {
    "pioneer": {
      "command": "npx",
      "args": ["-y", "pioneer-mcp"]
    }
  }
}
```

## Tools

Pioneer is being built up one vertical slice at a time. Currently available:

| Tool | Purpose |
|------|---------|
| `doctor` | Diagnose host readiness (CLI resolution, shell callability) with structured problem codes. No repairs. |
| `inspect_project` | Read-only. Parses `platformio.ini` and reconciles it with `pio project metadata` to report environments, the resolved default environment, config/execution discrepancies, and complexity signals. |

Planned for `v0.1` (in progress): `list_environments`, `list_boards`, `list_devices`, `build_project`, `clean_project`, `upload_firmware`, and persistent monitor sessions (`open_monitor_session` / `read_monitor_session` / `close_monitor_session`).

## Scope

Pioneer is intentionally an **execution layer**, not more:

- ✅ inspect project truth, build, upload, monitor
- ✅ structured, agent-consumable results
- ❌ not a workflow orchestrator
- ❌ not a generic terminal/shell
- ❌ not a remote-device platform

## Verification boundary

Honesty about what has actually been validated matters more than a long board list:

- Unit and in-memory end-to-end tests run with an injected process runner — **no real CLI or hardware required in CI**.
- Real-hardware closure is validated per board as physical devices become available; the README will state which boards have been directly validated versus CLI-only.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## License

[MIT](LICENSE) © Arrbel
