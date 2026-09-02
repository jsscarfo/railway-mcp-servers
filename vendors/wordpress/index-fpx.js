#!/usr/bin/env node

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("fs");

// Optional env file (Railway vars take precedence; do not hardcode Windows paths)
try {
  const envFile = process.env.MCP_ENV_FILE;
  if (envFile && fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, "utf-8");
    envContent.split("\n").forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        if (process.env[key]) return;
        let value = match[2] || "";
        if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
          value = value.replace(/\\n/gm, "\n");
          value = value.replace(/^"(.*)"$/, "$1");
        }
        process.env[key] = value;
      }
    });
  }
} catch (e) {
  console.error("Warning: Could not read MCP_ENV_FILE");
}

// Retrieve configuration from environment
// We expect these to be passed down by the MCP config
const SITE_URL = "https://flemishpixel.com";
const WP_APP_USERNAME = process.env.WP_APP_USERNAME_FPX;
let WP_APP_PASSWORD = process.env.WP_APP_PASSWORD_FPX;

if (!WP_APP_USERNAME || !WP_APP_PASSWORD) {
  console.error("Missing WP_APP_USERNAME_FPX or WP_APP_PASSWORD_FPX in environment.");
  process.exit(1);
}

// Strip whitespace from the password (WP application passwords often have spaces)
WP_APP_PASSWORD = WP_APP_PASSWORD.replace(/\s+/g, '');

// Ensure SITE_URL doesn't have trailing slash
const baseUrl = SITE_URL.replace(/\/$/, "");

// Basic Auth string
const authHeader = "Basic " + Buffer.from(`${WP_APP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');

// Helper to make WP REST API requests (wp/v2 namespace)
async function wpRequest(endpoint, options = {}) {
  const url = `${baseUrl}/wp-json/wp/v2${endpoint}`;
  
  const headers = {
    "Authorization": authHeader,
    "Content-Type": "application/json",
    ...options.headers
  };

  try {
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    
    if (!response.ok) {
      throw new Error(`WordPress API Error (${response.status}): ${text}`);
    }
    
    if (text) {
        return JSON.parse(text);
    }
    return {};
  } catch (error) {
    throw new Error(`Failed to communicate with WordPress: ${error.message}`);
  }
}

// Helper for arbitrary wp-json paths (themes, custom-css, litespeed, etc.)
async function wpRawRequest(path, options = {}) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}/wp-json${normalized}`;

  const headers = {
    Authorization: authHeader,
    "Content-Type": "application/json",
    ...options.headers,
  };

  try {
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`WordPress API Error (${response.status}): ${text}`);
    }

    if (text) {
      return JSON.parse(text);
    }
    return {};
  } catch (error) {
    throw new Error(`Failed to communicate with WordPress: ${error.message}`);
  }
}

async function getActiveThemeStylesheet() {
  const themes = await wpRawRequest("/wp/v2/themes");
  const active = themes.find((t) => t.status === "active");
  if (!active) {
    throw new Error("No active theme found via /wp/v2/themes");
  }
  return active.stylesheet;
}

async function getCustomCss(stylesheet) {
  const sheet = stylesheet || (await getActiveThemeStylesheet());
  return wpRawRequest(`/wp/v2/custom-css/${encodeURIComponent(sheet)}`);
}

const FA4_IMPORT =
  "@import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css');";

async function updateCustomCss(css, stylesheet) {
  const sheet = stylesheet || (await getActiveThemeStylesheet());
  return wpRawRequest(`/wp/v2/custom-css/${encodeURIComponent(sheet)}`, {
    method: "POST",
    body: JSON.stringify({ css }),
  });
}

async function prependFontAwesomeImport(existingCss) {
  const css = existingCss || "";
  if (css.includes("font-awesome/4.7.0")) {
    return { css, changed: false, reason: "font-awesome-4.7 already present" };
  }
  const trimmed = css.trimStart();
  const newCss = trimmed ? `${FA4_IMPORT}\n\n${trimmed}` : FA4_IMPORT;
  return { css: newCss, changed: true };
}

