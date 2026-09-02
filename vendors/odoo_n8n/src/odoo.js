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
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeJsonRpcBody({ service, method, args })),
      signal: controller.signal,
    });
    const duration = Date.now() - start;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[Odoo API] HTTP ${res.status} after ${duration}ms (Service: ${service}, Method: ${method})`);
      throw new Error(`HTTP ${res.status} from Odoo JSON-RPC`);
    }
    if (!data) {
      console.error(`[Odoo API] Invalid response after ${duration}ms (Service: ${service}, Method: ${method})`);
      throw new Error("Invalid JSON-RPC response");
    }
    if (data.error) {
      const msg = data.error?.data?.message || data.error?.message || "JSON-RPC error";
      console.error(`[Odoo API] Error after ${duration}ms: ${msg} (Service: ${service}, Method: ${method})`);
      throw new Error(msg);
    }
    console.error(`[Odoo API] Success in ${duration}ms (Service: ${service}, Method: ${method})`);
    return data.result;
  } catch (err) {
    const duration = Date.now() - start;
    if (err.name === 'AbortError') {
      console.error(`[Odoo API] TIMEOUT after ${duration}ms (Limit: ${timeoutMs}ms) (Service: ${service}, Method: ${method})`);
    } else {
      console.error(`[Odoo API] Request failed after ${duration}ms: ${err.message} (Service: ${service}, Method: ${method})`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// In the Writer MCP, we DO NOT enforce a read-only allowlist.
// We trust the API Key's permissions and the user's intent.

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
    // No allowlist check here - FULL POWER
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
