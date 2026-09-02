import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import cors from "cors";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { loadEnvFile } from "./env.js";
import { OdooClient, clampLimit } from "./odoo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 0. CONFIGURATION & CONSTANTS
// ---------------------------------------------------------------------------

const SHIPPING_COST_METROPOLI = 199;
const SHIPPING_COST_INTERIOR = 299; // Suggested default for Interior, adjust as needed
const WHOLESALE_THRESHOLD = process.env.WHOLESALE_THRESHOLD ? parseFloat(process.env.WHOLESALE_THRESHOLD) : 2000.0;
const LARGE_ACCESSORY_PER_BOX = 400;

const SHIPPING_CAPACITY = [
  { ml: 20000, per_box: 1 },
  { ml: 10000, per_box: 20 },
  { ml: 5000, per_box: 40 },
  { ml: 1000, per_box: 100 },
  { ml: 500, per_box: 145 },
  { ml: 250, per_box: 225 },
  { ml: 100, per_box: 500 },
  { ml: 30, per_box: 1000 }
];

// Load CP Database
const cpDbPath = path.join(__dirname, "..", "data", "mexico_cps.json");
let CP_DATABASE = [];
try {
  if (fs.existsSync(cpDbPath)) {
    CP_DATABASE = JSON.parse(fs.readFileSync(cpDbPath, 'utf8'));
    console.error(`Loaded ${CP_DATABASE.length} CPs from database.`);
  }
} catch (err) {
  console.error("Failed to load CP database:", err);
}

const STATE_MAPPING = {
  "Aguascalientes": "AGU",
  "Baja California": "BCN",
  "Baja California Sur": "BCS",
  "Campeche": "CAM",
  "Chiapas": "CHP",
  "Chihuahua": "CHH",
  "Ciudad de México": "CMX",
  "Coahuila de Zaragoza": "COA",
  "Colima": "COL",
  "Durango": "DUR",
  "Guanajuato": "GUA",
  "Guerrero": "GRO",
  "Hidalgo": "HID",
  "Jalisco": "JAL",
  "México": "MEX",
  "Michoacán de Ocampo": "MIC",
  "Morelos": "MOR",
  "Nayarit": "NAY",
  "Nuevo León": "NLE",
  "Oaxaca": "OAX",
  "Puebla": "PUE",
  "Querétaro": "QUE",
  "Quintana Roo": "ROO",
  "San Luis Potosí": "SLP",
  "Sinaloa": "SIN",
  "Sonora": "SON",
  "Tabasco": "TAB",
  "Tamaulipas": "TAM",
  "Tlaxcala": "TLA",
  "Veracruz de Ignacio de la Llave": "VER",
  "Yucatán": "YUC",
  "Zacatecas": "ZAC"
};

