import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvFile } from "./env.js";
import { OdooClient, clampLimit } from "./odoo.js";

// Optional local env file (do not commit)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load env.local relative to this package (works when launched by Cursor from any cwd)
loadEnvFile(path.join(__dirname, "..", "env.local"));

const odoo = OdooClient.fromEnv();
const defaultLimit = clampLimit(process.env.ODOO_DEFAULT_LIMIT, 20, 200);

function tokenizeQuery(input) {
  const q = String(input || "").trim();
  if (!q) return [];
  // Supports quoted phrases: "foo bar" or 'foo bar'
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] || m[2] || m[3] || "").trim();
    if (!t) continue;
    tokens.push(t);
  }
  return tokens;
}

function buildTokenAndDomain({ tokens, field }) {
  const ts = (tokens || []).filter((t) => String(t || "").trim());
  if (!ts.length) return [];
  return ts.map((t) => [field, "ilike", String(t).trim()]);
}

function uniqById(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const id = r?.id;
    if (!Number.isInteger(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

function extractNeckFinish(text) {
  const s = String(text || "");
  // Examples: R-38, R38, R-28/350, R 28/350
  const m = s.match(/\bR[\s-]?\d+(?:\/\d+)?\b/i);
  if (!m) return null;
  // normalize spacing (keep slash)
  return m[0].replace(/\s+/g, "").replace(/^R/i, "R").replace(/^R(\d)/, "R-$1");
}

async function callXenaApi({ path, payload }) {
  const token = (process.env.XENA_API_TOKEN || "").trim();
  if (!token) {
    return { ok: false, status: 0, error: "Missing XENA_API_TOKEN" };
  }
  const url = `${odoo.baseUrl}${path}`;
  const requestId = `mcp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.error?.message || data?.message || `HTTP ${res.status}`,
      data,
    };
  }
  // Contract uses { ok: true, data: {...} }
  return { ok: true, status: res.status, data };
}

const server = new McpServer({
  name: "odoo-readonly",
  version: "1.0.0",
});

server.tool("odoo_ping", {}, async () => {
  const uid = await odoo.ensureAuth();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            uid,
            baseUrl: odoo.baseUrl,
            db: odoo.db,
            username: odoo.username,
          },
          null,
          2,
        ),
      },
    ],
  };
});

server.tool(
  "odoo_partner_search",
  {
    query: z.string().optional().describe("Search by name/email/phone; empty returns recent"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ query, limit }) => {
    const lim = clampLimit(limit, defaultLimit, 200);
    const domain = [];
    if (query && query.trim()) {
      const q = query.trim();
      domain.push("|", "|", ["name", "ilike", q], ["email", "ilike", q], ["phone", "ilike", q]);
    }
    const rows = await odoo.executeKw({
      model: "res.partner",
      method: "search_read",
      args: [domain],
      kwargs: {
        fields: ["id", "name", "display_name", "email", "phone", "vat", "is_company", "company_type"],
        limit: lim,
        order: "id desc",
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  "odoo_partner_get",
  {
    partner_id: z.number().int().positive(),
  },
  async ({ partner_id }) => {
    const rows = await odoo.executeKw({
      model: "res.partner",
      method: "read",
      args: [[partner_id]],
      kwargs: {
        fields: [
          "id",
          "name",
          "display_name",
          "email",
          "phone",
          "vat",
          "street",
          "street2",
          "zip",
          "city",
          "state_id",
          "country_id",
        ],
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(rows?.[0] || null, null, 2) }] };
  },
);

server.tool(
  "odoo_sale_order_search",
  {
    query: z.string().optional().describe("Search by SO name (e.g. S00045) or partner name/email"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ query, limit }) => {
    const lim = clampLimit(limit, defaultLimit, 200);
    const domain = [];
    if (query && query.trim()) {
      const q = query.trim();
      domain.push("|", "|", ["name", "ilike", q], ["partner_id", "ilike", q], ["partner_id.email", "ilike", q]);
    }
    const rows = await odoo.executeKw({
      model: "sale.order",
      method: "search_read",
      args: [domain],
      kwargs: {
        fields: ["id", "name", "state", "date_order", "partner_id", "amount_total", "currency_id"],
        limit: lim,
        order: "id desc",
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  "odoo_sale_order_get",
  {
    sale_order_id: z.number().int().positive(),
  },
  async ({ sale_order_id }) => {
    const rows = await odoo.executeKw({
      model: "sale.order",
      method: "read",
      args: [[sale_order_id]],
      kwargs: {
        fields: [
          "id",
          "name",
          "state",
          "date_order",
          "partner_id",
          "order_line",
          "amount_untaxed",
          "amount_tax",
          "amount_total",
          "currency_id",
        ],
      },
    });
    const so = rows?.[0] || null;
    if (!so) return { content: [{ type: "text", text: JSON.stringify(null, null, 2) }] };

    const lineIds = Array.isArray(so.order_line) ? so.order_line : [];
    let order_lines = [];
    let productsById = {};

    if (lineIds.length) {
      order_lines = await odoo.executeKw({
        model: "sale.order.line",
        method: "read",
        args: [lineIds],
        kwargs: {
          fields: [
            "id",
            "order_id",
            "sequence",
            "display_type",
            "name",
            "product_id",
            "product_uom_qty",
            "qty_delivered",
            "qty_invoiced",
            "price_unit",
            "discount",
            "price_subtotal",
            "price_total",
            "tax_id",
            "is_delivery",
          ],
        },
      });

      const productIds = Array.from(
        new Set(
          (order_lines || [])
            .map((l) => l?.product_id?.[0])
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      );
      if (productIds.length) {
        const prows = await odoo.executeKw({
          model: "product.product",
          method: "read",
          args: [productIds],
          kwargs: { fields: ["id", "default_code", "display_name"] },
        });
        productsById = Object.fromEntries((prows || []).map((p) => [p.id, p]));
      }

      order_lines = (order_lines || []).map((l) => {
        const pid = l?.product_id?.[0];
        const p = pid ? productsById[pid] : null;
        return {
          ...l,
          sku: p?.default_code || null,
          product_display_name: p?.display_name || null,
        };
      });
    }

    return { content: [{ type: "text", text: JSON.stringify({ ...so, order_lines }, null, 2) }] };
  },
);

server.tool(
  "odoo_stock_quant_search",
  {
    product_sku: z.string().optional().describe("Match product.default_code"),
    location_name: z.string().optional().describe("Filter by location name ilike"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ product_sku, location_name, limit }) => {
    const lim = clampLimit(limit, defaultLimit, 200);

    const domain = [];
    if (product_sku && product_sku.trim()) {
      const products = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["default_code", "=", product_sku.trim()]]],
        kwargs: { fields: ["id", "default_code", "display_name"], limit: 1 },
      });
      const p = products?.[0];
      if (!p) return { content: [{ type: "text", text: JSON.stringify([], null, 2) }] };
      domain.push(["product_id", "=", p.id]);
    }
    if (location_name && location_name.trim()) {
      domain.push(["location_id", "ilike", location_name.trim()]);
    }

    const rows = await odoo.executeKw({
      model: "stock.quant",
      method: "search_read",
      args: [domain],
      kwargs: {
        fields: ["id", "product_id", "location_id", "quantity", "reserved_quantity", "available_quantity"],
        limit: lim,
        order: "id desc",
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  "odoo_stock_move_line_search",
  {
    product_sku: z.string().optional().describe("Match product.default_code"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ product_sku, limit }) => {
    const lim = clampLimit(limit, defaultLimit, 200);
    const domain = [];
    if (product_sku && product_sku.trim()) {
      const products = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["default_code", "=", product_sku.trim()]]],
        kwargs: { fields: ["id"], limit: 1 },
      });
      const p = products?.[0];
      if (!p) return { content: [{ type: "text", text: JSON.stringify([], null, 2) }] };
      domain.push(["product_id", "=", p.id]);
    }
    const rows = await odoo.executeKw({
      model: "stock.move.line",
      method: "search_read",
      args: [domain],
      kwargs: {
        fields: [
          "id",
          "date",
          "reference",
          "picking_id",
          "product_id",
          "qty_done",
          "location_id",
          "location_dest_id",
          "state",
        ],
        limit: lim,
        order: "id desc",
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Product Picker endpoints (MCP equivalents; read-only best-effort)
// ---------------------------------------------------------------------------

server.tool(
  "xena_search_products",
  {
    query: z.string().optional().describe("Free-text query (sku/name)"),
    filters: z
      .object({
        type: z.string().optional(),
        material: z.string().optional(),
        capacity_ml: z.union([z.string(), z.number()]).optional(),
        neck_finish: z.string().optional(),
        closure_type: z.string().optional(),
        color: z.string().optional(),
      })
      .partial()
      .optional()
      .describe("Best-effort filters; custom fields vary by DB"),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ query, filters, limit }) => {
    const lim = clampLimit(limit, defaultLimit, 200);
    const tokens = tokenizeQuery(query);
    const warnings = [];

    // Filters are DB-specific; we only apply the ones that are likely standard.
    const f = filters || {};
    const baseFilters = [];
    if (f.type) baseFilters.push(["detailed_type", "=", f.type]);

    // For multi-keyword search we intentionally avoid large OR domains (they behave unreliably via JSON-RPC).
    // Instead: run multiple AND searches on reliable stored fields and union results.
    const fieldsToSearch = ["name", "default_code", "description_sale"];
    let combined = [];

    if (!tokens.length) {
      // No query: recent products
      combined = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [baseFilters],
        kwargs: { fields: ["id", "default_code", "name", "display_name", "website_url", "qty_available", "free_qty", "sale_delay", "x_studio_das_para_fabricar", "lst_price", "is_kits"], limit: lim, order: "id desc" },
      });
    } else {
      for (const field of fieldsToSearch) {
        const d = baseFilters.concat(buildTokenAndDomain({ tokens, field }));
        const rows = await odoo.executeKw({
          model: "product.product",
          method: "search_read",
          args: [d],
          kwargs: { fields: ["id", "default_code", "name", "display_name", "website_url", "qty_available", "free_qty", "sale_delay", "x_studio_das_para_fabricar", "lst_price"], limit: lim, order: "id desc" },
        });
        if (rows?.length) {
          combined = combined.concat(rows);
          warnings.push(`Matched on field: ${field}`);
        }
      }
    }

    let products = uniqById(combined).filter(p => {
      // Filter phantom kits using the native Odoo flag
      if (p.is_kits) return false;

      // 0-latency kit filtering
      const text = `${p.display_name || ""} ${p.name || ""} ${p.default_code || ""}`.toLowerCase();
      if (text.includes("mayoreo") || text.includes("paquete") || text.includes("pack") || text.includes("kit")) return false;
      if (typeof p.default_code === 'string' && (p.default_code.startsWith('V-ML-') || p.default_code.startsWith('V-AMZ-') || p.default_code.startsWith('KIT-'))) return false;
      return true;
    });

    products.sort((a, b) => (b?.id || 0) - (a?.id || 0));
    products = products.slice(0, lim).map(p => {
      const inStock = (p.free_qty ?? p.qty_available) > 0;
      const etaDays = p.x_studio_das_para_fabricar || p.sale_delay || 0;
      return {
        ...p,
        base_price: p.lst_price || 0,
        in_stock: inStock,
        eta_days: inStock ? 0 : etaDays,
        lead_time_msg: inStock ? "Entrega inmediata" : `Sobre pedido (Disponible en ${etaDays} días)`
      };
    });

    return { content: [{ type: "text", text: JSON.stringify({ products, warnings }, null, 2) }] };
  },
);

server.tool(
  "xena_get_product_details",
  {
    sku: z.string().describe("product.default_code"),
  },
  async ({ sku }) => {
    const s = (sku || "").trim();
    const products = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [[["default_code", "=", s]]],
      kwargs: {
        fields: ["id", "default_code", "name", "display_name", "website_url", "description_sale", "lst_price", "weight", "volume", "uom_id", "product_tmpl_id"],
        limit: 1,
      },
    });
    const p = products?.[0] || null;
    if (!p) return { content: [{ type: "text", text: JSON.stringify(null, null, 2) }] };

    // Extra template images (best-effort)
    let images = [];
    const tmplId = p.product_tmpl_id?.[0];
    if (tmplId) {
      const imgRows = await odoo.executeKw({
        model: "product.image",
        method: "search_read",
        args: [[["product_tmpl_id", "=", tmplId]]],
        kwargs: { fields: ["id"], limit: 20, order: "id asc" },
      });
      images = (imgRows || []).map((r) => ({ id: r.id }));
    }

    return { content: [{ type: "text", text: JSON.stringify({ ...p, images }, null, 2) }] };
  },
);

server.tool(
  "xena_get_compatible_closures",
  {
    container_sku: z.string().optional(),
    neck_finish: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ container_sku, neck_finish, limit }) => {
    const lim = clampLimit(limit, defaultLimit, 200);
    const warnings = [];
    let nf = (neck_finish || "").trim();

    // If a container SKU is provided, try to infer neck finish from the container name/display_name.
    const csku = (container_sku || "").trim();
    if (!nf && csku) {
      const containers = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["default_code", "=", csku]]],
        kwargs: { fields: ["id", "default_code", "display_name", "name"], limit: 1 },
      });
      const c = containers?.[0] || null;
      const inferred = extractNeckFinish(c?.display_name || c?.name);
      if (inferred) nf = inferred;
      else warnings.push("Could not infer neck_finish from container_sku; provide neck_finish explicitly.");
    }

    // Closures search: require token 'tapa' AND all user-provided tokens across common fields.
    const queryTokens = ["tapa"].concat(tokenizeQuery(nf));
    const fieldsToSearch = ["name", "default_code", "description_sale"];
    let combined = [];
    for (const field of fieldsToSearch) {
      const d = buildTokenAndDomain({ tokens: queryTokens, field });
      const rows = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [d],
        kwargs: { fields: ["id", "default_code", "name", "display_name", "website_url"], limit: lim, order: "id desc" },
      });
      if (rows?.length) combined = combined.concat(rows);
    }
    let rows = uniqById(combined);
    rows.sort((a, b) => (b?.id || 0) - (a?.id || 0));
    rows = rows.slice(0, lim);

    return { content: [{ type: "text", text: JSON.stringify({ neck_finish: nf || null, closures: rows, warnings }, null, 2) }] };
  },
);

server.tool(
  "xena_get_price",
  {
    sku: z.string().describe("product.default_code"),
    qty: z.number().positive(),
    customer_segment: z.string().optional().describe("Best-effort: matched against pricelist name"),
  },
  async ({ sku, qty, customer_segment }) => {
    // Prefer the server-side pricing endpoint when available (computed price rules/discounts).
    // Falls back to list price if XENA_API_TOKEN is not configured.
    const apiAttempt = await callXenaApi({
      path: "/api/pricing/get_price",
      payload: { sku: String(sku).trim(), qty, customer_segment: customer_segment || null, partner_id: null },
    });

    if (apiAttempt.ok) {
      const data = apiAttempt.data?.data || apiAttempt.data;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                pricing_mode: "computed_via_xena_api",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Read-only approximation: choose a pricelist by name (if any), return lst_price * qty otherwise.
    const products = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [[["default_code", "=", String(sku).trim()]]],
      kwargs: { fields: ["id", "default_code", "display_name", "lst_price"], limit: 1 },
    });
    const p = products?.[0] || null;
    if (!p) return { content: [{ type: "text", text: JSON.stringify(null, null, 2) }] };

    let pricelist = null;
    if (customer_segment && customer_segment.trim()) {
      const pls = await odoo.executeKw({
        model: "product.pricelist",
        method: "search_read",
        args: [[["name", "ilike", customer_segment.trim()]]],
        kwargs: { fields: ["id", "name", "currency_id"], limit: 1 },
      });
      pricelist = pls?.[0] || null;
    }

    const unitPrice = Number(p.lst_price || 0);
    const extended = unitPrice * Number(qty || 0);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sku: p.default_code,
              product_id: p.id,
              qty,
              customer_segment: customer_segment || null,
              pricelist,
              pricing_mode: "approx_list_price",
              unit_price: unitPrice,
              extended_price: extended,
              warning:
                apiAttempt.status
                  ? `Computed pricing unavailable (${apiAttempt.status}: ${apiAttempt.error}). Returning list_price approximation. Configure XENA_API_TOKEN to enable /api/pricing/get_price.`
                  : `Computed pricing unavailable (${apiAttempt.error}). Returning list_price approximation. Configure XENA_API_TOKEN to enable /api/pricing/get_price.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "xena_find_kits_for_sku",
  {
    sku: z.string().describe("component product.default_code"),
    limit: z.number().int().positive().max(100).optional(),
  },
  async ({ sku, limit }) => {
    const lim = clampLimit(limit, 20, 100);
    const products = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [[["default_code", "=", String(sku).trim()]]],
      kwargs: { fields: ["id", "default_code", "display_name"], limit: 1 },
    });
    const p = products?.[0] || null;
    if (!p) return { content: [{ type: "text", text: JSON.stringify({ kits: [], warning: "Component not found" }, null, 2) }] };

    const boms = await odoo.executeKw({
      model: "mrp.bom",
      method: "search_read",
      args: [[["bom_line_ids.product_id", "=", p.id]]],
      kwargs: { fields: ["id", "product_id", "product_tmpl_id"], limit: lim, order: "id desc" },
    });
    return { content: [{ type: "text", text: JSON.stringify({ component: p, boms }, null, 2) }] };
  },
);

server.tool(
  "xena_get_recent_orders",
  {
    contact_id: z.number().int().positive().describe("res.partner id"),
    limit: z.number().int().positive().max(10).optional(),
  },
  async ({ contact_id, limit }) => {
    const lim = clampLimit(limit, 3, 10);
    const rows = await odoo.executeKw({
      model: "sale.order",
      method: "search_read",
      args: [[["partner_id", "child_of", contact_id]]],
      kwargs: { fields: ["id", "name", "date_order", "state", "amount_total", "currency_id", "order_line"], limit: lim, order: "date_order desc, id desc" },
    });
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  "xena_get_order_status",
  {
    order_id: z.number().int().positive().optional(),
    order_name: z.string().optional(),
  },
  async ({ order_id, order_name }) => {
    let so = null;
    if (order_id) {
      const rows = await odoo.executeKw({
        model: "sale.order",
        method: "read",
        args: [[order_id]],
        kwargs: { fields: ["id", "name", "state", "date_order", "amount_total", "currency_id", "picking_ids"] },
      });
      so = rows?.[0] || null;
    } else if (order_name && order_name.trim()) {
      const rows = await odoo.executeKw({
        model: "sale.order",
        method: "search_read",
        args: [[["name", "=", order_name.trim()]]],
        kwargs: { fields: ["id", "name", "state", "date_order", "amount_total", "currency_id", "picking_ids"], limit: 1 },
      });
      so = rows?.[0] || null;
    }
    if (!so) return { content: [{ type: "text", text: JSON.stringify(null, null, 2) }] };

    const pickingIds = so.picking_ids || [];
    let pickings = [];
    if (Array.isArray(pickingIds) && pickingIds.length) {
      pickings = await odoo.executeKw({
        model: "stock.picking",
        method: "read",
        args: [pickingIds],
        kwargs: { fields: ["id", "name", "state", "carrier_tracking_ref"] },
      });
    }

    return { content: [{ type: "text", text: JSON.stringify({ ...so, pickings }, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

