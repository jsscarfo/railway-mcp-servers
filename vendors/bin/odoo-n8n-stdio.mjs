process.env.MCP_TRANSPORT = "stdio";
delete process.env.PORT;
await import("/opt/mcp/odoo_n8n/src/index.js");