function normalizeText(str) {
  if (!str) return "";
  return String(str)
    .replace(/A\?mbar/g, 'Ambar') // Specific fix for common encoding corruption
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeStateName(name) {
  return normalizeText(name);
}

function getCpInfo(cp) {
  const cleanCp = String(cp).padStart(5, '0');
  const info = CP_DATABASE.find(entry => entry.cp === cleanCp);
  if (!info) return null;
  
  const state = info.e;
  const normalizedState = normalizeStateName(state);
  const isMetropoli = normalizedState === "ciudad de mexico" || normalizedState === "mexico";
  
  // Find state code using normalized mapping
  let stateCode = null;
  for (const [sName, sCode] of Object.entries(STATE_MAPPING)) {
    if (normalizeStateName(sName) === normalizedState) {
      stateCode = sCode;
      break;
    }
  }

  return {
    municipality: info.m,
    state: state,
    state_code: stateCode,
    category: isMetropoli ? "Metropoli" : "Interior",
    shipping_cost: isMetropoli ? SHIPPING_COST_METROPOLI : SHIPPING_COST_INTERIOR
  };
}

// Load environment variables
const possibleEnvPaths = [
  path.join(__dirname, "..", "env.local"),
  path.join(__dirname, "..", "..", "odoo_readonly_mcp", "env.local"), 
];
for (const p of possibleEnvPaths) {
  loadEnvFile(p);
}

const odoo = OdooClient.fromEnv();
const defaultLimit = clampLimit(process.env.ODOO_DEFAULT_LIMIT, 5, 200);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (process.env.MCP_TRANSPORT === "sse" || process.env.PORT) {
  if (!AUTH_TOKEN) {
    console.warn("WARNING: MCP_AUTH_TOKEN is not set. Service is running without authentication.");
  }
}

// ---------------------------------------------------------------------------
// 1. CORE SEARCH LOGIC (Refactored for Category-First Intent)
// ---------------------------------------------------------------------------

const CATEGORIES = {
  CONTAINER: ['ALM', 'ALUM', 'ENV', 'PLA', 'POLI', 'VID'],
  CLOSURE: ['TAPA'],
  SEAL: ['SELLO'],
  BOX: ['EMB-CAJA']
};

const MATERIALS = {
  'aluminio': ['ALM', 'ALUM'],
  'plastico': ['PLA', 'PET', 'POLI'],
  'pet': ['PLA'],
  'polietileno': ['POLI'],
  'vidrio': ['VID']
};

const CATEGORY_KEYWORDS = {
  CONTAINER: ['botella', 'garrafa', 'bidon', 'envase', 'frasco', 'tarro', 'porron', 'cubeta', 'tambo', 'berlin', 'hexagonal', 'bordalesa', 'cilindrico', 'boston', 'jefferson', 'campanita'],
  CLOSURE: ['tapa', 'tapadera', 'atomizador', 'spray', 'trigger', 'rociador', 'valvula', 'llave', 'liner']
};

const GENERIC_CONTAINERS = ['botella', 'garrafa', 'bidon', 'envase', 'frasco', 'tarro', 'porron', 'cubeta', 'tambo', 'contenedor'];

const SYNONYMS = {
  'garrafa': ['bidon', 'porron', 'bidón', 'porrón', 'envase', 'cubeta'],
  'bidon': ['garrafa', 'porron', 'bidón', 'envase', 'cubeta'],
  'botella': ['envase', 'frasco', 'garrafa', 'bidon'],
  'envase': ['botella', 'frasco', 'tarro', 'contenedor'],
  'atomizador': ['spray', 'atomizadora', 'trigger', 'rociador'],
  'spray': ['atomizador', 'rociador'],
  'cuadrada': ['cuad'],
  'cubeta': ['porron', 'bidon', 'garrafa'],
  'tambo': ['bidon', 'porron'],
  'berlin': ['pla-env-125ml-berlin-amb-r24', 'ambar 125 ml', 'berlin 125'],
  'hexagonal': ['vid-frasc-hxnl-250ml-r63', 'hexagonal 250 ml', 'hexagonal 250'],
  'bordalesa': ['vid-bot-750ml-bord-corcho', 'bordalesa 750 ml', 'bordalesa 750'],
  'tarro': ['v-ml-2145-bc', 'tarro 50 ml', 'tarro 50'],
  'cilindrico': ['v-ml-1708-do', 'cilindrico 9 oz', 'cilindrico 250 ml', 'cilindrico 250'],
  'boston': ['bostn', 'bostoniana'],
  'bostoniana': ['bostn', 'boston'],
  'jefferson': ['jeff']
};

const FREQUENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FREQUENT_PRODUCTS = [
  {
    default_code: "PLA-ENV-125ML-BERLIN-AMB-R24",
    name: "Frasco Berlin Ámbar 125 ml",
    capacity_ml: 125,
    marketplace: false,
    marketplace_sku: "V-ML-11774-BC",
    publication_url: null,
    keys: ["berlin 125", "ambar 125", "ámbar 125", "125ml ambar"]
  },
  {
    default_code: "VID-FRASC-HXNL-250ML-R63",
    name: "Frasco Hexagonal 250 ml",
    capacity_ml: 250,
    marketplace: false,
    marketplace_sku: "V-ML-1899-BC",
    publication_url: null,
    keys: ["hexagonal 250", "hexagonal 250ml", "frasco hexagonal"]
  },
  {
    default_code: "VID-BOT-750ML-BORD-CORCHO",
    name: "Botella Bordalesa 750 ml",
    capacity_ml: 750,
    marketplace: false,
    marketplace_sku: "V-ML-8923-CF",
    publication_url: null,
    keys: ["bordalesa 750", "vino 750", "tequila 750", "botella 750"]
  },
  {
    default_code: "PLA-TARRO-50ML-NAT-R58",
    name: "Tarro 50 ml (Pomadera)",
    capacity_ml: 50,
    marketplace: false,
    marketplace_sku: "V-ML-2145-BC",
    publication_url: null,
    keys: ["tarro 50", "pomadera 50", "tarro pomadera", "frasco 50 ml"]
  },
  {
    default_code: "VID-TARRO-270ML/9OZ-R70",
    name: "Frasco Cilíndrico 9 oz / 250 ml",
    capacity_ml: 250,
    marketplace: false,
    marketplace_sku: "V-ML-1708-DO",
    publication_url: null,
    keys: ["cilindrico 9 oz", "cilindrico 250", "frasco 9 oz", "9oz"]
  },
  {
    default_code: "VID-FRASC-32OZ-NAT-R70",
    name: "Tarro 32 oz / 940 ml",
    capacity_ml: 940,
    marketplace: false,
    marketplace_sku: "V-ML-1652",
    publication_url: null,
    keys: ["tarro 32 oz", "frasco 32 oz", "32oz", "940ml", "940 ml", "conserva 940", "frasco conserva", "tarro conserva", "tarro 940", "frasco 940"]
  }
];
let frequentCache = { stamp: 0, data: [] };

const OZ_TO_ML_OVERRIDE = {
  9: 250 // round to popular 250 ml size for 9 oz
};

// XENA_SHOPIFY_CUTOVER_2026-05-07:
// Temporary marker for URL-source migration.
// URL source priority per model during cutover:
// 1) Shopify field (preferred)
// 2) Odoo website_url fallback (required while Shopify backfill completes)
const ODOO_TABLE_CONFIG = {
  "product.product": {
    url_fields: ["x_studio_link_shopify", "website_url"],
    required_fields: ["id", "default_code", "name", "website_published"]
  },
  "res.partner": {
    url_fields: [],
    required_fields: ["id", "name"]
  },
  "sale.order": {
    url_fields: [],
    required_fields: ["id", "name"]
  }
};

function getTableConfig(model) {
  return ODOO_TABLE_CONFIG[model] || { url_fields: [], required_fields: [] };
}

function buildReadFields(model, fields = []) {
  const cfg = getTableConfig(model);
  return [...new Set([...(cfg.required_fields || []), ...fields, ...(cfg.url_fields || [])])];
}

function resolveCommerceUrl(row, model = "product.product") {
  const cfg = getTableConfig(model);
  for (const field of (cfg.url_fields || [])) {
    const raw = row?.[field];
    if (!raw || typeof raw !== "string") continue;
    if (field === "website_url" && raw.startsWith("/")) {
      return `https://envasesxena.odoo.com${raw}`;
    }
    return raw;
  }
  return null;
}

function normalize(str) {
  return normalizeStateName(str);
}

function tokenize(input) {
  const q = normalize(input);
  if (!q) return { volume: [], dimensions: [], material: [], keywords: [] };
  
  const tokens = {
    volume: [],
    dimensions: [],
    material: [],
    category: null,
    keywords: []
  };

  let remaining = q;

  // 1. Extract Dimensions (Box Intent)
  const dimensionRegex = /\b(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\b/gi;
  let dMatch;
  while ((dMatch = dimensionRegex.exec(remaining)) !== null) {
    const dims = [parseFloat(dMatch[1]), parseFloat(dMatch[2]), parseFloat(dMatch[3])].sort((a, b) => b - a);
    const volume_cm3 = dims[0] * dims[1] * dims[2];
    
    tokens.dimensions.push({
      raw: dMatch[0],
      dims,
      volume_cm3,
      variants: [
        `${dMatch[1]}x${dMatch[2]}x${dMatch[3]}`,
        `${dMatch[1]} X ${dMatch[2]} X ${dMatch[3]}`,
        dims.join('x'),
        dims.join(' X ')
      ]
    });
    
    if (q.includes("caja") || q.includes("emb-caja")) {
      tokens.category = 'BOX';
    }
  }
  remaining = remaining.replace(dimensionRegex, " ");

  // 2. Extract Volume (Container Intent)
  const unitRegex = /\b(\d+)(?:\.\d+)?\s*(ml|l|oz|lt|litro|litros|mililitros|onzas|galon|galones)\b/gi;
  let match;
  while ((match = unitRegex.exec(remaining)) !== null) {
    const num = match[1];
    let unit = match[2];
    
    unit = unit
      .replace(/^mililitros?$/, "ml")
      .replace(/^litros?$/, "ml") 
      .replace(/^onzas?$/, "oz")
      .replace(/^galones?$/, "galon");

    let val = parseFloat(num);
    if (match[2].startsWith('l') || match[2] === 'lt') val *= 1000; 
    if (match[2] === 'oz' || match[2] === 'onzas') val *= 29.5735;
    if (match[2] === 'galon' || match[2] === 'galones') val *= 3785.41;
    
    const variants = [`${num}${match[2]}`, `${num} ${match[2]}`];
    if (val > 0) {
      if (match[2] !== 'ml') { // avoid duplicating if original was ml
        variants.push(`${Math.round(val)}ml`, `${Math.round(val)} ml`);
      } else {
        variants.push(`${val}ml`, `${val} ml`);
      }
      if (val === 1000) { variants.push('1000ml', '1lt', '1 lt', '1litro'); }
      if (val === 5000) { variants.push('5000ml', '5lt', '5 lt', '5litros'); }
      if (val === 20000) { variants.push('20000ml', '20lt', '20 lt', '20litros'); }
    }
    
    tokens.volume.push({ 
      val_ml: val,
      variants: [...new Set(variants)] 
    });
  }
  remaining = remaining.replace(unitRegex, " ");

  // 3. Extract Keywords and Material
  const words = remaining.split(/[\s-]+/).filter(w => w.length > 0);
  for (const word of words) {
    if (["y", "con", "de", "el", "la", "las", "los", "un", "una", "para", "and"].includes(word)) continue;

    let foundMaterial = false;
    for (const [mat, codes] of Object.entries(MATERIALS)) {
      if (word === mat) {
        tokens.material.push({ name: mat, codes });
        foundMaterial = true;
      }
    }
    if (word === 'plastico') {
      tokens.material.push({ name: 'plastico', codes: ['PLA', 'POLI'] });
      foundMaterial = true;
    }

    if (CATEGORY_KEYWORDS.CLOSURE.includes(word)) {
      tokens.category = 'CLOSURE';
    } else if (CATEGORY_KEYWORDS.CONTAINER.includes(word)) {
      tokens.category = 'CONTAINER';
    }

    const variants = [word];
    if (SYNONYMS[word]) SYNONYMS[word].forEach(s => variants.push(s));
    tokens.keywords.push({ variants });
  }
  
  return tokens;
}

function ensureFrequentCache() {
  const now = Date.now();
  if (now - frequentCache.stamp > FREQUENT_CACHE_TTL_MS || frequentCache.data.length === 0) {
    frequentCache = {
      stamp: now,
      data: FREQUENT_PRODUCTS.map(p => ({
        id: null,
        default_code: p.default_code,
        name: p.name,
        display_name: p.name,
        marketplace_sku: p.marketplace_sku || null,
        website_url: null,
        publication_url: p.publication_url || null,
        in_stock: true,
        neck_size: null,
        capacity_ml: p.capacity_ml,
        marketplace: !!p.marketplace,
        keys: p.keys.map(k => normalizeText(k))
      }))
    };
  }
}

function findFrequentHit(query, filters) {
  ensureFrequentCache();
  const q = normalizeText(query || "");
  const cap = filters?.capacity_ml ? Number(filters.capacity_ml) : null;
  return frequentCache.data.find(p => {
    const keyHit = p.keys.some(k => q.includes(k));
    const capHit = cap ? Math.abs(cap - (p.capacity_ml || 0)) <= 5 : true;
    return keyHit && capHit;
  });
}

function resolveCapacityOverride(query, filters = {}) {
  const q = normalizeText(query || "");
  if (!filters.capacity_ml) {
    const explicitCapMatch = q.match(/(\d+(?:\.\d+)?)\s*(ml|l|lt|litro|litros|mililitros)\b/);
    if (explicitCapMatch) {
      const num = parseFloat(explicitCapMatch[1]);
      const unit = explicitCapMatch[2];
      const valMl = (unit === "l" || unit === "lt" || unit === "litro" || unit === "litros") ? num * 1000 : num;
      return { ...filters, capacity_ml: valMl };
    }
    const ozMatch = q.match(/(\d+)\s*oz/);
    if (ozMatch) {
      const ozVal = parseInt(ozMatch[1], 10);
      if (OZ_TO_ML_OVERRIDE[ozVal]) {
        return { ...filters, capacity_ml: OZ_TO_ML_OVERRIDE[ozVal] };
      }
    }
  }
  return filters;
}

function computeBundlesOnly(products) {
  if (!products?.length) return false;
  return products.every(p => {
    const text = `${p.display_name || ""} ${p.name || ""} ${p.default_code || ""}`.toLowerCase();
    return text.includes("paquete") || text.includes("pack") || text.includes("kit");
  });
}

function pickBestMatch(products, suggestions) {
  if (products?.length) return products[0];
  if (suggestions?.length) return suggestions[0];
  return null;
}

function buildDomain(tokens, isStrict = true) {
  const domain = [
    ["sale_ok", "=", true],
    ["website_published", "=", true],
    ["x_studio_anlisis_de_recompra", "!=", false]
  ];

  if (tokens.category === 'CLOSURE') {
    domain.push(["default_code", "=ilike", "TAPA%"]);
  } else if (tokens.category === 'BOX') {
    domain.push(["default_code", "=ilike", "EMB-CAJA%"]);
  } else if (tokens.category === 'CONTAINER' || (tokens.material && tokens.material.length > 0)) {
    const prefixes = (tokens.material && tokens.material.length > 0)
      ? [...new Set(tokens.material.flatMap(m => m.codes))]
      : CATEGORIES.CONTAINER;
    
    if (prefixes.length > 0) {
      const prefixConditions = prefixes.map(p => ["default_code", "=ilike", p + "%"]);
      if (prefixConditions.length > 1) {
        for (let i = 0; i < prefixConditions.length - 1; i++) domain.push("|");
      }
      prefixConditions.forEach(c => domain.push(c));
    }
  }

  const allIntentTokens = [...(tokens.volume || []), ...(tokens.dimensions || []), ...(tokens.keywords || [])];
  const materialKeywords = (tokens.material || []).map(m => m.name);

  for (const token of allIntentTokens) {
    const isCategoryKeyword = token.variants && token.variants.some(v => 
      GENERIC_CONTAINERS.includes(v) || CATEGORY_KEYWORDS.CLOSURE.includes(v) || v === "caja"
    );
    
    if (isStrict && isCategoryKeyword) continue;
    
    // Skip material keywords if they were already used to generate SKU prefixes
    if (isStrict && token.variants && token.variants.some(v => materialKeywords.includes(v))) continue;

    // domain.unshift("&");
    const fields = ["name", "default_code", "description_sale"];
    const conditions = [];
    
    for (const field of fields) {
      for (const variant of token.variants) {
        conditions.push([field, "ilike", variant]);
      }
    }

    if (conditions.length === 1) {
      domain.push(conditions[0]);
    } else {
      for (let i = 0; i < conditions.length - 1; i++) domain.push("|");
      conditions.forEach(c => domain.push(c));
    }
  }

  return domain;
}

function extractNeckSize(name) {
  if (!name) return null;
  const cleanName = name.replace(/^\[.*?\]\s*/, '');
  const match = cleanName.match(/\b(R[\-\/ ]?\d+([\-\/ ]\d+)?(?:[\s]+[A-Z])?(?:\s+(?:fald[oó]n|twist(?:\s*\-?\s*off)?))?)\b/i);
  return match ? match[0].toUpperCase().replace(/\s+/g, ' ').trim() : null;
}

// Detects the closure system of a container by inspecting its name.
// Returns: 'TWIST' for twist-off caps, 'FALDON' for faldón caps, 'ROSCA' for standard threaded.
function extractClosureType(name) {
  if (!name) return 'ROSCA';
  const n = name.toUpperCase();
  if (n.includes('TWIST')) return 'TWIST';
  if (n.includes('FALDON') || n.includes('FALDÓN')) return 'FALDON';
  return 'ROSCA';
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

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.pool = null;
    if (process.env.DATABASE_URL && process.env.DATABASE_URL !== "*****REDACTED*****" && process.env.DATABASE_URL.startsWith("postgres")) {
      try {
        this.pool = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : false
        });
        // Add error handler to prevent crash on idle connection error
        this.pool.on('error', (err) => {
          console.error('Unexpected error on idle client', err);
        });
        console.error("SessionManager: Postgres pool initialized.");
      } catch (err) {
        console.error("SessionManager: Failed to initialize Postgres pool:", err);
      }
    } else {
      console.error("SessionManager: Invalid or inactive DATABASE_URL, using in-memory only.");
    }
  }

  async get(sessionId) {
    // 1. Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    // 2. Check Postgres if pool available
    if (this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM xena_sessions WHERE session_id = $1', [sessionId]);
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const session = {
            order_id: row.odoo_order_id,
            partner_id: row.odoo_partner_id,
            channel_id: row.channel_id,
            customer_info: {},
            items: [],
            tax_info: null
          };
          this.sessions.set(sessionId, session);
          return session;
        }
      } catch (err) {
        console.error("SessionManager.get Postgres error:", err.message);
        this.pool = null; // Disable future attempts to prevent log bloat
      }
    }

    // 3. Create new if not found
    const newSession = {
      order_id: null,
      partner_id: null,
      customer_info: {},
      items: [],
      tax_info: null
    };
    this.sessions.set(sessionId, newSession);
    return newSession;
  }

  async set(sessionId, data) {
    const session = await this.get(sessionId);
    Object.assign(session, data);

    // Persist to Postgres if pool available
    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO xena_sessions (session_id, odoo_partner_id, odoo_order_id, channel_id, last_interaction)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (session_id) DO UPDATE SET
             odoo_partner_id = EXCLUDED.odoo_partner_id,
             odoo_order_id = EXCLUDED.odoo_order_id,
             channel_id = EXCLUDED.channel_id,
             last_interaction = CURRENT_TIMESTAMP`,
          [sessionId, session.partner_id || null, session.order_id || null, session.channel_id || null]
        );
      } catch (err) {
        console.error("SessionManager.set Postgres error:", err.message);
        this.pool = null; // Disable future attempts to prevent log bloat
      }
    }
  }
}

const sessionManager = new SessionManager();

class CatalogCache {
  constructor(odoo) {
    this.odoo = odoo;
    this.products = [];
    this.lastUpdate = null;
    this.isInitializing = false;
  }

  async refresh() {
    if (this.isInitializing) return;
    this.isInitializing = true;
    console.error(`[${new Date().toISOString()}] Refreshing Catalog Cache...`);
    
    try {
      const fields = buildReadFields("product.product", [
        "display_name",
        "qty_available", "free_qty", "lst_price", "is_kits"
      ]);
      const domain = [
        ["sale_ok", "=", true],
        ["website_published", "=", true]
      ];

      const rawProducts = await this.odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [domain],
        kwargs: { fields, order: "id desc" }
      });

      this.products = rawProducts
        .filter(p => {
          // Filter phantom kits using the native Odoo flag
          if (p.is_kits) return false;
          
          const text = `${p.display_name || ""} ${p.name || ""} ${p.default_code || ""}`.toLowerCase();
          if (text.includes("mayoreo") || text.includes("paquete") || text.includes("pack") || text.includes("kit")) return false;
      if (typeof p.default_code === 'string' && (p.default_code.startsWith('V-ML-') || p.default_code.startsWith('V-AMZ-') || p.default_code.startsWith('KIT-'))) return false;
          return true;
        })
        .map(p => {
        const t = tokenize(p.display_name + " " + p.default_code);
        let volume_ml = t.volume?.[0]?.val_ml || null;
        let volume_cm3 = t.dimensions?.[0]?.volume_cm3 || null;
        
        return {
          ...p,
          base_price: p.lst_price || 0,
          volume_ml,
          volume_cm3,
          category: t.category,
          dimensions: t.dimensions?.[0]?.dims || null
        };
      });

      this.lastUpdate = new Date();
      console.error(`[${new Date().toISOString()}] Catalog Cache updated: ${this.products.length} products.`);
    } catch (err) {
      console.error("Failed to refresh catalog cache:", err);
    } finally {
      this.isInitializing = false;
    }
  }

  getClosestByVolume(targetVolume, category, limit = 2) {
    const isBox = category === 'BOX';
    const filtered = this.products.filter(p => {
      // Must not be a closure
      if (p.category === 'CLOSURE') return false;
      if (isBox) return p.category === 'BOX' && p.volume_cm3;
      return (p.category === 'CONTAINER' || !p.category) && p.volume_ml;
    });

    return filtered
      .map(p => ({
        ...p,
        diff: Math.abs((isBox ? p.volume_cm3 : p.volume_ml) - targetVolume)
      }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, limit);
  }
}

const catalogCache = new CatalogCache(odoo);
// Initialize cache in background
catalogCache.refresh();

async function getDynamicPrice(sessionId, productId, qty = 12) {
  const session = await sessionManager.get(sessionId);
  let orderId = session.order_id;

  // 1. Ensure we have an order to work with
  if (!orderId) {
    orderId = await odoo.executeKw({
      model: "sale.order",
      method: "create",
      args: [{
        partner_id: session.partner_id || 1,
        state: 'draft'
      }]
    });
    await sessionManager.set(sessionId, { order_id: orderId });
  }

  // 2. Check if wholesale pricelist should be applied
  // We do a quick read of the current total
  const order = await odoo.executeKw({
    model: "sale.order",
    method: "read",
    args: [[orderId]],
    kwargs: { fields: ["amount_untaxed", "pricelist_id"] }
  });
  
  // If threshold met and not already on wholesale, update pricelist
  if (order[0].amount_untaxed >= WHOLESALE_THRESHOLD && (!order[0].pricelist_id || !order[0].pricelist_id[1].includes("Mayoristas"))) {
    const plId = await odoo.executeKw({
      model: "product.pricelist",
      method: "search",
      args: [[["name", "ilike", "Lista Mayoristas"]]],
      kwargs: { limit: 1 }
    });
    if (plId?.length) {
      await odoo.executeKw({
        model: "sale.order",
        method: "write",
        args: [[orderId], { pricelist_id: plId[0] }]
      });
    }
  }

  // 3. Add or Update the line
  const existingLines = await odoo.executeKw({
    model: "sale.order.line",
    method: "search_read",
    args: [[["order_id", "=", orderId], ["product_id", "=", productId]]],
    kwargs: { fields: ["id"], limit: 1 }
  });

  let lineId;
  if (existingLines.length > 0) {
    lineId = existingLines[0].id;
    await odoo.executeKw({
      model: "sale.order.line",
      method: "write",
      args: [[lineId], { product_uom_qty: qty }]
    });
  } else {
    lineId = await odoo.executeKw({
      model: "sale.order.line",
      method: "create",
      args: [{
        order_id: orderId,
        product_id: productId,
        product_uom_qty: qty
      }]
    });
  }

  // 4. Read the computed price (Odoo handles pricelist logic here)
  const lines = await odoo.executeKw({
    model: "sale.order.line",
    method: "read",
    args: [[lineId]],
    kwargs: { fields: ["price_unit", "price_subtotal", "price_total", "price_tax", "discount"] }
  });

  return lines?.[0] || null;
}

async function fetchClosuresAndSeals(neckSize, closureType, limit = 2) {
  let closures = [];
  let seals = [];
  
  if (!neckSize) return { closures, seals };

  try {
    const closureTokens = tokenize(`tapa ${neckSize}`);
    const closureDomain = buildDomain(closureTokens, false);
    closureDomain.push(["default_code", "=ilike", "TAPA%"]);

    if (closureType === 'TWIST') {
      closureDomain.push(["name", "ilike", "%TWIST%"]);
    } else {
      closureDomain.push(["name", "not ilike", "%TWIST%"]);
    }
    
    closures = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [closureDomain],
      kwargs: {
        fields: buildReadFields("product.product", ["lst_price", "qty_available"]),
        limit,
        order: "id desc"
      }
    });

    const sealTokens = tokenize(`sello ${neckSize}`);
    const sealDomain = buildDomain(sealTokens, false);
    sealDomain.push(["default_code", "=ilike", "SELLO%"]);
    
    seals = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [sealDomain],
      kwargs: {
        fields: buildReadFields("product.product", ["lst_price", "qty_available"]),
        limit,
        order: "id desc"
      }
    });
    console.error(`[fetchClosuresAndSeals] neckSize: ${neckSize}, found ${closures.length} closures`);
  } catch (err) {
    console.error("Failed to fetch closures/seals:", err);
  }
  
  return { closures, seals };
}

async function performProductSearch(query, filters = {}, limit = 20) {
  const lim = clampLimit(limit, defaultLimit, 200);
  const resolvedFilters = resolveCapacityOverride(query, filters);
  const frequentHit = findFrequentHit(query, resolvedFilters);

  if (frequentHit) {
    const mapSearchProduct = (p) => {
      const inStock = (p.free_qty ?? p.qty_available) > 0;
      const etaDays = p.x_studio_das_para_fabricar || p.sale_delay || 0;
      return {
        id: p.id,
        default_code: p.default_code,
        name: p.name,
        display_name: p.display_name || p.name,
        base_price: p.lst_price || 0,
        website_url: resolveCommerceUrl(p, "product.product"),
        in_stock: inStock,
        eta_days: inStock ? 0 : etaDays,
        lead_time_msg: inStock ? "Entrega inmediata" : `Sobre pedido (Disponible en ${etaDays} dias)`,
        qty_available: p.qty_available,
        free_qty: p.free_qty ?? null,
        neck_size: extractNeckSize(p.name) || extractNeckSize(p.default_code),
        publication_url: p.x_studio_url_publicacin || null
      };
    };

    let hydratedBestMatch = null;
    try {
      const canonicalProducts = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["default_code", "=", frequentHit.default_code]]],
        kwargs: {
          fields: buildReadFields("product.product", [
            "display_name",
            "qty_available", "free_qty", "x_studio_url_publicacin",
            "sale_delay", "x_studio_das_para_fabricar", "lst_price"
          ]),
          limit: 1
        }
      });
      if (canonicalProducts?.length) {
        hydratedBestMatch = mapSearchProduct(canonicalProducts[0]);
      }
    } catch (err) {
      console.error("Failed to hydrate canonical frequent-hit product:", err);
    }

    const best_match = {
      ...(hydratedBestMatch || frequentHit),
      best_match: true
    };
    
    const results = { products: [best_match], suggestions: [], best_match, bundles_only: false, frequent: true };

    // If there's a marketplace SKU, fetch its details and append it
    // to keep canonical best_match at products[0].
    if (frequentHit.marketplace_sku) {
      try {
        const mlProducts = await odoo.executeKw({
          model: "product.product",
          method: "search_read",
          args: [[["default_code", "=", frequentHit.marketplace_sku]]],
          kwargs: { 
            fields: buildReadFields("product.product", [
              "display_name", "qty_available", "x_studio_url_publicacin", "lst_price"
            ]),
            limit: 1 
          }
        });

        if (mlProducts?.length) {
          const ml = mlProducts[0];
          const mappedMl = { ...mapSearchProduct(ml), marketplace: true };
          results.products.push(mappedMl);
        }
      } catch (err) {
        console.error("Failed to fetch marketplace variant for frequent hit:", err);
      }
    }

    // Auto-inject closures for the best match (frequent hit)
    const p = results.best_match;
    p.neck_size = extractNeckSize(p.name) || extractNeckSize(p.default_code);
    if (p.neck_size && !p.name.toUpperCase().includes('TAPA') && !p.name.toUpperCase().includes('SELLO')) {
      const closureType = extractClosureType(p.name);
      const { closures, seals } = await fetchClosuresAndSeals(p.neck_size, closureType, 3);
      if (closures.length) p.compatible_closures = closures.map(c => ({ sku: c.default_code, name: c.name, price: c.lst_price, url: resolveCommerceUrl(c, "product.product") }));
      if (seals.length) p.compatible_seals = seals.map(s => ({ sku: s.default_code, name: s.name, price: s.lst_price, url: resolveCommerceUrl(s, "product.product") }));
    }

    return results;
  }
  
  const extraParts = [];
  if (resolvedFilters.material) extraParts.push(resolvedFilters.material);
  if (resolvedFilters.color) extraParts.push(resolvedFilters.color);
  if (resolvedFilters.closure_type) extraParts.push(resolvedFilters.closure_type);
  if (resolvedFilters.neck_finish) extraParts.push(resolvedFilters.neck_finish);
  
  const combined = [query || "", ...extraParts].join(" ");
  const tokens = tokenize(combined);

  const fields = buildReadFields("product.product", [
    "display_name",
    "qty_available", "free_qty", "x_studio_url_publicacin",
    "sale_delay", "x_studio_das_para_fabricar", "lst_price", "is_kits"
  ]);
  
  const phase1Domain = buildDomain(tokens, true);
  if (resolvedFilters.type && ["product", "consu", "service"].includes(resolvedFilters.type)) {
    phase1Domain.push(["detailed_type", "=", resolvedFilters.type]);
  }

  let products = await odoo.executeKw({
    model: "product.product",
    method: "search_read",
    args: [phase1Domain],
    kwargs: { fields, limit: lim, order: "id desc" },
  });

  if (products.length === 0 && tokens.keywords && tokens.keywords.length > 0) {
    const phase2Domain = buildDomain(tokens, false);
    if (resolvedFilters.type && ["product", "consu", "service"].includes(resolvedFilters.type)) {
      phase2Domain.push(["detailed_type", "=", resolvedFilters.type]);
    }
    
    products = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [phase2Domain],
      kwargs: { fields, limit: lim, order: "id desc" },
    });
  }

  const mappedProducts = products
    .filter(p => {
      // Filter phantom kits using the native Odoo flag
      if (p.is_kits) return false;
      
      // 0-latency kit filtering
      const text = `${p.display_name || ""} ${p.name || ""} ${p.default_code || ""}`.toLowerCase();
      if (text.includes("mayoreo") || text.includes("paquete") || text.includes("pack") || text.includes("kit")) return false;
      if (p.default_code?.startsWith('V-ML-') || p.default_code?.startsWith('V-AMZ-') || p.default_code?.startsWith('KIT-')) return false;
      return true;
    })
    .map(p => {
    const inStock = (p.free_qty ?? p.qty_available) > 0;
    const etaDays = p.x_studio_das_para_fabricar || p.sale_delay || 0;
    
    return {
      id: p.id,
      default_code: p.default_code,
      name: p.name,
      display_name: p.display_name,
      base_price: p.lst_price || 0,
      website_url: resolveCommerceUrl(p, "product.product"),
      in_stock: inStock,
      eta_days: inStock ? 0 : etaDays,
      lead_time_msg: inStock ? "Entrega inmediata" : `Sobre pedido (Disponible en ${etaDays} días)`,
      qty_available: p.qty_available,
      free_qty: p.free_qty ?? null,
      neck_size: extractNeckSize(p.name) || extractNeckSize(p.default_code),
      publication_url: p.x_studio_url_publicacin || null
    };
  }).slice(0, lim);

  // Auto-inject closures for containers to save LLM round-trips
  await Promise.all(mappedProducts.map(async (p) => {
    if (p.neck_size && !p.name.toUpperCase().includes('TAPA') && !p.name.toUpperCase().includes('SELLO')) {
      const closureType = extractClosureType(p.name);
      const { closures, seals } = await fetchClosuresAndSeals(p.neck_size, closureType, 3);
      if (closures.length) p.compatible_closures = closures.map(c => ({ sku: c.default_code, name: c.name, price: c.lst_price, url: resolveCommerceUrl(c, "product.product") }));
      if (seals.length) p.compatible_seals = seals.map(s => ({ sku: s.default_code, name: s.name, price: s.lst_price, url: resolveCommerceUrl(s, "product.product") }));
    }
  }));

  let suggestions = [];
  if (mappedProducts.length < 3) {
    const targetVolMl = tokens.volume?.[0]?.val_ml;
    const targetVolCm3 = tokens.dimensions?.[0]?.volume_cm3;
    
    if (targetVolMl) {
      suggestions = catalogCache.getClosestByVolume(targetVolMl, 'CONTAINER');
    } else if (targetVolCm3) {
      suggestions = catalogCache.getClosestByVolume(targetVolCm3, 'BOX');
    }
    
    // Clean up suggestions
    suggestions = suggestions
      .filter(s => !mappedProducts.find(p => p.id === s.id))
      .map(s => ({
        ...s,
        suggestion_reason: `Closest volume matching your request (${targetVolMl ? targetVolMl+'ml' : targetVolCm3+'cm3'})`
      }));
  }

  const bundles_only = computeBundlesOnly(mappedProducts);
  const best_match = pickBestMatch(mappedProducts, suggestions);

  return { products: mappedProducts, suggestions, bundles_only, best_match };
}

// ---------------------------------------------------------------------------
// 2. MCP TOOLS DEFINITION
// ---------------------------------------------------------------------------

export { tokenize, buildDomain, fetchClosuresAndSeals, performProductSearch };

function createMcpServer() {
  const server = new McpServer({
    name: "odoo-n8n-mcp",
    version: "2.0.0",
  });

server.tool("odoo_ping", {}, async () => {
  const uid = await odoo.ensureAuth();
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, uid, baseUrl: odoo.baseUrl, db: odoo.db, username: odoo.username, wholesale_threshold: WHOLESALE_THRESHOLD, last_catalog_update: catalogCache.lastUpdate }, null, 2) }],
  };
});

server.tool("xena_refresh_catalog", {}, async () => {
  await catalogCache.refresh();
  return {
    content: [{ type: "text", text: JSON.stringify({ success: true, last_update: catalogCache.lastUpdate, total_products: catalogCache.products.length }, null, 2) }],
  };
});

server.tool(
  "xena_search_products",
  {
    query: z.string().optional().describe("Text search for containers (bottles, jars), cardboard boxes, or closures. CONTAINERS: Use noun + shape (e.g. 'Frasco hexagonal', 'Botella boston'). BOXES: Use dimensions (e.g. 'Caja 40x30x20') - system auto-calculates volume and finds closest matches. CLOSURES: Use 'Tapa' + neck size (e.g. 'Tapa R24'). See RAG_Instructions.md section 'Descubrimiento de Productos' for detailed search strategies."),
    filters: z.object({
      type: z.string().optional(),
      material: z.string().optional(),
      capacity_ml: z.union([z.string(), z.number()]).optional(),
      neck_finish: z.string().optional(),
      closure_type: z.string().optional(),
      color: z.string().optional(),
    }).partial().optional().describe("Filters for material, capacity, etc. Do NOT use color/material in first broad search. See RAG for filter usage patterns."),
    limit: z.number().int().positive().max(200).optional(),
  },
  async ({ query, filters, limit }) => {
    const start = Date.now();
    console.error(`[Tool:xena_search_products] Start. Query: "${query}"`);
    try {
      const { products, suggestions, bundles_only, best_match, frequent } = await performProductSearch(query, filters, limit);
      const warnings = [];
      if (products.length === 0) {
        if (suggestions.length > 0) {
          warnings.push("No exact matches found. Showing closest alternatives by volume.");
        } else {
          warnings.push("No results found. Try a broader search.");
        }
      }
      if (bundles_only) {
        warnings.push("Solo se encontraron paquetes/bundles para esta búsqueda.");
      }

      console.error(`[Tool:xena_search_products] End. Duration: ${Date.now() - start}ms. Found: ${products.length}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ 
          products, 
          suggestions,
          bundles_only,
          best_match,
          frequent_hit: !!frequent,
          warnings
        }, null, 2) }]
      };
    } catch (err) {
      console.error(`[Tool:xena_search_products] Error after ${Date.now() - start}ms:`, err);
      throw err;
    }
  }
);

