#!/bin/sh

PORT="${PORT:-8080}"
CONFIG_FILE="${MCP_CONFIG_FILE:-/default-servers.json}"
MCP_CORS="${MCP_CORS_ORIGIN:-*}"

# Fix volume permissions (non-fatal)
if [ -d /data ]; then
  mkdir -p /data/memory /data/secrets
  chmod -R 777 /data/memory /data/secrets 2>/dev/null || true
fi

# Materialize JSON creds from Railway env onto the volume. Do not echo values.
umask 077
write_secret_file() {
  _var_name="$1"
  _dest="$2"
  eval "_val=\${${_var_name}-}"
  if [ -n "$_val" ]; then
    printf '%s' "$_val" > "$_dest"
    chmod 600 "$_dest"
  fi
}

write_secret_file GOOGLE_ADS_ADC_JSON /data/secrets/google-ads-adc.json
if [ -f /data/secrets/google-ads-adc.json ]; then
  export GOOGLE_APPLICATION_CREDENTIALS=/data/secrets/google-ads-adc.json
fi

write_secret_file GTM_CREDENTIALS_JSON /data/secrets/gtm-credentials.json
write_secret_file GTM_TOKEN_JSON /data/secrets/gtm-token.json
if [ -f /data/secrets/gtm-credentials.json ]; then
  export GTM_CREDENTIALS_FILE=/data/secrets/gtm-credentials.json
fi
if [ -f /data/secrets/gtm-token.json ]; then
  export GTM_TOKEN_FILE=/data/secrets/gtm-token.json
fi

echo "Starting MCP Proxy Gateway"
echo "  Port: ${PORT}"
echo "  Config: ${CONFIG_FILE}"
echo ""

echo "Endpoints:"
echo "  Status:  http://0.0.0.0:${PORT}/status"

# Parse server names from config and print endpoints (non-fatal)
if command -v python3 > /dev/null 2>&1; then
  GATEWAY_PORT="${PORT}" python3 -c "
import json, os
port = os.environ['GATEWAY_PORT']
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
for name in cfg.get('mcpServers', {}):
    print(f'  {name}:  http://0.0.0.0:{port}/servers/{name}/sse')
" 2>/dev/null || true
fi

echo ""
echo "Starting proxy..."

# Use exec with explicit args array to avoid shell glob expansion of * in --allow-origin
exec catatonit -- mcp-proxy \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --named-server-config "${CONFIG_FILE}" \
  --pass-environment \
  --allow-origin "${MCP_CORS}"
