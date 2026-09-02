# MCP Server Gateway

One-click deploy of a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server gateway on Railway. Exposes multiple MCP tool servers over HTTP using SSE and Streamable HTTP transports, so any MCP-compatible AI client can connect remotely.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE)

## What is MCP?

The Model Context Protocol is an open standard for connecting AI assistants to external tools and data sources. MCP servers expose tools (web fetching, memory, reasoning) that AI clients like Claude Desktop, Cursor, Windsurf, and others can use.

This template deploys a gateway that bundles multiple MCP servers behind a single HTTP endpoint, making them accessible over the network instead of requiring local stdio connections.

## Included MCP Servers

Hermes aggregator branch (`hermes-aggregator`): Xena defaults plus vendored brand/Xena stdio servers.

| Server | Path | Description |
|--------|------|-------------|
| **Fetch** | `/servers/fetch/mcp` | Web fetch → markdown |
| **Memory** | `/servers/memory/mcp` | Knowledge graph at `/data/memory/memory.json` |
| **Sequential Thinking** | `/servers/sequential-thinking/mcp` | Reflective thought sequences |
| **odoo_readonly** | `/servers/odoo_readonly/mcp` | Xena Odoo read-only JSON-RPC |
| **odoo_n8n** | `/servers/odoo_n8n/mcp` | Xena Odoo concierge (stdio; PORT unset) |
| **wordpress-cmp** | `/servers/wordpress-cmp/mcp` | Compasivamente WordPress |
| **wordpress-fpx** | `/servers/wordpress-fpx/mcp` | FPX WordPress |
| **meta-ads** | `/servers/meta-ads/mcp` | Meta Graph ads |

SSE is also at `/servers/<name>/sse`. Hermes on Railway should use Streamable HTTP (`/mcp`) over private DNS, not a public domain.

Not in this image yet: AdLoop, GTM, luna-salud (Python / extra cred files). Metricool and n8n stay as their own HTTP URLs.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port for the gateway | `8080` |
| `MCP_TRANSPORT` | Transport protocol (`streamablehttp` or `sse`) | `streamablehttp` |
| `MCP_CORS_ORIGIN` | CORS allowed origin | `*` |
| `MCP_CONFIG_FILE` | Path to custom server config JSON | `/default-servers.json` |

## Connecting Clients

### Claude Desktop / Cursor / Windsurf

Add this to your MCP client configuration. Uses `supergateway` or `mcp-proxy` locally to bridge the remote SSE server to local stdio:

```json
{
  "mcpServers": {
    "remote-fetch": {
      "command": "npx",
      "args": [
        "-y", "supergateway",
        "--sse", "https://YOUR_RAILWAY_DOMAIN/servers/fetch/sse"
      ]
    },
    "remote-memory": {
      "command": "npx",
      "args": [
        "-y", "supergateway",
        "--sse", "https://YOUR_RAILWAY_DOMAIN/servers/memory/sse"
      ]
    },
    "remote-thinking": {
      "command": "npx",
      "args": [
        "-y", "supergateway",
        "--sse", "https://YOUR_RAILWAY_DOMAIN/servers/sequential-thinking/sse"
      ]
    }
  }
}
```

Replace `YOUR_RAILWAY_DOMAIN` with your Railway public domain.

### Direct HTTP (Streamable HTTP)

For clients that support Streamable HTTP natively, connect to:

```
https://YOUR_RAILWAY_DOMAIN/servers/fetch/mcp
https://YOUR_RAILWAY_DOMAIN/servers/memory/mcp
https://YOUR_RAILWAY_DOMAIN/servers/sequential-thinking/mcp
```

### Status Check

```
GET https://YOUR_RAILWAY_DOMAIN/status
```

## Custom Server Configuration

To add or remove MCP servers, mount a custom `servers.json` file or set `MCP_CONFIG_FILE` to point to your own config. The format:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "command-to-run",
      "args": ["arg1", "arg2"],
      "env": {
        "KEY": "value"
      }
    }
  }
}
```

Each server is accessible at `/servers/<server-name>/sse` (SSE) or `/servers/<server-name>/mcp` (Streamable HTTP).

## Volume

Data is persisted at `/data`. The memory server stores its knowledge graph at `/data/memory/memory.json`, ensuring data survives redeployments.

## Architecture

```
Client (Claude Desktop, Cursor, etc.)
  |
  | HTTPS (SSE or Streamable HTTP)
  v
MCP Proxy Gateway (this template)
  |
  |-- /servers/fetch/             -> mcp-server-fetch (stdio)
  |-- /servers/memory/            -> mcp-server-memory (stdio)
  |-- /servers/sequential-thinking/ -> mcp-server-sequential-thinking (stdio)
```

The gateway uses [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) to bridge stdio-based MCP servers to HTTP transports, so each server runs as a child process and communicates over stdin/stdout internally.

## Links

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Official MCP Servers](https://github.com/modelcontextprotocol/servers)
- [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy)
- [supergateway](https://github.com/supercorp-ai/supergateway) (client-side bridge)
