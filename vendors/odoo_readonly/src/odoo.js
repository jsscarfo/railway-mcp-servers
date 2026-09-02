function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

function makeJsonRpcBody({ service, method, args }) {
  return {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args },
    id: Math.floor(Math.random() * 1e9),
  };
}

async function jsonRpcCall({ baseUrl, timeoutMs, service, method, args }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeJsonRpcBody({ service, method, args })),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from Odoo JSON-RPC`);
    }
    if (!data) throw new Error("Invalid JSON-RPC response");
    if (data.error) {
      const msg = data.error?.data?.message || data.error?.message || "JSON-RPC error";
      throw new Error(msg);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

const READONLY_ALLOWLIST = {
  "res.partner": new Set(["search_read", "read", "name_search"]),
  "sale.order": new Set(["search_read", "read"]),
  "sale.order.line": new Set(["search_read", "read"]),
  "stock.quant": new Set(["search_read", "read"]),
  "stock.move.line": new Set(["search_read", "read"]),
  "product.product": new Set(["search_read", "read"]),
  // Additional read-only models needed for Product Picker helpers
  "product.image": new Set(["search_read", "read"]),
  "stock.picking": new Set(["search_read", "read"]),
  "mrp.bom": new Set(["search_read", "read"]),
  "product.pricelist": new Set(["search_read", "read"]),
};

export class OdooClient {
  constructor({ baseUrl, db, username, apiKey, timeoutMs }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.db = db;
    this.username = username;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.uid = null;
  }

  static fromEnv() {
    return new OdooClient({
      baseUrl: requiredEnv("ODOO_URL"),
      db: requiredEnv("ODOO_DB"),
      username: requiredEnv("ODOO_USERNAME"),
      apiKey: requiredEnv("ODOO_API_KEY"),
      timeoutMs: optionalInt("ODOO_TIMEOUT_MS", 20000),
    });
  }

  async authenticate() {
    const uid = await jsonRpcCall({
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      service: "common",
      method: "authenticate",
      args: [this.db, this.username, this.apiKey, {}],
    });
    if (!uid) throw new Error("Authentication failed (uid falsy)");
    this.uid = uid;
    return uid;
  }

  async ensureAuth() {
    if (this.uid) return this.uid;
    return await this.authenticate();
  }

  async executeKw({ model, method, args = [], kwargs = {} }) {
    await this.ensureAuth();

    const allowedMethods = READONLY_ALLOWLIST[model];
    if (!allowedMethods || !allowedMethods.has(method)) {
      throw new Error(`Forbidden method for read-only MCP: ${model}.${method}`);
    }

    return await jsonRpcCall({
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      service: "object",
      method: "execute_kw",
      args: [this.db, this.uid, this.apiKey, model, method, args, kwargs],
    });
  }
}

export function clampLimit(limit, fallback = 20, max = 200) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

