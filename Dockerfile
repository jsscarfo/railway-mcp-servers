FROM ghcr.io/sparfenyuk/mcp-proxy:latest

USER root

RUN apk add --no-cache nodejs npm

RUN pip install --no-cache-dir mcp-server-fetch && \
    npm install -g \
    @modelcontextprotocol/server-memory \
    @modelcontextprotocol/server-sequential-thinking

RUN mkdir -p /data/memory /opt/mcp/bin && chmod 777 /data/memory

COPY vendors/wordpress /opt/mcp/wordpress
COPY vendors/meta-ads /opt/mcp/meta-ads
COPY vendors/odoo_readonly /opt/mcp/odoo_readonly
COPY vendors/odoo_n8n /opt/mcp/odoo_n8n
COPY vendors/bin/odoo-n8n-stdio.mjs /opt/mcp/bin/odoo-n8n-stdio.mjs

RUN cd /opt/mcp/wordpress && npm install --omit=dev && \
    cd /opt/mcp/meta-ads && npm install --omit=dev && \
    cd /opt/mcp/odoo_readonly && npm ci --omit=dev && \
    cd /opt/mcp/odoo_n8n && npm ci --omit=dev

COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY servers.json /default-servers.json

ENTRYPOINT ["/entrypoint.sh"]