server.tool(
  "xena_search_products_safe",
  {
    query: z.string().min(1).describe("Search term (name or SKU)"),
    limit: z.number().optional().default(5),
  },
  async ({ query, limit }) => {
    const { products, suggestions, bundles_only, best_match, frequent } = await performProductSearch(query, {}, limit);
    return {
      content: [{ type: "text", text: JSON.stringify({ products, suggestions, bundles_only, best_match, frequent_hit: !!frequent }, null, 2) }]
    };
  }
);

server.tool(
  "xena_get_product_price",
  {
    sku: z.string().describe("Product SKU (default_code)"),
    qty: z.number().default(12),
    session_id: z.string().describe("Active session ID to reuse quote. IMPORTANT: Pricing is session-aware and cumulative. System automatically applies wholesale pricing (Lista Mayoristas) when order total >= $2000 MXN. See RAG_Instructions.md section 'Cotización y Cumplimiento' for pricing rules."),
  },
  async ({ sku, qty, session_id }) => {
    const start = Date.now();
    console.error(`[Tool:xena_get_product_price] Start. SKU: ${sku}, Qty: ${qty}`);
    try {
      const products = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["default_code", "=", sku]]],
        kwargs: { fields: ["id", "name", "qty_available"], limit: 1 }
      });

      if (!products?.length) {
        console.error(`[Tool:xena_get_product_price] Product not found: ${sku}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: "Product not found" }) }] };
      }

      const product = products[0];
      
      let finalQty = qty;
      let stock_warning = null;
      let available_stock = product.qty_available || 0;

      if (available_stock < qty) {
        finalQty = Math.max(0, available_stock);
        let msg = finalQty === 0 
          ? `Out of stock. Requested ${qty}, but 0 available.` 
          : `Requested ${qty} pieces, but only ${finalQty} available in stock.`;
        stock_warning = msg;
        console.error(`[Tool:xena_get_product_price] Stock warning: ${msg}`);
      }

      let pricing = null;
      if (finalQty > 0) {
        pricing = await getDynamicPrice(session_id, product.id, finalQty);
      }

      if (finalQty > 0 && !pricing) {
        console.error(`[Tool:xena_get_product_price] Failed to compute price for ${sku}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: "Failed to compute price in Odoo" }) }] };
      }
      
      console.error(`[Tool:xena_get_product_price] End. Duration: ${Date.now() - start}ms`);
      return {
        content: [{ type: "text", text: JSON.stringify({
          product_id: product.id,
          sku, 
          requested_qty: qty,
          quoted_qty: finalQty,
          available_stock,
          stock_warning,
          unit_price: pricing ? pricing.price_unit : null,
          unit_price_with_tax: pricing ? pricing.price_total / finalQty : null,
          total_price: pricing ? pricing.price_total : 0, 
          total_price_tax_excl: pricing ? pricing.price_subtotal : 0,
          tax_amount: pricing ? pricing.price_tax : 0,
          discount: pricing ? pricing.discount : 0,
          currency: "MXN",
          note: pricing ? (pricing.price_subtotal >= WHOLESALE_THRESHOLD ? "Por el monto superior a $2000, éste pedido aplica precio de mayoreo." : "Retail pricing applied.") : "No price computed due to out of stock."
        }, null, 2) }],
      };
    } catch (err) {
      console.error(`[Tool:xena_get_product_price] Error after ${Date.now() - start}ms:`, err);
      throw err;
    }
  }
);