// Helper to upload media
async function wpUploadMedia(filePath) {
  const url = `${baseUrl}/wp-json/wp/v2/media`;
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  const buffer = fs.readFileSync(filePath);
  const filename = require('path').basename(filePath);
  
  // Guess mime type roughly based on extension
  let mimeType = 'application/octet-stream';
  if (filename.match(/\.jpg|\.jpeg$/i)) mimeType = 'image/jpeg';
  else if (filename.match(/\.png$/i)) mimeType = 'image/png';
  else if (filename.match(/\.gif$/i)) mimeType = 'image/gif';
  else if (filename.match(/\.webp$/i)) mimeType = 'image/webp';
  else if (filename.match(/\.pdf$/i)) mimeType = 'application/pdf';

  const headers = {
    "Authorization": authHeader,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": mimeType
  };

  try {
    const response = await fetch(url, { method: "POST", headers, body: buffer });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`WordPress API Error (${response.status}): ${text}`);
    }
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to upload media: ${error.message}`);
  }
}

// Create the server
const server = new McpServer({
  name: "wordpress-mcp-server",
  version: "1.0.0",
});

// Tool: Get Pages
server.tool(
  "wp_get_pages",
  "Retrieve a list of WordPress pages",
  {
    per_page: z.number().optional().describe("Number of pages to return (default: 10)"),
    search: z.string().optional().describe("Search term"),
  },
  async ({ per_page = 10, search }) => {
    let endpoint = `/pages?per_page=${per_page}`;
    if (search) endpoint += `&search=${encodeURIComponent(search)}`;
    
    const pages = await wpRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(pages, null, 2) }],
    };
  }
);

// Tool: Create Page
server.tool(
  "wp_create_page",
  "Create a new WordPress page",
  {
    title: z.string().describe("Title of the page"),
    content: z.string().describe("HTML content of the page"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("Status of the page"),
  },
  async ({ title, content, status = "draft" }) => {
    const page = await wpRequest("/pages", {
      method: "POST",
      body: JSON.stringify({ title, content, status }),
    });
    return {
      content: [{ type: "text", text: `Page created successfully:\n${JSON.stringify(page, null, 2)}` }],
    };
  }
);

// Tool: Get Settings
server.tool(
  "wp_get_settings",
  "Retrieve WordPress site settings",
  {},
  async () => {
    const settings = await wpRequest("/settings");
    return {
      content: [{ type: "text", text: JSON.stringify(settings, null, 2) }],
    };
  }
);

// Tool: Get Customizer Additional CSS
server.tool(
  "wp_get_custom_css",
  "Retrieve Additional CSS for the active theme (Customizer → Additional CSS)",
  {
    stylesheet: z
      .string()
      .optional()
      .describe("Theme stylesheet slug (default: active theme)"),
  },
  async ({ stylesheet }) => {
    const data = await getCustomCss(stylesheet);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }
);

// Tool: Update Customizer Additional CSS
server.tool(
  "wp_update_custom_css",
  "Update Additional CSS for a theme (Customizer → Additional CSS)",
  {
    css: z.string().describe("Full Additional CSS content"),
    stylesheet: z
      .string()
      .optional()
      .describe("Theme stylesheet slug (default: active theme)"),
  },
  async ({ css, stylesheet }) => {
    const data = await updateCustomCss(css, stylesheet);
    return {
      content: [
        {
          type: "text",
          text: `Custom CSS updated:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }
);

