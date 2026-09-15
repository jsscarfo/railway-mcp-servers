#!/bin/sh

PORT="${PORT:-8080}"
CONFIG_FILE="${MCP_CONFIG_FILE:-/default-servers.json}"
MCP_CORS="${MCP_CORS_ORIGIN:-*}"

# Fix volume permissions (non-fatal)
if [ -d /data ]; then
  mkdir -p /data/memory /data/secrets /data/adloop-home
  chmod -R 777 /data/memory /data/secrets /data/adloop-home 2>/dev/null || true
fi

# Materialize JSON creds from Railway env onto the volume. Do not echo values.
umask 077
write_secret_file() {
  _var_name="$1"
  _dest="$2"
  # python3 so multiline YAML/JSON env vars are not truncated by eval
  python3 -c 'import os, sys
n, d = sys.argv[1], sys.argv[2]
v = os.environ.get(n) or ""
if not v:
    raise SystemExit(0)
open(d, "w", encoding="utf-8").write(v)
' "$_var_name" "$_dest" || true
  if [ -s "$_dest" ]; then
    chmod 600 "$_dest"
  fi
}

write_secret_file GOOGLE_ADS_ADC_JSON /data/secrets/google-ads-adc.json
if [ -f /data/secrets/google-ads-adc.json ]; then
  export GOOGLE_APPLICATION_CREDENTIALS=/data/secrets/google-ads-adc.json
fi

# AdLoop Ads/GA4 auth is OAuth token.json, not ADC. Write into the volume
# home used by the adloop child (servers.json sets HOME=/data/adloop-home).
# Do not export HOME here — that would change mcp-proxy and every other child.
ADLOOP_HOME="/data/adloop-home"
mkdir -p "${ADLOOP_HOME}/.adloop"
chmod 700 "${ADLOOP_HOME}/.adloop" 2>/dev/null || true
write_secret_file ADLOOP_TOKEN_JSON "${ADLOOP_HOME}/.adloop/token.json"
write_secret_file ADLOOP_CREDENTIALS_JSON "${ADLOOP_HOME}/.adloop/credentials.json"
write_secret_file ADLOOP_CONFIG_YAML "${ADLOOP_HOME}/.adloop/config.yaml"

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