server.tool(
  "xena_find_or_create_customer",
  {
    name: z.string(),
    phone: z.string().optional(),
    email: z.string().nullable().optional(),
    street: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    zip: z.string().nullable().optional().describe("ZIP code (Código Postal). IMPORTANT: System auto-fills city, state, and country from CP database (mexico_cps.json). Only city/street are required if CP is provided. See RAG_Instructions.md section 'Identificación y Toma de Datos'."),
    external_id: z.string().optional().describe("Respond.io Contact ID (e.g. respondio:contact:123)"),
    session_id: z.string().describe("Active session ID to link customer"),
  },
  async ({ name, phone, email, street, city, zip, external_id, session_id }) => {
    const start = Date.now();
    console.error(`[Tool:xena_find_or_create_customer] Start. Name: ${name}, Email: ${email}`);
    try {
      // Clean inputs
      const cleanEmail = email === null ? undefined : email;
      const cleanStreet = street === null ? undefined : street;
      const cleanCity = city === null ? undefined : city;
      const cleanZip = zip === null ? undefined : zip;

      // 1. Search for existing partner by external_id (strongest match)
      let existing = [];
      if (external_id) {
        existing = await odoo.executeKw({
          model: "res.partner",
          method: "search_read",
          args: [[["ref", "=", external_id]]],
          kwargs: { fields: ["id", "email", "zip", "name", "ref", "credit_limit", "use_partner_credit_limit", "property_payment_term_id"], limit: 1 }
        });
      }

      // 2. Search for existing partner by email
      if (!existing?.length && cleanEmail) {
        let domain = [["email", "ilike", cleanEmail]];
        existing = await odoo.executeKw({
          model: "res.partner",
          method: "search_read",
          args: [domain],
          kwargs: { fields: ["id", "email", "zip", "name", "ref", "street", "city", "state_id", "country_id", "credit_limit", "use_partner_credit_limit", "property_payment_term_id"], limit: 1 }
        });
      }

      // 3. If not found by email, try phone
      if (!existing?.length && phone) {
        let domain = [["phone", "ilike", phone]];
        existing = await odoo.executeKw({
          model: "res.partner",
          method: "search_read",
          args: [domain],
          kwargs: { fields: ["id", "email", "zip", "name", "ref", "street", "city", "state_id", "country_id", "credit_limit", "use_partner_credit_limit", "property_payment_term_id"], limit: 1 }
        });
      }

      const values = { name, email: cleanEmail, phone, street: cleanStreet, city: cleanCity, zip: String(cleanZip || "") };
      
      // Auto-fill address data from CP database if missing
      if (cleanZip) {
        const cpInfo = getCpInfo(cleanZip);
        if (cpInfo) {
          if (!cleanCity) values.city = cpInfo.municipality;
          
          // Resolve state_id from Odoo if state_code is available
          if (cpInfo.state_code) {
            try {
              const states = await odoo.executeKw({
                model: "res.country.state",
                method: "search",
                args: [[["code", "=", cpInfo.state_code], ["country_id.code", "=", "MX"]]],
                kwargs: { limit: 1 }
              });
              if (states?.length) {
                values.state_id = states[0];
                // Also ensure country is set to Mexico
                const countries = await odoo.executeKw({
                  model: "res.country",
                  method: "search",
                  args: [[["code", "=", "MX"]]],
                  kwargs: { limit: 1 }
                });
                if (countries?.length) values.country_id = countries[0];
              }
            } catch (err) {
              console.error("Failed to resolve state_id:", err);
            }
          }
        }
      }

      if (external_id) values.ref = external_id;

      let id;
      let action;
      let warning = null;

      if (existing?.length) {
        const partner = existing[0];
        id = partner.id;

        // Verification Logic: Email match + CP check
        if (email && partner.email && email.toLowerCase() === partner.email.toLowerCase()) {
          if (zip && partner.zip && String(zip) !== String(partner.zip)) {
            // CP Mismatch: Escalate/Warn
            action = "mismatch_detected";
            warning = `Customer with email ${email} exists, but ZIP code ${zip} does not match record (${partner.zip}). Escalate to human for verification.`;
          } else {
            // Perfect match or no CP to compare: Use as-is
            action = "existing_verified";
            // Update ref if missing
            if (external_id && !partner.ref) {
              await odoo.executeKw({ model: "res.partner", method: "write", args: [[id], { ref: external_id }] });
            }
          }
        } else {
          // Phone match or partial match: Update record
          action = "updated";
          await odoo.executeKw({ model: "res.partner", method: "write", args: [[id], values] });
        }
        
        // Ensure session has the most up-to-date address from Odoo
        await sessionManager.set(session_id, { 
          partner_id: id, 
          customer_info: { 
            email: partner.email || email, 
            zip: String(partner.zip || zip || ""), 
            street: partner.street || street || values.street, 
            city: partner.city || city || values.city,
            state_id: partner.state_id?.[0] || values.state_id,
            country_id: partner.country_id?.[0] || values.country_id
          } 
        });
      } else {
        // Create new
        id = await odoo.executeKw({ model: "res.partner", method: "create", args: [values] });
        action = "created";
        
        // Link to session
        await sessionManager.set(session_id, { 
          partner_id: id, 
          customer_info: { 
            email, 
            zip: String(zip || ""), 
            street, 
            city: values.city,
            state_id: values.state_id,
            country_id: values.country_id
          } 
        });
      }

      // If session has an order, update its partner
      const session = await sessionManager.get(session_id);
      if (session.order_id) {
        await odoo.executeKw({
          model: "sale.order",
          method: "write",
          args: [[session.order_id], { partner_id: id }]
        });
      }

      // Map credit safety fields
      const partnerData = existing?.length ? existing[0] : null;
      let has_approved_credit = false;
      let payment_terms = null;
      if (partnerData) {
        has_approved_credit = !!(partnerData.use_partner_credit_limit && partnerData.credit_limit > 0);
        payment_terms = partnerData.property_payment_term_id ? partnerData.property_payment_term_id[1] : null;
      }

      console.error(`[Tool:xena_find_or_create_customer] End. Duration: ${Date.now() - start}ms. Action: ${action}`);
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            partner_id: id, 
            action, 
            warning,
            has_approved_credit,
            payment_terms,
            values: action === "created" || action === "updated" ? values : { name: partnerData?.name, email: partnerData?.email, zip: partnerData?.zip }
          }, null, 2) 
        }] 
      };
    } catch (err) {
      console.error(`[Tool:xena_find_or_create_customer] Error after ${Date.now() - start}ms:`, err);
      throw err;
    }
  }
);

