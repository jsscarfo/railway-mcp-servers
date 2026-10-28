# Luna Salud MCP (stdio)

Cloud agents and local Cursor run this server with **Node** over stdio. Railway aggregator uses the same source at `/opt/mcp/luna-salud/index.js`.

## Bootstrap (required on fresh VMs)

From a checkout of `jsscarfo/railway-mcp-servers`:

```bash
cd vendors/luna-salud && npm ci --omit=dev
```

Cloud Agent environments should run that under **`/agent/repos/railway-mcp-servers/vendors/luna-salud`** during the environment **`install`** step.

## Cursor MCP registration

| Field | Value |
| --- | --- |
| Type | Command |
| Name | `luna-salud` |
| Command | `node` |
| Args | `["/agent/repos/railway-mcp-servers/vendors/luna-salud/index.js"]` |
| Environment variable | `LUNA_SALUD_API_KEY` (Cursor environment secret → MCP process env) |

Do **not** use `/workspace/railway-mcp-servers/...` — that path is not populated on Cloud Agent VMs. The vendor tree lives on **`main`**.

The server starts without a key (tool discovery works); Luna API calls fail until `LUNA_SALUD_API_KEY` is set.

## Writes

Create/reschedule tools honor dry-run unless `LUNA_ALLOW_LIVE_WRITES=1`. Compasivamente cloud work defaults to dry-run.