// Tool: Prepend Font Awesome 4.7 @import to Additional CSS
server.tool(
  "wp_prepend_font_awesome_4",
  "Add Font Awesome 4.7 @import at top of Additional CSS if missing",
  {
    stylesheet: z
      .string()
      .optional()
      .describe("Theme stylesheet slug (default: active theme)"),
  },
  async ({ stylesheet }) => {
    const current = await getCustomCss(stylesheet);
    const existing = current.css || "";
    const { css, changed, reason } = await prependFontAwesomeImport(existing);
    if (!changed) {
      return {
        content: [
          {
            type: "text",
            text: `No change: ${reason}`,
          },
        ],
      };
    }
    const data = await updateCustomCss(css, stylesheet || current.stylesheet);
    return {
      content: [
        {
          type: "text",
          text: `Font Awesome 4.7 import prepended.\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  }
);

// Tool: Update Settings
server.tool(
  "wp_update_settings",
  "Update WordPress site settings",
  {
    title: z.string().optional().describe("Site title"),
    description: z.string().optional().describe("Site tagline"),
  },
  async ({ title, description }) => {
    const payload = {};
    if (title !== undefined) payload.title = title;
    if (description !== undefined) payload.description = description;

    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No settings provided to update." }] };
    }

    const settings = await wpRequest("/settings", {
      method: "POST", // WP REST API allows POST to /settings
      body: JSON.stringify(payload),
    });
    return {
      content: [{ type: "text", text: `Settings updated successfully:\n${JSON.stringify(settings, null, 2)}` }],
    };
  }
);

// Tool: Upload Media
server.tool(
  "wp_upload_media",
  "Upload a file to the WordPress Media Library",
  {
    file_path: z.string().describe("Absolute path to the local file to upload"),
  },
  async ({ file_path }) => {
    const media = await wpUploadMedia(file_path);
    return {
      content: [{ type: "text", text: `Media uploaded successfully:\nURL: ${media.source_url}\nID: ${media.id}` }],
    };
  }
);

// Tool: Update Page
server.tool(
  "wp_update_page",
  "Update an existing WordPress page",
  {
    id: z.number().describe("ID of the page to update"),
    title: z.string().optional().describe("Title of the page"),
    content: z.string().optional().describe("HTML content of the page"),
    content_path: z.string().optional().describe("Absolute path to a file whose contents should be used as page content (alternative to content)"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("Status of the page"),
    aioseo_title: z.string().optional().describe("AIOSEO Post Title (SEO title tag)"),
    aioseo_description: z.string().optional().describe("AIOSEO Meta Description"),
    slug: z.string().optional().describe("Page slug (permalink path)"),
  },
  async ({ id, title, content, content_path, status, aioseo_title, aioseo_description, slug }) => {
    const payload = {};
    if (title !== undefined) payload.title = title;
    let pageContent = content;
    if (content_path !== undefined) {
      if (!fs.existsSync(content_path)) {
        return { content: [{ type: "text", text: `content_path not found: ${content_path}` }] };
      }
      pageContent = fs.readFileSync(content_path, "utf-8");
    }
    if (pageContent !== undefined) payload.content = pageContent;
    if (status !== undefined) payload.status = status;
    if (slug !== undefined) payload.slug = slug;
    if (aioseo_title !== undefined || aioseo_description !== undefined) {
      payload.aioseo_meta_data = {};
      if (aioseo_title !== undefined) payload.aioseo_meta_data.title = aioseo_title;
      if (aioseo_description !== undefined) payload.aioseo_meta_data.description = aioseo_description;
    }

    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No fields provided to update." }] };
    }

    const page = await wpRequest(`/pages/${id}`, {
      method: "POST", // WP REST API uses POST to update resources
      body: JSON.stringify(payload),
    });
    return {
      content: [{ type: "text", text: `Page updated successfully:\n${JSON.stringify(page, null, 2)}` }],
    };
  }
);

// Tool: Get Posts
server.tool(
  "wp_get_posts",
  "Retrieve a list of WordPress posts",
  {
    per_page: z.number().optional().describe("Number of posts to return (default: 10)"),
    search: z.string().optional().describe("Search term"),
  },
  async ({ per_page = 10, search }) => {
    let endpoint = `/posts?per_page=${per_page}`;
    if (search) endpoint += `&search=${encodeURIComponent(search)}`;
    
    const posts = await wpRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(posts, null, 2) }],
    };
  }
);

// Tool: Create Post
server.tool(
  "wp_create_post",
  "Create a new WordPress post",
  {
    title: z.string().describe("Title of the post"),
    content: z.string().describe("HTML content of the post"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("Status of the post"),
    categories: z.array(z.number()).optional().describe("Array of category IDs"),
    tags: z.array(z.number()).optional().describe("Array of tag IDs"),
  },
  async ({ title, content, status = "draft", categories, tags }) => {
    const payload = { title, content, status };
    if (categories) payload.categories = categories;
    if (tags) payload.tags = tags;

    const post = await wpRequest("/posts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      content: [{ type: "text", text: `Post created successfully:\n${JSON.stringify(post, null, 2)}` }],
    };
  }
);

// Tool: Update Post
server.tool(
  "wp_update_post",
  "Update an existing WordPress post",
  {
    id: z.number().describe("ID of the post to update"),
    title: z.string().optional().describe("Title of the post"),
    content: z.string().optional().describe("HTML content of the post"),
    status: z.enum(["publish", "draft", "private"]).optional().describe("Status of the post"),
    categories: z.array(z.number()).optional().describe("Array of category IDs"),
    tags: z.array(z.number()).optional().describe("Array of tag IDs"),
  },
  async ({ id, title, content, status, categories, tags }) => {
    const payload = {};
    if (title !== undefined) payload.title = title;
    if (content !== undefined) payload.content = content;
    if (status !== undefined) payload.status = status;
    if (categories !== undefined) payload.categories = categories;
    if (tags !== undefined) payload.tags = tags;

    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No fields provided to update." }] };
    }

    const post = await wpRequest(`/posts/${id}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      content: [{ type: "text", text: `Post updated successfully:\n${JSON.stringify(post, null, 2)}` }],
    };
  }
);

// Tool: Delete Post or Page
server.tool(
  "wp_delete_post",
  "Move a post or page to trash",
  {
    id: z.number().describe("ID of the post or page to delete"),
    type: z.enum(["posts", "pages"]).optional().describe("Type of content ('posts' or 'pages', default: 'posts')"),
  },
  async ({ id, type = "posts" }) => {
    const result = await wpRequest(`/${type}/${id}`, {
      method: "DELETE",
    });
    return {
      content: [{ type: "text", text: `Deleted successfully:\n${JSON.stringify(result, null, 2)}` }],
    };
  }
);

// Tool: Get Categories
server.tool(
  "wp_get_categories",
  "Retrieve WordPress categories",
  {},
  async () => {
    const categories = await wpRequest("/categories?per_page=100");
    return {
      content: [{ type: "text", text: JSON.stringify(categories, null, 2) }],
    };
  }
);

// Tool: Get Tags
server.tool(
  "wp_get_tags",
  "Retrieve WordPress tags",
  {},
  async () => {
    const tags = await wpRequest("/tags?per_page=100");
    return {
      content: [{ type: "text", text: JSON.stringify(tags, null, 2) }],
    };
  }
);

// Tool: Get Users
server.tool(
  "wp_get_users",
  "Retrieve WordPress users",
  {},
  async () => {
    const users = await wpRequest("/users");
    return {
      content: [{ type: "text", text: JSON.stringify(users, null, 2) }],
    };
  }
);

async function batchAioseoCli() {
  const jsonPath = process.argv[3];
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error("Usage: node index-fpx.js batch-aioseo <jsonPath>");
    process.exit(1);
  }
  const items = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const results = [];
  for (const item of items) {
    try {
      const page = await wpRequest(`/pages/${item.id}`, {
        method: "POST",
        body: JSON.stringify({
          aioseo_meta_data: { title: item.title, description: item.description },
        }),
      });
      const head = page.aioseo_head_json || {};
      const meta = page.aioseo_meta_data || {};
      results.push({
        id: item.id,
        ok: true,
        aioseo_title: meta.title || head.title,
        aioseo_description: meta.description || head.description,
        modified: page.modified,
      });
    } catch (err) {
      results.push({ id: item.id, ok: false, error: err.message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

async function updateAioseoCli() {
  const pageId = process.argv[3];
  const seoTitle = process.argv[4];
  const seoDescription = process.argv[5];
  if (!pageId || !seoTitle || !seoDescription) {
    console.error("Usage: node index-fpx.js update-aioseo <pageId> <title> <description>");
    process.exit(1);
  }
  const page = await wpRequest(`/pages/${pageId}`, {
    method: "POST",
    body: JSON.stringify({
      aioseo_meta_data: { title: seoTitle, description: seoDescription },
    }),
  });
  const head = page.aioseo_head_json || {};
  const meta = page.aioseo_meta_data || {};
  console.log(JSON.stringify({
    id: page.id,
    aioseo_title: meta.title || head.title,
    aioseo_description: meta.description || head.description,
    canonical: head.canonical_url,
    modified: page.modified,
  }, null, 2));
}

async function patchZeroProseCli() {
  const pageId = process.argv[3];
  const lang = process.argv[4] || "es";
  if (!pageId) {
    console.error("Usage: node index-fpx.js patch-zero-prose <pageId> [es|en]");
    process.exit(1);
  }
  const page = await wpRequest(`/pages/${pageId}?context=edit`);
  let raw = page.content && page.content.raw ? page.content.raw : "";
  if (!raw) {
    console.error("No raw content returned");
    process.exit(1);
  }
  const before = raw;
  if (lang === "en") {
    raw = raw.replace(
      /<p class="wp-block-paragraph">The Zero Pack includes[\s\S]*?<\/p>\s*<p class="has-small-font-size wp-block-paragraph"><em>\*Limited-time offer\.<\/em><\/p>/,
      '<p class="wp-block-paragraph">The Zero Pack includes 4 hot-desk passes and $500 MXN in credits, no monthly fee — <strong>$1,400 MXN with VAT</strong>. Ask about a current coupon via social or email. It makes sense once you know you&#8217;ll come back a few times this year, not just for one occasional day.</p>'
    );
  } else {
    raw = raw.replace(
      /<p class="wp-block-paragraph">El Zero Pack incluye[\s\S]*?<\/p>\s*<p class="has-small-font-size wp-block-paragraph"><em>\*Por tiempo limitado\.<\/em><\/p>/,
      '<p class="wp-block-paragraph">El Zero Pack incluye 4 pases de hot-desk y $500 en créditos, sin mensualidad — <strong>$1,400 MXN con IVA</strong>. Pregunta por cupón vigente en redes o por correo. Tiene sentido en cuanto sabes que volverás varias veces este año, no solo un día suelto.</p>'
    );
  }
  if (raw === before) {
    console.error("Zero prose pattern not found — no changes made");
    process.exit(1);
  }
  const updated = await wpRequest(`/pages/${pageId}`, {
    method: "POST",
    body: JSON.stringify({ content: raw, status: "publish" }),
  });
  console.log(JSON.stringify({
    id: updated.id,
    modified: updated.modified,
    zero_prose_patched: true,
    has_rpt_pricr: raw.includes("rpt_pricr"),
    has_shortcode: raw.includes("[rpt name="),
  }, null, 2));
}

// CLI: node index-fpx.js push-page-from-file <pageId> <contentFilePath>
async function pushPageFromFileCli() {
  const pageId = process.argv[3];
  const contentFile = process.argv[4];
  if (!pageId || !contentFile) {
    console.error("Usage: node index-fpx.js push-page-from-file <pageId> <contentFilePath> [status] [slug]");
    process.exit(1);
  }
  if (!fs.existsSync(contentFile)) {
    console.error(`File not found: ${contentFile}`);
    process.exit(1);
  }
  const content = fs.readFileSync(contentFile, "utf-8");
  const status = process.argv[5] || "publish";
  const slug = process.argv[6];
  const payload = { content, status };
  if (slug) payload.slug = slug;
  const page = await wpRequest(`/pages/${pageId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const raw = page.content && page.content.raw ? page.content.raw : "";
  console.log(JSON.stringify({
    id: page.id,
    status: page.status,
    slug: page.slug,
    link: page.link,
    modified: page.modified,
    has_rpt_pricr_in_raw: raw.includes("rpt_pricr"),
    has_shortcode_blocks: raw.includes("wp:shortcode"),
    shortcode_count: (raw.match(/\[rpt name=/g) || []).length,
  }, null, 2));
}

async function customCssGetCli() {
  const data = await getCustomCss();
  console.log(JSON.stringify(data, null, 2));
}

async function customCssPrependFaCli() {
  const current = await getCustomCss();
  const existing = current.css || "";
  const { css, changed, reason } = await prependFontAwesomeImport(existing);
  if (!changed) {
    console.log(JSON.stringify({ changed: false, reason }, null, 2));
    return;
  }
  const data = await updateCustomCss(css, current.stylesheet);
  console.log(JSON.stringify({ changed: true, result: data }, null, 2));
}

async function verifyHomeIconsCli() {
  const html = await fetch(`${baseUrl}/`).then((r) => r.text());
  const faCount = (html.match(/class="fa /g) || []).length;
  const faIconCount = (html.match(/<i class="fa /g) || []).length;
  const hasFaStylesheet =
    /font-awesome[^"']*4\.7/i.test(html) ||
    html.includes("font-awesome.min.css");
  const hasCustomCssLink = html.includes("custom-css") || html.includes("wp-custom-css");
  console.log(
    JSON.stringify(
      {
        fa_class_occurrences: faCount,
        fa_i_tag_count: faIconCount,
        has_font_awesome_stylesheet_in_html: hasFaStylesheet,
        has_custom_css_link: hasCustomCssLink,
        rpt_css_present: html.includes("rpt_style.min.css"),
      },
      null,
      2
    )
  );
}

async function installPluginCli() {
  const slug = process.argv[3];
  if (!slug) {
    console.error("Usage: node index-fpx.js install-plugin <slug>");
    process.exit(1);
  }
  const data = await wpRawRequest("/wp/v2/plugins", {
    method: "POST",
    body: JSON.stringify({ slug, status: "active" }),
  });
  console.log(JSON.stringify(data, null, 2));
}

async function listPluginsCli() {
  const plugins = await wpRawRequest("/wp/v2/plugins");
  console.log(
    JSON.stringify(
      plugins.map((p) => ({ plugin: p.plugin, status: p.status, name: p.name })),
      null,
      2
    )
  );
}

async function inspectHomeHtmlCli() {
  const html = await fetch(`${baseUrl}/`).then((r) => r.text());
  const themeLinks = [...html.matchAll(/href=["']([^"']*\/themes\/[^"']+)["']/gi)].map(
    (m) => m[1]
  );
  const globalLinks = [...html.matchAll(/href=["']([^"']*global-styles[^"']*)["']/gi)].map(
    (m) => m[1]
  );
  const customLinks = [...html.matchAll(/href=["']([^"']*custom[^"']*)["']/gi)]
    .map((m) => m[1])
    .filter((u) => u.includes("css"));
  const ids = [...html.matchAll(/global-styles\/(\d+)/g)].map((m) => m[1]);
  const inlineGlobal = html.match(/<style id="global-styles-inline-css">([\s\S]*?)<\/style>/);
  const inlinePreview = inlineGlobal ? inlineGlobal[1].slice(0, 120) : null;
  console.log(
    JSON.stringify(
      { themeLinks, globalLinks, customLinks, globalStyleIds: ids, inlinePreview },
      null,
      2
    )
  );
}

async function listThemesCli() {
  const themes = await wpRawRequest("/wp/v2/themes");
  console.log(
    JSON.stringify(
      themes.map((t) => ({
        stylesheet: t.stylesheet,
        template: t.template,
        status: t.status,
        name: t.name && t.name.raw,
      })),
      null,
      2
    )
  );
}

async function findGlobalStylesCli() {
  const candidates = [6, 7, 8, 9, 10];
  const hits = [];
  for (const id of candidates) {
    try {
      const data = await wpRawRequest(`/wp/v2/global-styles/${id}?context=edit`);
      hits.push({ id: data.id, ok: true });
    } catch (err) {
      hits.push({ id, ok: false, error: err.message.slice(0, 120) });
    }
  }
  console.log(JSON.stringify(hits, null, 2));
}

async function globalStylesGetCli() {
  const id = process.argv[3];
  if (!id) {
    console.error("Usage: node index-fpx.js global-styles-get <id>");
    process.exit(1);
  }
  const data = await wpRawRequest(
    `/wp/v2/global-styles/${id}?context=edit`
  );
  console.log(
    JSON.stringify(
      {
        id: data.id,
        title: data.title,
        styles_css_len: (data.styles && data.styles.css && data.styles.css.length) || 0,
        styles_css_preview: (data.styles && data.styles.css && data.styles.css.slice(0, 300)) || null,
        settings_keys: data.settings ? Object.keys(data.settings).slice(0, 20) : [],
      },
      null,
      2
    )
  );
}

async function globalStylesThemeCli() {
  const theme = process.argv[3] || "twentytwentyfive";
  const contexts = ["view", "edit"];
  for (const context of contexts) {
    const data = await wpRawRequest(
      `/wp/v2/global-styles/themes/${encodeURIComponent(theme)}?context=${context}`
    );
    console.log(
      context,
      JSON.stringify(
        {
          top_keys: Object.keys(data),
          id: data.id,
          styles_css_len: (data.styles && data.styles.css && data.styles.css.length) || 0,
          has_custom_colors: JSON.stringify(data.settings || "").includes("custom-f-1-c-40-f"),
          has_fa7: JSON.stringify(data.settings || "").includes("font-awesome-7"),
        },
        null,
        2
      )
    );
  }
}

async function globalStylesPrependFaCli() {
  const theme = process.argv[3] || "twentytwentyfive";
  const data = await wpRawRequest(
    `/wp/v2/global-styles/themes/${encodeURIComponent(theme)}?context=edit`
  );
  const existingCss = (data.styles && data.styles.css) || "";
  const { css, changed, reason } = await prependFontAwesomeImport(existingCss);
  if (!changed) {
    console.log(JSON.stringify({ changed: false, reason, id: data.id }, null, 2));
    return;
  }
  const payload = {
    styles: {
      ...(data.styles || {}),
      css,
    },
  };
  const methods = ["POST", "PUT", "PATCH"];
  let updated = null;
  let lastError = null;
  for (const method of methods) {
    try {
      updated = await wpRawRequest(
        `/wp/v2/global-styles/themes/${encodeURIComponent(theme)}?context=edit`,
        {
          method,
          body: JSON.stringify(payload),
        }
      );
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!updated) {
    throw lastError || new Error("Failed to update global styles");
  }
  console.log(
    JSON.stringify(
      {
        changed: true,
        id: updated.id,
        styles_css: updated.styles && updated.styles.css,
      },
      null,
      2
    )
  );
}

async function templatePartGetCli() {
  const id = process.argv[3];
  if (!id) {
    console.error("Usage: node index-fpx.js template-part-get <id> [outFile]");
    process.exit(1);
  }
  const data = await wpRawRequest(
    `/wp/v2/template-parts/${encodeURIComponent(id)}?context=edit`
  );
  const raw = data.content && data.content.raw ? data.content.raw : "";
  const outFile = process.argv[4];
  if (outFile) {
    fs.writeFileSync(outFile, raw, "utf-8");
    console.log(
      JSON.stringify(
        {
          id: data.id,
          slug: data.slug,
          title: data.title && data.title.raw,
          raw_len: raw.length,
          wrote: outFile,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        id: data.id,
        slug: data.slug,
        title: data.title && data.title.raw,
        raw_len: raw.length,
        raw_preview: raw.slice(0, 400),
        raw,
      },
      null,
      2
    )
  );
}

async function pushTemplatePartFromFileCli() {
  const id = process.argv[3];
  const contentFile = process.argv[4];
  if (!id || !contentFile) {
    console.error(
      "Usage: node index-fpx.js push-template-part-from-file <id> <contentFilePath>"
    );
    process.exit(1);
  }
  if (!fs.existsSync(contentFile)) {
    console.error(`File not found: ${contentFile}`);
    process.exit(1);
  }
  const content = fs.readFileSync(contentFile, "utf-8");
  const updated = await wpRawRequest(
    `/wp/v2/template-parts/${encodeURIComponent(id)}?context=edit`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    }
  );
  const raw = updated.content && updated.content.raw ? updated.content.raw : "";
  console.log(
    JSON.stringify(
      {
        id: updated.id,
        slug: updated.slug,
        modified: updated.modified,
        raw_len: raw.length,
      },
      null,
      2
    )
  );
}

async function getNavigationCli() {
  const slugOrId = process.argv[3];
  if (!slugOrId) {
    console.error("Usage: node index-fpx.js get-navigation <slugOrId> [outFile]");
    process.exit(1);
  }
  let data;
  if (/^\d+$/.test(slugOrId)) {
    data = await wpRawRequest(
      `/wp/v2/navigation/${slugOrId}?context=edit`
    );
  } else {
    const menus = await wpRawRequest(
      `/wp/v2/navigation?slug=${encodeURIComponent(slugOrId)}&context=edit`
    );
    if (!Array.isArray(menus) || menus.length === 0) {
      throw new Error(`Navigation not found for slug: ${slugOrId}`);
    }
    data = menus[0];
  }
  const raw = data.content && data.content.raw ? data.content.raw : "";
  const outFile = process.argv[4];
  if (outFile) {
    fs.writeFileSync(outFile, raw, "utf-8");
  }
  console.log(
    JSON.stringify(
      {
        id: data.id,
        slug: data.slug,
        title: data.title && data.title.raw,
        status: data.status,
        modified: data.modified,
        raw_len: raw.length,
        wrote: outFile || null,
        raw: outFile ? undefined : raw,
      },
      null,
      2
    )
  );
}

async function pushNavigationFromFileCli() {
  const navigationId = process.argv[3];
  const contentFile = process.argv[4];
  if (!navigationId || !contentFile) {
    console.error(
      "Usage: node index-fpx.js push-navigation-from-file <id> <contentFilePath>"
    );
    process.exit(1);
  }
  if (!fs.existsSync(contentFile)) {
    console.error(`File not found: ${contentFile}`);
    process.exit(1);
  }
  const content = fs.readFileSync(contentFile, "utf-8");
  const updated = await wpRawRequest(
    `/wp/v2/navigation/${encodeURIComponent(navigationId)}?context=edit`,
    {
      method: "POST",
      body: JSON.stringify({ content }),
    }
  );
  const raw =
    updated.content && updated.content.raw ? updated.content.raw : "";
  console.log(
    JSON.stringify(
      {
        id: updated.id,
        slug: updated.slug,
        title: updated.title && updated.title.raw,
        status: updated.status,
        modified: updated.modified,
        raw_len: raw.length,
      },
      null,
      2
    )
  );
}

async function createNavigationFromFileCli() {
  const title = process.argv[3];
  const slug = process.argv[4];
  const contentFile = process.argv[5];
  if (!title || !slug || !contentFile) {
    console.error(
      "Usage: node index-fpx.js create-navigation-from-file <title> <slug> <contentFilePath>"
    );
    process.exit(1);
  }
  if (!fs.existsSync(contentFile)) {
    console.error(`File not found: ${contentFile}`);
    process.exit(1);
  }
  const content = fs.readFileSync(contentFile, "utf-8");
  const created = await wpRawRequest("/wp/v2/navigation?context=edit", {
    method: "POST",
    body: JSON.stringify({ title, slug, content, status: "publish" }),
  });
  const raw =
    created.content && created.content.raw ? created.content.raw : "";
  console.log(
    JSON.stringify(
      {
        id: created.id,
        slug: created.slug,
        title: created.title && created.title.raw,
        status: created.status,
        modified: created.modified,
        raw_len: raw.length,
      },
      null,
      2
    )
  );
}

async function listRptCli() {
  const tables = await wpRawRequest(
    "/wp/v2/rpt_pricing_table?per_page=100&context=edit"
  );
  const summary = Array.isArray(tables)
    ? tables.map((t) => ({
        id: t.id,
        slug: t.slug,
        title: t.title && t.title.rendered,
        status: t.status,
      }))
    : tables;
  console.log(JSON.stringify(summary, null, 2));
}

async function getRptCli() {
  const slugOrId = process.argv[3];
  if (!slugOrId) {
    console.error("Usage: node index-fpx.js get-rpt <slugOrId> [outFile]");
    process.exit(1);
  }
  let data;
  if (/^\d+$/.test(slugOrId)) {
    data = await wpRawRequest(
      `/wp/v2/rpt_pricing_table/${slugOrId}?context=edit`
    );
  } else {
    const tables = await wpRawRequest(
      `/wp/v2/rpt_pricing_table?slug=${encodeURIComponent(slugOrId)}&context=edit`
    );
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new Error(`RPT not found for slug: ${slugOrId}`);
    }
    data = tables[0];
  }
  const outFile = process.argv[4];
  const payload = {
    id: data.id,
    slug: data.slug,
    title: data.title && data.title.raw,
    status: data.status,
    content: data.content && data.content.raw,
    meta: data.meta || {},
  };
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf-8");
    console.log(
      JSON.stringify(
        {
          id: data.id,
          slug: data.slug,
          wrote: outFile,
          meta_keys: Object.keys(payload.meta),
        },
        null,
        2
      )
    );
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function pushRptFromFileCli() {
  const rptId = process.argv[3];
  const jsonFile = process.argv[4];
  if (!rptId || !jsonFile) {
    console.error(
      "Usage: node index-fpx.js push-rpt-from-file <id> <jsonFilePath>"
    );
    process.exit(1);
  }
  if (!fs.existsSync(jsonFile)) {
    console.error(`File not found: ${jsonFile}`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
  const body = {};
  if (payload.title !== undefined) body.title = payload.title;
  if (payload.content !== undefined) body.content = payload.content;
  if (payload.status !== undefined) body.status = payload.status;
  if (payload.meta !== undefined) body.meta = payload.meta;
  const updated = await wpRawRequest(`/wp/v2/rpt_pricing_table/${rptId}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(
    JSON.stringify(
      {
        id: updated.id,
        slug: updated.slug,
        modified: updated.modified,
        meta_keys: Object.keys(updated.meta || {}),
      },
      null,
      2
    )
  );
}

async function probeRptMetaCli() {
  const rptId = process.argv[3] || "3080";
  const endpoints = [
    `/wp/v2/rpt_pricing_table/${rptId}?context=edit`,
    `/wp/v2/rpt_pricing_table/${rptId}/meta`,
    `/wp/v2/types/rpt_pricing_table`,
  ];
  for (const ep of endpoints) {
    try {
      const data = await wpRawRequest(ep);
      console.log(
        ep,
        JSON.stringify(data, null, 2).slice(0, 4000)
      );
    } catch (err) {
      console.log(ep, "ERROR", err.message.slice(0, 300));
    }
  }
}

async function createRptFromFileCli() {
  const jsonFile = process.argv[3];
  if (!jsonFile) {
    console.error("Usage: node index-fpx.js create-rpt-from-file <jsonFilePath>");
    process.exit(1);
  }
  if (!fs.existsSync(jsonFile)) {
    console.error(`File not found: ${jsonFile}`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
  const created = await wpRawRequest("/wp/v2/rpt_pricing_table", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log(
    JSON.stringify(
      {
        id: created.id,
        slug: created.slug,
        status: created.status,
      },
      null,
      2
    )
  );
}

async function templatePartPrependFaCli() {
  const id = process.argv[3] || "twentytwentyfive//header";
  const data = await wpRawRequest(
    `/wp/v2/template-parts/${encodeURIComponent(id)}?context=edit`
  );
  const raw = data.content && data.content.raw ? data.content.raw : "";
  const block =
    "<!-- wp:html -->\n<link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css\" />\n<!-- /wp:html -->\n\n";
  if (raw.includes("font-awesome/4.7.0")) {
    console.log(JSON.stringify({ changed: false, reason: "already present" }, null, 2));
    return;
  }
  const updated = await wpRawRequest(
    `/wp/v2/template-parts/${encodeURIComponent(id)}?context=edit`,
    {
      method: "POST",
      body: JSON.stringify({ content: block + raw }),
    }
  );
  console.log(
    JSON.stringify(
      {
        changed: true,
        id: updated.id,
        raw_preview: (updated.content && updated.content.raw && updated.content.raw.slice(0, 200)) || null,
      },
      null,
      2
    )
  );
}

async function probeRestCli() {
  const endpoints = [
    "/wp/v2/template-parts?per_page=20&context=edit",
    "/wp/v2/templates?per_page=20&context=edit",
  ];
  for (const ep of endpoints) {
    try {
      const data = await wpRawRequest(ep);
      const summary = Array.isArray(data)
        ? data.map((x) => ({ id: x.id, slug: x.slug, title: x.title && x.title.raw }))
        : data;
      console.log(ep, JSON.stringify(summary, null, 2).slice(0, 2500));
    } catch (err) {
      console.log(ep, "ERROR", err.message.slice(0, 300));
    }
  }
}

async function listBlocksCli() {
  const blocks = await wpRequest(
    "/blocks?per_page=100&status=publish,draft,private&context=edit"
  );
  const summary = Array.isArray(blocks)
    ? blocks.map((data) => ({
        id: data.id,
        title: data.title,
        slug: data.slug,
        status: data.status,
      }))
    : blocks;
  console.log(JSON.stringify(summary, null, 2));
}

async function getBlockCli() {
  const blockId = process.argv[3];
  if (!blockId) {
    console.error("Usage: node index-fpx.js get-block <blockId>");
    process.exit(1);
  }
  const data = await wpRequest(`/blocks/${blockId}?context=edit`);
  const raw = (data.content && data.content.raw) || "";
  console.log(
    JSON.stringify(
      {
        id: data.id,
        title: data.title,
        slug: data.slug,
        status: data.status,
        raw_len: raw.length,
        has_calendly_dom: raw.indexOf("document.addEventListener") !== -1 && raw.indexOf("calendly.event_scheduled") !== -1,
        has_purchase_tracking: raw.indexOf("fpx-purchase-tracking") !== -1,
        raw,
      },
      null,
      2
    )
  );
}

async function pushBlockFromFileCli() {
  const blockId = process.argv[3];
  const contentFile = process.argv[4];
  if (!blockId || !contentFile) {
    console.error("Usage: node index-fpx.js push-block-from-file <blockId> <contentFilePath>");
    process.exit(1);
  }
  if (!fs.existsSync(contentFile)) {
    console.error(`File not found: ${contentFile}`);
    process.exit(1);
  }
  const content = fs.readFileSync(contentFile, "utf-8");
  const block = await wpRequest(`/blocks/${blockId}`, {
    method: "POST",
    body: JSON.stringify({ content, status: "publish" }),
  });
  const raw = block.content && block.content.raw ? block.content.raw : "";
  console.log(
    JSON.stringify(
      {
        id: block.id,
        status: block.status,
        modified: block.modified,
        raw_len: raw.length,
        has_calendly_dom: raw.indexOf("document.addEventListener") !== -1 && raw.indexOf("calendly.event_scheduled") !== -1,
      },
      null,
      2
    )
  );
}

async function getPageCli() {
  const pageId = process.argv[3];
  if (!pageId) {
    console.error("Usage: node index-fpx.js get-page <pageId> [outFile]");
    process.exit(1);
  }
  const data = await wpRequest(`/pages/${pageId}?context=edit`);
  const raw = (data.content && data.content.raw) || "";
  const outFile = process.argv[4];
  if (outFile) {
    fs.writeFileSync(outFile, raw, "utf-8");
    console.log(
      JSON.stringify(
        {
          id: data.id,
          slug: data.slug,
          status: data.status,
          raw_len: raw.length,
          wrote: outFile,
        },
        null,
        2
      )
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        id: data.id,
        slug: data.slug,
        status: data.status,
        link: data.link,
        has_quote_tracking: raw.includes("fpx-quote-tracking"),
        has_purchase_tracking: raw.includes("fpx-purchase-tracking"),
        has_whatsapp_tracking: raw.includes("fpx-whatsapp-tracking"),
        thanks_base: (raw.match(/THANKS_BASE\s*=\s*'([^']+)'/) || [])[1] || null,
        raw_len: raw.length,
        raw,
      },
      null,
      2
    )
  );
}

async function searchRawCli() {
  const needle = process.argv[3];
  if (!needle) {
    console.error("Usage: node index-fpx.js search-raw <needle>");
    process.exit(1);
  }
  const found = [];
  for (let p = 1; p <= 8; p++) {
    const pages = await wpRequest(
      `/pages?per_page=50&page=${p}&status=publish,draft,private&context=edit`
    );
    if (!Array.isArray(pages) || pages.length === 0) break;
    for (const data of pages) {
      const raw = (data.content && data.content.raw) || "";
      if (raw.indexOf(needle) !== -1) {
        found.push({
          id: data.id,
          slug: data.slug,
          status: data.status,
          link: data.link,
        });
      }
    }
    if (pages.length < 50) break;
  }
  console.log(JSON.stringify({ needle, count: found.length, found }, null, 2));
}

const cliCommand = process.argv[2];
if (cliCommand === "get-page") {
  getPageCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "search-raw") {
  searchRawCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "list-blocks") {
  listBlocksCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "get-block") {
  getBlockCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "push-block-from-file") {
  pushBlockFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "push-page-from-file") {
  pushPageFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "custom-css-get") {
  customCssGetCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "custom-css-prepend-fa4") {
  customCssPrependFaCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "batch-aioseo") {
  batchAioseoCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "update-aioseo") {
  updateAioseoCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "patch-zero-prose") {
  patchZeroProseCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "verify-home-icons") {
  verifyHomeIconsCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "template-part-get") {
  templatePartGetCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "push-template-part-from-file") {
  pushTemplatePartFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "get-navigation") {
  getNavigationCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "push-navigation-from-file") {
  pushNavigationFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "create-navigation-from-file") {
  createNavigationFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "list-rpt") {
  listRptCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "get-rpt") {
  getRptCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "push-rpt-from-file") {
  pushRptFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "create-rpt-from-file") {
  createRptFromFileCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "probe-rpt-meta") {
  probeRptMetaCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "template-part-prepend-fa4") {
  templatePartPrependFaCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "probe-rest") {
  probeRestCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "list-plugins") {
  listPluginsCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "inspect-home-html") {
  inspectHomeHtmlCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "list-themes") {
  listThemesCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "find-global-styles") {
  findGlobalStylesCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "global-styles-get") {
  globalStylesGetCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "global-styles-theme") {
  globalStylesThemeCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "global-styles-prepend-fa4") {
  globalStylesPrependFaCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand === "install-plugin") {
  installPluginCli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cliCommand) {
  console.error(`Unknown CLI command: ${cliCommand}`);
  process.exit(1);
} else {
  // Start the server
  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("WordPress MCP Server running on stdio");
  }

  main().catch(console.error);
}