server.tool(
  "xena_process_tax_data",
  {
    session_id: z.string().describe("Active session ID"),
    tax_data: z.object({
      RFC: z.string(),
      NombreCompleto: z.string(),
      DireccionCompleta: z.string(),
      Regimen: z.string(),
      CodigoPostal: z.string().optional(),
    }).describe("Extracted Tax Data from CSF"),
  },
  async ({ session_id, tax_data }) => {
    const session = await sessionManager.get(session_id);
    const partner_id = session.partner_id;

    if (!partner_id) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Customer info missing. Call xena_find_or_create_customer first." }) }] };
    }

    const values = {
      vat: tax_data.RFC,
      l10n_mx_edi_fiscal_regime: tax_data.Regimen,
      // Ensure the legal name from CSF is stored in the partner name if it differs significantly
      name: tax_data.NombreCompleto,
      // Auto-fill address data from CP if available
      zip: tax_data.CodigoPostal || undefined,
      // Store full details in a comment/internal note to ensure zero data loss
      comment: `[DATOS FISCALES - CSF]\nRFC: ${tax_data.RFC}\nNombre: ${tax_data.NombreCompleto}\nRegimen: ${tax_data.Regimen}\nDirección: ${tax_data.DireccionCompleta}`
    };

    if (tax_data.CodigoPostal) {
      const cpInfo = getCpInfo(tax_data.CodigoPostal);
      if (cpInfo) {
        values.city = cpInfo.municipality;
        if (cpInfo.state_code) {
          try {
            const states = await odoo.executeKw({
              model: "res.country.state",
              method: "search",
              args: [[["code", "=", cpInfo.state_code], ["country_id.code", "=", "MX"]]],
              kwargs: { limit: 1 }
            });
            if (states?.length) values.state_id = states[0];
          } catch (e) { console.error("CSF State resolution failed", e); }
        }
      }
    }

    try {
      await odoo.executeKw({
        model: "res.partner",
        method: "write",
        args: [[partner_id], values]
      });
      
      await sessionManager.set(session_id, { tax_info: tax_data });

      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            message: "Tax invoicing data has been successfully linked to the customer record.",
            tax_record: tax_data 
          }, null, 2) 
        }] 
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update tax data: ${err.message}` }) }] };
    }
  }
);
 
server.tool(
  "xena_create_quotation",
  {
    session_id: z.string().describe("Active session ID to finalize quote"),
    items: z.array(z.object({ sku: z.string(), qty: z.number().positive() })),
    is_pickup: z.boolean().optional().default(false).describe("If true, no shipping cost is added. Requires order > $500 MXN."),
    note: z.string().optional().describe("Note to add to the quotation terms."),
  },
  async ({ session_id, items, is_pickup, note }) => {
    const session = await sessionManager.get(session_id);
    const partner_id = session.partner_id;

    if (!partner_id) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Customer info missing. Call xena_find_or_create_customer first." }) }] };
    }

    // 1. Verify Partner
    const partners = await odoo.executeKw({
      model: "res.partner",
      method: "read",
      args: [[partner_id]],
      kwargs: { fields: ["id", "name", "street", "zip", "city", "state_id", "country_id"] }
    });
    const partner = partners?.[0];
    if (!partner) throw new Error("Customer (partner_id) not found");

    // 2. Validate Address for non-pickup
    // We only require ZIP for shipping calculation at quote creation stage. Full address is collected post-payment.
    const street = partner.street || session.customer_info?.street;
    const zip = partner.zip || session.customer_info?.zip;
    const city = partner.city || session.customer_info?.city;
    const state_id = partner.state_id?.[0] || session.customer_info?.state_id;
    const country_id = partner.country_id?.[0] || session.customer_info?.country_id;
    
    if (!is_pickup && (!zip)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Valid shipping ZIP code required for delivery quotation." }) }] };
    }

    const cleanZip = String(zip || "").trim();
    if (!is_pickup && (cleanZip === "false" || !cleanZip)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Valid shipping ZIP code required for delivery quotation." }) }] };
    }

    // 3. Resolve Products and Calculate Subtotal & Shipping
    const skus = items.map(i => i.sku);
    const products = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [[["default_code", "in", skus]]],
      kwargs: { fields: ["id", "default_code", "name", "display_name", "qty_available"] }
    });

    const skuMap = new Map(products.map(p => [p.default_code, p]));
    let subtotal = 0;
    const stockWarnings = [];
    
    // Shipping calculation variables
    let containerBoxFractionSum = 0;
    let largeAccessoryQty = 0;
    let hasSmallAccessoriesOnly = true;

    const orderLines = items.map(item => {
      const p = skuMap.get(item.sku);
      if (!p) throw new Error(`SKU ${item.sku} not found`);
      
      // Stock Check
      if (p.qty_available < item.qty) {
        stockWarnings.push({
          sku: item.sku,
          requested: item.qty,
          available: p.qty_available,
          message: `Pediste ${item.qty} pero solo tenemos ${p.qty_available} en almacen, las agrego a tu cotizacion o prefieres seleccionar otro producto?`
        });
        // item.qty = Math.max(0, p.qty_available); // REMOVED: Do not override quantity, let Odoo handle it or user decide
      }

      if (item.qty <= 0) return null;

      // --- Shipping Logic ---
      const tokens = tokenize(p.display_name + " " + p.default_code);
      const vol = tokens.volume?.[0]?.val_ml || 0;
      const isContainer = tokens.category === 'CONTAINER' || CATEGORIES.CONTAINER.some(prefix => p.default_code.startsWith(prefix));
      const isLargeAccessory = ['atomizador', 'spray', 'trigger', 'rociador', 'valvula'].some(k => p.display_name.toLowerCase().includes(k));
      const isSmallAccessory = ['tapa', 'sello', 'liner'].some(k => p.display_name.toLowerCase().includes(k));

      if (isContainer && vol > 0) {
        hasSmallAccessoriesOnly = false;
        // Find capacity rule (smallest capacity that is >= product volume)
        const rule = [...SHIPPING_CAPACITY].reverse().find(r => r.ml >= vol) || SHIPPING_CAPACITY[0];
        containerBoxFractionSum += item.qty / rule.per_box;
      } else if (isLargeAccessory) {
        hasSmallAccessoriesOnly = false;
        largeAccessoryQty += item.qty;
      } else if (!isSmallAccessory) {
        // Default to container if unknown but has volume, or just ignore if small
        if (vol > 0) {
          hasSmallAccessoriesOnly = false;
          const rule = [...SHIPPING_CAPACITY].reverse().find(r => r.ml >= vol) || SHIPPING_CAPACITY[0];
          containerBoxFractionSum += item.qty / rule.per_box;
        }
      }

      return [0, 0, { product_id: p.id, product_uom_qty: item.qty }];
    }).filter(l => l !== null);

    if (orderLines.length === 0 && items.length > 0) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "None of the requested items have available stock.", stock_details: stockWarnings }) }] };
    }

    // Calculate total boxes
    let totalBoxes = Math.ceil(containerBoxFractionSum) + Math.ceil(largeAccessoryQty / LARGE_ACCESSORY_PER_BOX);
    
    // If only small accessories or everything resulted in 0 boxes but we have items, at least 1 box
    if (totalBoxes === 0 && orderLines.length > 0) {
      totalBoxes = 1;
    }

    // 4. Pickup Rule: Minimum $500 MXN
    if (is_pickup && subtotal < 500) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Order must be at least $500 MXN for pickup (Recolección)." }) }] };
    }

    // 5. Add Shipping if not pickup
    let shippingId = 54259; // Default fallback (EXP-ENVIO)
    if (!is_pickup) {
      const shippingProd = await odoo.executeKw({
        model: "product.product",
        method: "search",
        args: [[["default_code", "=", "EXP-ENVIO"]]],
        kwargs: { limit: 1 }
      });
      if (shippingProd?.length) shippingId = shippingProd[0];
      
      const cpInfo = getCpInfo(cleanZip);
      const costPerBox = cpInfo ? cpInfo.shipping_cost : SHIPPING_COST_METROPOLI;
      const category = cpInfo ? cpInfo.category : "Local/Nacional";

      orderLines.push([0, 0, { 
        product_id: shippingId, 
        product_uom_qty: totalBoxes, 
        price_unit: costPerBox,
        name: `Envío ${category} (${totalBoxes} caja${totalBoxes > 1 ? 's' : ''})` 
      }]);
    }

    // 6. Update or Create Sale Order
    let orderId = session.order_id;
    const orderData = { 
      partner_id, 
      order_line: orderLines,
      state: 'draft',
      // Address will be inherited automatically from the partner in Odoo
      partner_shipping_id: partner_id,
      partner_invoice_id: partner_id,
      note: note || undefined,

      // Default delivery method logic (if Odoo has delivery module)
      // We set a placeholder or let Odoo's onchange handle it
    };

    // If the ghost field x_studio_metodo_de_entrega is causing issues, 
    // we can try to explicitly set it to a valid value or null if we knew its type.
    // However, since it's "Invalid", the best fix is Odoo-side cleanup.
    // As a workaround, we ensure we don't send any extra fields.
    
    // Workaround: If we suspect Odoo is trying to write to a field that doesn't exist,
    // we try to keep the payload as minimal as possible.
    const minimalOrderData = { ...orderData };
    // remove fields that might trigger complex onchanges if not needed
    // but we need the address fields for shipping calculation in Odoo.

    // Apply Wholesale Pricelist if threshold met
    if (subtotal >= WHOLESALE_THRESHOLD) {
      const plId = await odoo.executeKw({
        model: "product.pricelist",
        method: "search",
        args: [[["name", "ilike", "Lista Mayoristas"]]],
        kwargs: { limit: 1 }
      });
      if (plId?.length) {
        orderData.pricelist_id = plId[0];
      }
    }

    if (orderId) {
      // Clear existing lines and replace with final items
      await odoo.executeKw({
        model: "sale.order",
        method: "write",
        args: [[orderId], { 
          partner_id: orderData.partner_id,
          pricelist_id: orderData.pricelist_id || undefined,
          order_line: [[5, 0, 0], ...orderLines] 
        }]
      });
    } else {
      orderId = await odoo.executeKw({
        model: "sale.order",
        method: "create",
        args: [orderData]
      });
      await sessionManager.set(session_id, { order_id: orderId });
    }

    // 7. Ensure Access Token and return details
    const order = await odoo.executeKw({
      model: "sale.order",
      method: "read",
      args: [[orderId]],
      kwargs: { fields: ["id", "name", "amount_total", "access_token", "pricelist_id"] }
    });

    const o = order[0];
    if (!o.access_token) {
      o.access_token = crypto.randomUUID();
      await odoo.executeKw({ model: "sale.order", method: "write", args: [[o.id], { access_token: o.access_token }] });
    }

    const portalUrl = `${odoo.baseUrl}/my/orders/${o.id}?access_token=${o.access_token}`;
    const paymentLink = `${odoo.baseUrl}/payment/pay?amount=${o.amount_total}&access_token=${o.access_token}&sale_order_id=${o.id}`;

    return { content: [{ type: "text", text: JSON.stringify({ 
      id: o.id,
      name: o.name,
      amount_total: o.amount_total,
      portal_url: portalUrl,
      payment_link: paymentLink,
      stock_warnings: stockWarnings.length > 0 ? stockWarnings : undefined,
      note: subtotal >= WHOLESALE_THRESHOLD ? "Por el monto superior a $2000, éste pedido se vende a precio de mayoreo." : "Retail pricing applied."
    }, null, 2) }] };
  }
);

server.tool(
  "xena_get_product_details",
  { 
    sku: z.string().describe("Product SKU (default_code)"),
    session_id: z.string().optional().describe("Active session ID to get estimated pricing (sample 12-item pricing). IMPORTANT: This tool auto-discovers bundles/kits containing this product and compatible closures/seals based on neck size. See RAG_Instructions.md section 'Descubrimiento de Productos'.")
  },
  async ({ sku, session_id }) => {
    // We use search_read to get the product object by default_code
    const products = await odoo.executeKw({
      model: "product.product",
      method: "search_read",
      args: [[["default_code", "=", sku.trim()]]],
      kwargs: {
        fields: buildReadFields("product.product", [
          "display_name", "description_sale",
          "qty_available", "x_studio_url_publicacin", "lst_price"
        ]),
        limit: 1
      },
    });
    
    if (!products || products.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify(null) }] };
    }

    const p = products[0];
    const formattedUrl = resolveCommerceUrl(p, "product.product");
    const productData = {
      id: p.id,
      default_code: p.default_code,
      name: p.name,
      display_name: p.display_name,
      description_sale: p.description_sale,
      base_price: p.lst_price || 0,
      lst_price: p.lst_price || 0,
      in_stock: p.qty_available > 0,
      ecommerce_url: formattedUrl,
      publication_url: p.x_studio_url_publicacin || null
    };
    
    // 1. Find Bundles (Kits) that contain this product
    const boms = await odoo.executeKw({
      model: "mrp.bom",
      method: "search_read",
      args: [[["bom_line_ids.product_id", "=", p.id], ["type", "=", "phantom"]]],
      kwargs: { fields: ["id", "product_tmpl_id"], limit: 10 }
    });

    const kitProductTemplateIds = boms.map(b => b.product_tmpl_id[0]);
    let bundles = [];
    if (kitProductTemplateIds.length > 0) {
      bundles = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["product_tmpl_id", "in", kitProductTemplateIds], ["website_published", "=", true]]],
        kwargs: { fields: buildReadFields("product.product", ["x_studio_url_publicacin"]) }
      });
      bundles.forEach(b => {
        b.publication_url = b.x_studio_url_publicacin || null;
        b.ecommerce_url = resolveCommerceUrl(b, "product.product");
      });
    }

    // 2. Find Compatible Closures (TAPA) if this is a container
    let closures = [];
    const neckSize = extractNeckSize(p.name) || extractNeckSize(p.default_code);
    const closureType = extractClosureType(p.name);
    if (neckSize) {
      const closureTokens = tokenize(`tapa ${neckSize}`);
      const closureDomain = buildDomain(closureTokens, false);
      closureDomain.push(["default_code", "=ilike", "TAPA%"]);

      // Filter by closure system to avoid suggesting incompatible caps:
      // TWIST containers must only get twist-off caps (no /400 rosca thread)
      // ROSCA/FALDON containers must only get threaded caps (no twist-off)
      if (closureType === 'TWIST') {
        closureDomain.push(["name", "not ilike", "%/400%"]);
      } else {
        // ROSCA or FALDON — exclude twist-off specific caps
        closureDomain.push(["name", "not ilike", "%twist%"]);
      }
      
      closures = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [closureDomain],
        kwargs: {
          fields: buildReadFields("product.product", ["lst_price", "qty_available"]),
          limit: 5,
          order: "id desc"
        }
      });

      // 2b. Find Compatible Seals (SELLO)
      const sealTokens = tokenize(`sello ${neckSize}`);
      const sealDomain = buildDomain(sealTokens, false);
      sealDomain.push(["default_code", "=ilike", "SELLO%"]);
      
      const seals = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [sealDomain],
        kwargs: {
          fields: buildReadFields("product.product", ["lst_price", "qty_available"]),
          limit: 5,
          order: "id desc"
        }
      });
      
      if (seals?.length) {
        p.suggested_seals = seals.map(s => ({
          sku: s.default_code,
          name: s.name,
          ecommerce_url: resolveCommerceUrl(s, "product.product"),
          lst_price: s.lst_price || null,
          in_stock: s.qty_available > 0
        }));
      }
    }

    // 3. Dynamic Pricing if session provided
    let sessionPrice = null;
    if (session_id) {
      const pricing = await getDynamicPrice(session_id, p.id, 12);
      if (pricing) {
        sessionPrice = {
          unit_price: pricing.price_unit,
          qty: 12,
          total: pricing.price_subtotal,
          discount: pricing.discount,
          note: pricing.price_subtotal >= WHOLESALE_THRESHOLD ? "Precio de mayoreo aplicado (> $2000)." : "Precio retail aplicado."
        };
      }
    }

    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify({ 
          ...productData, 
          neck_size: neckSize,
          closure_type: closureType,
          session_pricing: sessionPrice,
          bundles: bundles.map(b => ({
            sku: b.default_code,
            name: b.name,
            marketplace_url: b.publication_url,
            ecommerce_url: b.ecommerce_url
          })),
          suggested_closures: closures.map(c => ({
            sku: c.default_code,
            name: c.name,
            ecommerce_url: resolveCommerceUrl(c, "product.product"),
            lst_price: c.lst_price || null,
            in_stock: c.qty_available > 0
          })),
          suggested_seals: p.suggested_seals || []
        }, null, 2) 
      }] 
    };
  }
);

// --- 2.7 ORDER STATUS ---
server.tool(
  "xena_get_order_status",
  {
    order_reference: z.string().optional().describe("Order reference (e.g. S000123)"),
    order_id: z.number().int().positive().optional(),
    session_id: z.string().optional().describe("If provided, reads back the active session quote"),
  },
  async ({ order_reference, order_id, session_id }) => {
    let soId = order_id;
    
    if (session_id) {
      const session = await sessionManager.get(session_id);
      if (session.order_id) soId = session.order_id;
    }

    let so = null;
    const fields = ["id", "name", "state", "partner_id", "amount_total", "amount_untaxed", "amount_tax", "date_order", "delivery_status", "picking_ids", "access_token", "order_line"];

    if (soId) {
        const rows = await odoo.executeKw({
            model: "sale.order",
            method: "read",
            args: [[soId]],
            kwargs: { fields }
        });
        so = rows?.[0] || null;
    } else if (order_reference && order_reference.trim()) {
        const rows = await odoo.executeKw({
            model: "sale.order",
            method: "search_read",
            args: [[["name", "ilike", order_reference]]],
            kwargs: { fields, limit: 1 }
        });
        so = rows?.[0] || null;
    }

    if (!so) return { content: [{ type: "text", text: JSON.stringify({ found: false }) }] };

    // Read lines for detail
    let lines = [];
    if (so.order_line?.length) {
      lines = await odoo.executeKw({
        model: "sale.order.line",
        method: "read",
        args: [so.order_line],
        kwargs: { fields: ["product_id", "product_uom_qty", "price_unit", "price_subtotal", "discount"] }
      });
    }

    if (!so.access_token) {
        so.access_token = crypto.randomUUID();
        await odoo.executeKw({ model: "sale.order", method: "write", args: [[so.id], { access_token: so.access_token }] });
    }

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

    return {
      content: [{ type: "text", text: JSON.stringify({ 
        found: true, 
        order: {
          ...so,
          partner_id: Array.isArray(so.partner_id) ? so.partner_id[0] : so.partner_id,
          partner_name: Array.isArray(so.partner_id) ? so.partner_id[1] : null,
          order_lines: lines.map(l => ({
            sku: (l.product_id && l.product_id[1]) ? (l.product_id[1].match(/\[(.*?)\]/)?.[1] || l.product_id[1]) : "Unknown",
            name: (l.product_id && l.product_id[1]) ? l.product_id[1].replace(/\[.*?\]\s*/, "") : "Unknown",
            qty: l.product_uom_qty,
            unit_price: l.price_unit,
            subtotal: l.price_subtotal,
            discount: l.discount
          }))
        }, 
        pickings, 
        portal_url: `${odoo.baseUrl}/my/orders/${so.id}?access_token=${so.access_token}`, 
        payment_link: `${odoo.baseUrl}/payment/pay?amount=${so.amount_total}&access_token=${so.access_token}&sale_order_id=${so.id}` 
      }, null, 2) }]
    };
  }
);

server.tool(
  "xena_find_kits_for_sku",
  {
    sku: z.string().describe("Component product SKU (default_code). Use this tool to find all bundles/kits that contain a specific component. Example: Find kits containing 'VID-FRASC-HXNL-250ML-R63'. See RAG_Instructions.md section 'Descubrimiento de Productos' for bundle discovery strategies."),
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
    
    const kitProductTemplateIds = boms.map(b => b.product_tmpl_id[0]);
    let kits = [];
    if (kitProductTemplateIds.length > 0) {
      kits = await odoo.executeKw({
        model: "product.product",
        method: "search_read",
        args: [[["product_tmpl_id", "in", kitProductTemplateIds], ["website_published", "=", true]]],
        kwargs: { fields: ["id", "default_code", "name", "x_studio_url_publicacin"] }
      });
    }

    return { content: [{ type: "text", text: JSON.stringify({ component: p, kits }, null, 2) }] };
  },
);

// --- 2.8 SUPPORT TICKETS ---
server.tool(
  "xena_create_support_ticket",
  {
    partner_id: z.number().int().positive().describe("Customer ID"),
    subject: z.string().min(1).describe("Brief subject line"),
    description: z.string().optional().describe("Detailed description of the request or issue"),
    priority: z.enum(["0", "1", "2", "3"]).optional().default("1"),
  },
  async ({ partner_id, subject, description, priority }) => {
    const ticketId = await odoo.executeKw({
      model: "helpdesk.ticket",
      method: "create",
      args: [{ partner_id, name: subject, description: description || subject, priority }]
    });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ticket_id: ticketId, subject }, null, 2) }] };
  }
);

// --- 2.9 RECENT ORDERS ---
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
  }
);

// --- 2.10 TRAINING LOG ---
server.tool(
  "xena_log_training_example",
  {
    query: z.string(),
    expected_output: z.string(),
    category: z.string().optional().default("general"),
  },
  async ({ query, expected_output, category }) => {
    let tagId = null;
    const tags = await odoo.executeKw({ model: "note.tag", method: "search", args: [[["name", "=", "AI Training"]]], kwargs: { limit: 1 } });
    if (tags?.length) tagId = tags[0];
    else tagId = await odoo.executeKw({ model: "note.tag", method: "create", args: [{ name: "AI Training" }] });

    const noteBody = `<strong>Query:</strong> ${query}<br/><strong>Human Correction:</strong> ${expected_output}<br/><strong>Category:</strong> ${category}`;
    const noteId = await odoo.executeKw({ model: "note.note", method: "create", args: [{ memo: noteBody, tag_ids: [[6, 0, [tagId]]] }] });
    return { content: [{ type: "text", text: JSON.stringify({ success: true, note_id: noteId }, null, 2) }] };
  }
);

server.tool(
  "xena_create_invoice",
  {
    order_id: z.number().int().positive().describe("Odoo Sale Order ID. IMPORTANT: Order must be in 'sale' or 'done' state. This tool creates and auto-posts the invoice, generating a portal URL for customer access. See RAG_Instructions.md section 'Cotización y Cumplimiento' for invoicing workflow."),
  },
  async ({ order_id }) => {
    try {
      // 1. Check if the order is in a state that allows invoicing (sale or done)
      const orders = await odoo.executeKw({
        model: "sale.order",
        method: "read",
        args: [[order_id]],
        kwargs: { fields: ["id", "state", "invoice_ids", "partner_id"] }
      });

      if (!orders?.length) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Order not found" }) }] };
      }

      const order = orders[0];
      if (order.state !== 'sale' && order.state !== 'done') {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Order is in state '${order.state}'. It must be confirmed (sale) before invoicing.` }) }] };
      }

      // 2. Trigger the invoicing action (standard Odoo method)
      // This creates the account.move (invoice) and links it to the sale order
      const invoiceId = await odoo.executeKw({
        model: "sale.order",
        method: "_create_invoices",
        args: [[order_id]],
        kwargs: { final: true }
      });

      if (!invoiceId || !invoiceId.length) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Failed to create invoice. It might be already invoiced or have no items to invoice." }) }] };
      }

      // 3. Post (Confirm) the invoice
      await odoo.executeKw({
        model: "account.move",
        method: "action_post",
        args: [invoiceId]
      });

      // 4. Get the portal URL for the invoice
      const invoices = await odoo.executeKw({
        model: "account.move",
        method: "read",
        args: [invoiceId],
        kwargs: { fields: ["id", "name", "payment_state", "amount_total", "access_token"] }
      });

      const inv = invoices[0];
      if (!inv.access_token) {
        inv.access_token = crypto.randomUUID();
        await odoo.executeKw({ model: "account.move", method: "write", args: [[inv.id], { access_token: inv.access_token }] });
      }

      const portalUrl = `${odoo.baseUrl}/my/invoices/${inv.id}?access_token=${inv.access_token}`;

      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            invoice_id: inv.id, 
            invoice_name: inv.name,
            amount_total: inv.amount_total,
            payment_state: inv.payment_state,
            portal_url: portalUrl 
          }, null, 2) 
        }] 
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to generate invoice: ${err.message}` }) }] };
    }
  }
);

server.tool(
  "xena_escalate_to_human",
  {
    reason: z.string().describe("Reason for escalation (e.g. 'warranty_claim', 'sales_question', 'low_certainty')"),
    summary: z.string().optional().describe("Brief summary of the user's request")
  },
  async ({ reason, summary }) => {
    // This tool acts as a signal. The actual routing happens in n8n or via the Agent's response.
    // We return a specific string that the Agent can use to confirm the action.
    return { 
      content: [{ 
        type: "text", 
        text: JSON.stringify({ 
          status: "escalation_triggered", 
          message: "Escalation signal received. Please inform the user you are connecting them with a human agent.",
          reason 
        }, null, 2) 
      }] 
    };
  }
);
  return server;
}

const port = parseInt(process.env.PORT || "8080", 10);
if (process.env.MCP_TRANSPORT === "sse" || process.env.PORT) {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.set('trust proxy', true);
  app.use(cors());

  // Simple Bearer Auth Middleware (Skips OPTIONS for CORS preflight)
  const authMiddleware = (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    if (!AUTH_TOKEN) return next();
    
    const authHeader = req.get("Authorization") || req.get("authorization");
    const expected = `Bearer ${AUTH_TOKEN}`;
    
    if (!authHeader || authHeader !== expected) {
      const sanitizedReceived = authHeader ? `${authHeader.substring(0, 10)}...` : "None";
      console.error(`[${new Date().toISOString()}] Unauthorized ${req.method} ${req.url} - IP: ${req.ip} - Auth: ${sanitizedReceived}`);
      return res.status(401).json({ 
        jsonrpc: '2.0', 
        error: { 
          code: -32000, 
          message: "Unauthorized: Missing or invalid Bearer token" 
        }, 
        id: null 
      });
    }
    next();
  };

  app.use((req, res, next) => {
    if (!req.url.startsWith('/mcp') && !req.url.startsWith('/health')) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    }
    next();
  });

  const transports = new Map();
  const sessionLastActivity = new Map();
  const sessionCreatedAt = new Map();
  const MAX_SESSIONS = 1500; // Increased massively to absorb N8N's connection spikes
  const SESSION_TTL_MS = 60_000; // 1 minute idle timeout (prevent zombie build-up)
  const SESSION_MAX_LIFETIME_MS = 300_000; // 5 minutes absolute lifetime
  const SERVER_START_TIME = Date.now();
  const ZOMBIE_SWEEP_MS = 15_000; // 15 seconds of rejecting new connections on boot

  // --- Session cleanup sweeper (runs every 30s) ---
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sid, lastActive] of sessionLastActivity.entries()) {
      const created = sessionCreatedAt.get(sid) || 0;
      const isIdle = (now - lastActive) > SESSION_TTL_MS;
      const isExpired = (now - created) > SESSION_MAX_LIFETIME_MS;
      if (isIdle || isExpired) {
        const t = transports.get(sid);
        if (t) {
          try { 
            // End the HTTP response gracefully to trigger EventSource retry,
            // EXCEPT if we hit the limit, see MAX_SESSIONS logic
            t.res?.end(); 
            t.close?.(); 
          } catch (_) { /* ignore */ }
        }
        transports.delete(sid);
        sessionLastActivity.delete(sid);
        sessionCreatedAt.delete(sid);
        cleaned++;
      }
    }
    // Only log sweeper if there are active sessions or it cleaned something
    if (cleaned > 0 || transports.size > 0) {
        console.error(`[${new Date().toISOString()}] Session sweeper: cleaned=${cleaned}, active=${transports.size}/${MAX_SESSIONS}`);
    }
  }, 30_000);

  // ============================================================================
  // STREAMABLE HTTP TRANSPORT (RECOMMENDED) (PROTOCOL VERSION 2025-11-25)
  // Use in n8n with connection type "HTTP Streamable"
  // ============================================================================
  app.all('/mcp', authMiddleware, async (req, res) => {
    try {
        if (transports.size >= MAX_SESSIONS) {
            console.error(`[${new Date().toISOString()}] MCP REJECTED: max sessions (${MAX_SESSIONS}) reached. Sending 503.`);
            res.setHeader("Retry-After", "10");
            return res.status(503).json({ error: "Too many concurrent sessions. Try again shortly." });
        }

        const sessionId = req.headers['mcp-session-id'];
        let transport;
        
        if (sessionId && transports.has(sessionId)) {
            const existingTransport = transports.get(sessionId);
            if (existingTransport instanceof StreamableHTTPServerTransport) {
                transport = existingTransport;
            } else {
                return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session exists but uses a different transport protocol'}, id: null });
            }
        } else if (!sessionId && req.method === 'POST') {
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (sid) => {
                    if (transports.size % 50 === 0) {
                        console.error(`[${new Date().toISOString()}] StreamableHTTP session initialized: ${sid}`);
                    }
                    transports.set(sid, transport);
                    sessionLastActivity.set(sid, Date.now());
                    sessionCreatedAt.set(sid, Date.now());
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    transports.delete(sid);
                    sessionLastActivity.delete(sid);
                    sessionCreatedAt.delete(sid);
                }
            };

            const server = createMcpServer();
            await server.connect(transport);
        } else {
            return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided'}, id: null });
        }

        if (transport.sessionId) {
            sessionLastActivity.set(transport.sessionId, Date.now());
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error'}, id: null });
        }
    }
  });

  // ============================================================================
  // DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
  // Use in n8n with connection type "SSE" (NOTE: Prone to Proxy 503 Errors)
  // ============================================================================
  app.get("/sse", authMiddleware, async (req, res) => {
    const authHeader = req.get("Authorization");
    const isAuthorized = AUTH_TOKEN && authHeader === `Bearer ${AUTH_TOKEN}`;

    if (transports.size >= MAX_SESSIONS) {
      res.setHeader("Retry-After", "10");
      return res.status(503).json({ error: "Too many concurrent sessions. Try again shortly." });
    }
    
    if (transports.size % 50 === 0) {
        console.error(`[${new Date().toISOString()}] SSE connection status: IP=${req.ip}, Active=${transports.size}/${MAX_SESSIONS}`);
    }
    
    if (!isAuthorized && AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const transport = new SSEServerTransport("/messages", res);
    if (transports.size % 50 === 0) {
        console.error(`[${new Date().toISOString()}] Created new SSE session: ${transport.sessionId}`);
    }
    transports.set(transport.sessionId, transport);
    sessionLastActivity.set(transport.sessionId, Date.now());
    sessionCreatedAt.set(transport.sessionId, Date.now());

    let keepAliveInterval;

    transport.onclose = () => {
      if (keepAliveInterval) clearInterval(keepAliveInterval);
      transports.delete(transport.sessionId);
      sessionLastActivity.delete(transport.sessionId);
      sessionCreatedAt.delete(transport.sessionId);
    };

    try {
      const server = createMcpServer();
      await server.connect(transport);
      
      // Force flush proxy buffers with polite padding to help bypass Railway Edge
      for (let i = 0; i < 8; i++) {
        res.write(":" + " ".repeat(64) + "\n\n");
      }

      const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
      const host = req.headers["host"];
      const fullUrl = `${protocol}://${host}/messages?sessionId=${transport.sessionId}`;

      // Set explicit Content-Type for SSE and allow credentials if needed via standard headers
      res.write(`event: endpoint\ndata: ${fullUrl}\n\n`);

      keepAliveInterval = setInterval(() => {
          if (!res.writableEnded) {
              res.write(": keep-alive\n\n");
          }
      }, 5000);

      req.on("close", () => {
        clearInterval(keepAliveInterval);
        transports.delete(transport.sessionId);
        sessionLastActivity.delete(transport.sessionId);
        sessionCreatedAt.delete(transport.sessionId);
      });
      
    } catch (err) {
      console.error("Failed to connect SSE transport:", err);
      transports.delete(transport.sessionId);
    }
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        return res.status(400).send("Missing sessionId");
    }

    sessionLastActivity.set(sessionId, Date.now());

    const existingTransport = transports.get(sessionId);
    if (existingTransport instanceof SSEServerTransport) {
      try {
        await existingTransport.handlePostMessage(req, res);
      } catch (err) {
        console.error(`Error handling post message for session ${sessionId}:`, err);
        res.status(500).send("Internal error");
      }
    } else {
      res.status(404).send("Session not found or incompatible protocol");
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "2.1.0", active_sessions: transports.size, max_sessions: MAX_SESSIONS });
  });

  app.listen(port, "0.0.0.0", async () => {
    console.error(`MCP Server (SSE) running on port ${port}`);
    await odoo.authenticate();
  });
} else {
  const transport = new StdioServerTransport();
  await odoo.authenticate();
  const server = createMcpServer();
  await server.connect(transport);
  console.error("MCP Server (Stdio) running");
}
