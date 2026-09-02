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
const SITE_URL = "https://compasivamente.mx";
const WP_APP_USERNAME = process.env.WP_APP_USERNAME_CMP;
let WP_APP_PASSWORD = process.env.WP_APP_PASSWORD_CMP;

if (!WP_APP_USERNAME || !WP_APP_PASSWORD) {
  console.error("Missing WP_APP_USERNAME_CMP or WP_APP_PASSWORD_CMP in environment.");
  process.exit(1);
}

// Strip whitespace from the password (WP application passwords often have spaces)
WP_APP_PASSWORD = WP_APP_PASSWORD.replace(/\s+/g, '');

// Ensure SITE_URL doesn't have trailing slash
const baseUrl = SITE_URL.replace(/\/$/, "");

// Basic Auth string
const authHeader = "Basic " + Buffer.from(`${WP_APP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');

// Helper to make WP REST API requests
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
    status: z.enum(["publish", "draft", "private"]).optional().describe("Status of the page"),
  },
  async ({ id, title, content, status }) => {
    const payload = {};
    if (title !== undefined) payload.title = title;
    if (content !== undefined) payload.content = content;
    if (status !== undefined) payload.status = status;

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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WordPress MCP Server running on stdio");
}

main().catch(console.error);
