#!/usr/bin/env node

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("fs");

let META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
try {
  const envFile = process.env.MCP_ENV_FILE;
  if (!META_ACCESS_TOKEN && envFile && fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, "utf-8");
    envContent.split("\n").forEach(line => {
      const match = line.match(/^\s*META_ACCESS_TOKEN\s*=\s*(.*)?\s*$/);
      if (match) {
        META_ACCESS_TOKEN = match[1].trim();
        if (META_ACCESS_TOKEN.startsWith('"') && META_ACCESS_TOKEN.endsWith('"')) {
          META_ACCESS_TOKEN = META_ACCESS_TOKEN.substring(1, META_ACCESS_TOKEN.length - 1);
        }
      }
    });
  }
} catch (e) {
  console.error("Warning: Could not read MCP_ENV_FILE");
}

if (!META_ACCESS_TOKEN) {
  console.error("Missing META_ACCESS_TOKEN in environment.");
  process.exit(1);
}

const GRAPH_API_VERSION = "v19.0";
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Helper to make Graph API requests
async function graphRequest(endpoint, options = {}) {
  const isQuestionMark = endpoint.includes('?');
  const separator = isQuestionMark ? '&' : '?';
  const url = `${BASE_URL}${endpoint}${separator}access_token=${META_ACCESS_TOKEN}`;

  try {
    const response = await fetch(url, options);
    const text = await response.text();
    
    if (!response.ok) {
      throw new Error(`Graph API Error (${response.status}): ${text}`);
    }
    
    if (text) {
        return JSON.parse(text);
    }
    return {};
  } catch (error) {
    throw new Error(`Failed to communicate with Meta Graph API: ${error.message}`);
  }
}

// Create the server
const server = new McpServer({
  name: "meta-ads-mcp-server",
  version: "1.0.0",
});

// Tool: Get Ad Accounts
server.tool(
  "meta_get_ad_accounts",
  "Retrieve a list of Meta Ad Accounts accessible by this token",
  {},
  async () => {
    const data = await graphRequest(`/me/adaccounts?fields=name,account_id,account_status,currency,amount_spent`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Get Campaigns
server.tool(
  "meta_get_campaigns",
  "Retrieve campaigns for a specific Ad Account",
  {
    ad_account_id: z.string().describe("The Ad Account ID (either 'act_12345' or just '12345')"),
    status: z.array(z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"])).optional().describe("Filter by status (e.g. ['ACTIVE'])"),
  },
  async ({ ad_account_id, status }) => {
    const actId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;
    let endpoint = `/${actId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,end_time`;
    
    if (status && status.length > 0) {
      endpoint += `&filtering=[{"field":"effective_status","operator":"IN","value":${JSON.stringify(status)}}]`;
    }

    const data = await graphRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Get Insights
server.tool(
  "meta_get_insights",
  "Retrieve performance insights (spend, clicks, impressions, ROAS) for an ad account or campaign",
  {
    target_id: z.string().describe("The ID of the Ad Account (e.g. 'act_12345') or Campaign ID"),
    date_preset: z.enum(["today", "yesterday", "this_month", "last_month", "last_7d", "last_30d", "maximum"]).optional().describe("Date range (default: last_30d)"),
    level: z.enum(["account", "campaign", "adset", "ad"]).optional().describe("Aggregation level (default: campaign)"),
  },
  async ({ target_id, date_preset = "last_30d", level = "campaign" }) => {
    const id = (target_id.startsWith('act_') || level !== "account") ? target_id : `act_${target_id}`;
    
    // Using simple fields for reporting
    const fields = "campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,actions,purchase_roas";
    const endpoint = `/${id}/insights?fields=${fields}&date_preset=${date_preset}&level=${level}`;

    const data = await graphRequest(endpoint);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Update Campaign
server.tool(
  "meta_update_campaign",
  "Update a campaign (e.g., change status to ACTIVE or PAUSED)",
  {
    campaign_id: z.string().describe("The ID of the campaign to update"),
    status: z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]).optional().describe("The new status of the campaign"),
    daily_budget: z.number().optional().describe("The new daily budget in cents (e.g. 1000 = $10.00)"),
  },
  async ({ campaign_id, status, daily_budget }) => {
    const payload = {};
    if (status) payload.status = status;
    if (daily_budget) payload.daily_budget = daily_budget;

    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No updates provided." }] };
    }

    const params = new URLSearchParams(payload);
    
    const data = await graphRequest(`/${campaign_id}`, {
      method: 'POST',
      body: params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return {
      content: [{ type: "text", text: `Campaign updated successfully:\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

// Tool: Get Businesses
server.tool(
  "meta_get_businesses",
  "Retrieve a list of Meta Businesses accessible by this token",
  {},
  async () => {
    const data = await graphRequest(`/me/businesses?fields=id,name`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Get Catalogs
server.tool(
  "meta_get_catalogs",
  "Retrieve product catalogs owned by a Business",
  {
    business_id: z.string().describe("The ID of the Meta Business"),
  },
  async ({ business_id }) => {
    const data = await graphRequest(`/${business_id}/owned_product_catalogs?fields=id,name`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Get Catalog Diagnostics
server.tool(
  "meta_get_catalog_diagnostics",
  "Retrieve diagnostic issues (errors, warnings) for a product catalog",
  {
    catalog_id: z.string().describe("The ID of the Product Catalog"),
  },
  async ({ catalog_id }) => {
    const data = await graphRequest(`/${catalog_id}/diagnostics`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Duplicate Campaign
server.tool(
  "meta_duplicate_campaign",
  "Duplicate an existing campaign",
  {
    campaign_id: z.string().describe("The ID of the campaign to duplicate"),
  },
  async ({ campaign_id }) => {
    const data = await graphRequest(`/${campaign_id}/copies`, {
      method: 'POST',
      body: new URLSearchParams({ deep_copy: "true" }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return {
      content: [{ type: "text", text: `Campaign duplicated successfully:\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

// Tool: Get Ad Previews
server.tool(
  "meta_get_ad_previews",
  "Retrieve the visual preview (HTML iframe) for an ad",
  {
    ad_id: z.string().describe("The ID of the Ad (not Campaign or AdSet)"),
    ad_format: z.string().optional().describe("E.g., DESKTOP_FEED_STANDARD, MOBILE_FEED_STANDARD (default: DESKTOP_FEED_STANDARD)"),
  },
  async ({ ad_id, ad_format = "DESKTOP_FEED_STANDARD" }) => {
    const data = await graphRequest(`/${ad_id}/previews?ad_format=${ad_format}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Create Campaign
server.tool(
  "meta_create_campaign",
  "Create a new campaign",
  {
    ad_account_id: z.string().describe("The Ad Account ID (e.g. '12345' or 'act_12345')"),
    name: z.string().describe("Name of the campaign"),
    objective: z.enum(["OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_SALES"]).describe("Campaign objective"),
    status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Initial status (default PAUSED)"),
    special_ad_categories: z.array(z.string()).optional().describe("E.g., [] (default empty array)"),
    is_adset_budget_sharing_enabled: z.boolean().optional().describe("Default false"),
    daily_budget: z.number().optional().describe("The daily budget for the campaign in cents (enables CBO)"),
  },
  async ({ ad_account_id, name, objective, status = "PAUSED", special_ad_categories = [], is_adset_budget_sharing_enabled = false, daily_budget }) => {
    const actId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;
    
    const params = {
      name,
      objective,
      status,
      special_ad_categories: JSON.stringify(special_ad_categories)
    };

    if (daily_budget) {
      params.daily_budget = daily_budget.toString();
    } else if (is_adset_budget_sharing_enabled) {
      params.is_adset_budget_sharing_enabled = is_adset_budget_sharing_enabled.toString();
    }

    const payload = new URLSearchParams(params);

    const data = await graphRequest(`/${actId}/campaigns`, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return {
      content: [{ type: "text", text: `Campaign created successfully:\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

// Tool: Create Ad Set
server.tool(
  "meta_create_adset",
  "Create an ad set within a campaign",
  {
    ad_account_id: z.string().describe("The Ad Account ID"),
    campaign_id: z.string().describe("The parent Campaign ID"),
    name: z.string().describe("Name of the ad set"),
    daily_budget: z.number().optional().describe("Daily budget in cents. Optional if CBO is used on campaign."),
    bid_amount: z.number().optional().describe("Bid amount in cents (optional, depends on bid strategy)"),
    billing_event: z.enum(["IMPRESSIONS", "CLICKS", "LINK_CLICKS"]).describe("What you are billed for"),
    optimization_goal: z.enum(["IMPRESSIONS", "REACH", "LINK_CLICKS", "OFFSITE_CONVERSIONS", "LEAD_GENERATION"]).describe("What to optimize for"),
    promoted_object: z.string().optional().describe("JSON string representing promoted object (e.g. {\"page_id\":\"123\"})"),
    targeting: z.string().optional().describe("JSON string of the targeting spec. Required if saved_audience_id is not provided."),
    status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Initial status (default PAUSED)"),
    pixel_id: z.string().optional().describe("Meta Pixel ID for conversion tracking. Will automatically generate promoted_object."),
    custom_event_type: z.string().optional().describe("Event type for the pixel (default: LEAD)"),
    saved_audience_id: z.string().optional().describe("Saved Audience ID to use. Overrides targeting JSON if provided.")
  },
  async ({ ad_account_id, campaign_id, name, daily_budget, bid_amount, billing_event, optimization_goal, promoted_object, targeting, status = "PAUSED", pixel_id, custom_event_type = "LEAD", saved_audience_id }) => {
    const actId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;
    
    let final_promoted_object = promoted_object;
    if (pixel_id) {
      final_promoted_object = JSON.stringify({
        pixel_id: pixel_id,
        custom_event_type: custom_event_type
      });
    }

    let final_targeting = targeting;
    if (saved_audience_id) {
      final_targeting = JSON.stringify({
        saved_audience: { id: saved_audience_id }
      });
    }

    if (!final_targeting) {
      throw new Error("You must provide either 'targeting' JSON or a 'saved_audience_id'.");
    }

    const params = {
      campaign_id,
      name,
      billing_event,
      optimization_goal,
      targeting: final_targeting,
      status
    };
    if (daily_budget) params.daily_budget = daily_budget.toString();
    if (bid_amount) params.bid_amount = bid_amount.toString();
    if (final_promoted_object) params.promoted_object = final_promoted_object;

    const payload = new URLSearchParams(params);

    const data = await graphRequest(`/${actId}/adsets`, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return {
      content: [{ type: "text", text: `Ad Set created successfully:\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

// Tool: Upload Ad Image from local file
server.tool(
  "meta_upload_image",
  "Upload an image from the local filesystem to Meta Ad Account to get an image_hash for ad creation",
  {
    ad_account_id: z.string().describe("The Ad Account ID"),
    local_file_path: z.string().describe("Absolute path to the local image file (e.g., c:/path/to/image.jpg)"),
  },
  async ({ ad_account_id, local_file_path }) => {
    const actId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;
    
    if (!fs.existsSync(local_file_path)) {
      return {
        isError: true,
        content: [{ type: "text", text: `File not found: ${local_file_path}` }],
      };
    }

    const fileBuffer = fs.readFileSync(local_file_path);
    const fileName = local_file_path.split(/[/\\]/).pop();
    
    const formData = new FormData();
    formData.append("filename", new Blob([fileBuffer]), fileName);

    const isQuestionMark = actId.includes('?');
    const separator = isQuestionMark ? '&' : '?';
    const url = `${BASE_URL}/${actId}/adimages${separator}access_token=${META_ACCESS_TOKEN}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData
      });
      const text = await response.text();
      
      if (!response.ok) {
        throw new Error(`Graph API Error (${response.status}): ${text}`);
      }
      
      const data = JSON.parse(text);
      return {
        content: [{ type: "text", text: `Image uploaded successfully:\n${JSON.stringify(data, null, 2)}` }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Upload failed: ${error.message}` }],
      };
    }
  }
);

// Tool: Create Ad
server.tool(
  "meta_create_ad",
  "Create an ad (requires an Ad Set ID and an Ad Creative JSON payload)",
  {
    ad_account_id: z.string().describe("The Ad Account ID"),
    adset_id: z.string().describe("The ID of the parent Ad Set"),
    name: z.string().describe("Name of the Ad"),
    page_id: z.string().describe("The Facebook Page ID associated with the Ad"),
    image_hash: z.string().describe("The image_hash returned from meta_upload_image"),
    link_url: z.string().describe("The destination URL for the ad"),
    message: z.string().describe("The primary text of the ad"),
    headline: z.string().describe("The headline of the ad"),
    description: z.string().optional().describe("The description/sub-headline of the ad"),
    call_to_action_type: z.enum(["LEARN_MORE", "BOOK_TRAVEL", "DOWNLOAD", "SHOP_NOW", "SIGN_UP", "APPLY_NOW", "CONTACT_US"]).describe("The CTA button text type"),
    status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Initial status (default PAUSED)"),
    url_tags: z.string().optional().describe("UTM parameters (e.g. 'utm_source=meta&utm_medium=cpc')"),
    pixel_id: z.string().optional().describe("Meta Pixel ID. Attaches tracking_specs to the ad for offsite conversions.")
  },
  async ({ ad_account_id, adset_id, name, page_id, image_hash, link_url, message, headline, description, call_to_action_type, status = "PAUSED", url_tags, pixel_id }) => {
    const actId = ad_account_id.startsWith('act_') ? ad_account_id : `act_${ad_account_id}`;
    
    // First, create the Ad Creative
    const object_story_spec = {
      page_id: page_id,
      link_data: {
        image_hash: image_hash,
        link: link_url,
        message: message,
        name: headline,
        call_to_action: {
          type: call_to_action_type,
          value: { link: link_url }
        }
      }
    };
    
    if (description) {
      object_story_spec.link_data.description = description;
    }

    const creativePayload = new URLSearchParams({
      name: `${name} - Creative`,
      object_story_spec: JSON.stringify(object_story_spec)
    });

    const creativeData = await graphRequest(`/${actId}/adcreatives`, {
      method: 'POST',
      body: creativePayload,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!creativeData.id) {
      throw new Error(`Failed to create Ad Creative: ${JSON.stringify(creativeData)}`);
    }

    const creative_id = creativeData.id;

    // Second, create the Ad
    const adParams = {
      name,
      adset_id,
      creative: JSON.stringify({ creative_id }),
      status
    };

    if (url_tags) {
      adParams.url_tags = url_tags;
    }

    if (pixel_id) {
      adParams.tracking_specs = JSON.stringify([
        {
          "action.type": ["offsite_conversion"],
          "fb_pixel": [pixel_id]
        }
      ]);
    }

    const adPayload = new URLSearchParams(adParams);

    const adData = await graphRequest(`/${actId}/ads`, {
      method: 'POST',
      body: adPayload,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return {
      content: [{ type: "text", text: `Ad created successfully (Creative ID: ${creative_id}):\n${JSON.stringify(adData, null, 2)}` }],
    };
  }
);

// Tool: Get Ad Sets
server.tool(
  "meta_get_adsets",
  "Retrieve ad sets for a specific Campaign",
  {
    campaign_id: z.string().describe("The ID of the parent Campaign"),
  },
  async ({ campaign_id }) => {
    const data = await graphRequest(`/${campaign_id}/adsets?fields=id,name,status,daily_budget,promoted_object,targeting`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Get Ads
server.tool(
  "meta_get_ads",
  "Retrieve ads for a specific Ad Set",
  {
    adset_id: z.string().describe("The ID of the parent Ad Set"),
  },
  async ({ adset_id }) => {
    const data = await graphRequest(`/${adset_id}/ads?fields=id,name,status,creative{id,object_story_spec,status},ad_review_feedback`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: Update Ad Set
server.tool(
  "meta_update_adset",
  "Update an ad set (status, daily_budget, targeting)",
  {
    adset_id: z.string().describe("The ID of the Ad Set to update"),
    status: z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]).optional().describe("The new status"),
    daily_budget: z.number().optional().describe("The new daily budget in cents"),
    targeting: z.string().optional().describe("JSON string of the new targeting spec"),
  },
  async ({ adset_id, status, daily_budget, targeting }) => {
    const payload = {};
    if (status) payload.status = status;
    if (daily_budget) payload.daily_budget = daily_budget.toString();
    if (targeting) payload.targeting = targeting;

    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No updates provided." }] };
    }

    const params = new URLSearchParams(payload);
    
    const data = await graphRequest(`/${adset_id}`, {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return {
      content: [{ type: "text", text: `Ad Set updated successfully:\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

// Tool: Update Ad
server.tool(
  "meta_update_ad",
  "Update an ad (status, name, or assign a new creative)",
  {
    ad_id: z.string().describe("The ID of the Ad to update"),
    status: z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]).optional().describe("The new status"),
    name: z.string().optional().describe("The new name of the Ad"),
    creative_id: z.string().optional().describe("The ID of the new Creative to assign to this Ad"),
  },
  async ({ ad_id, status, name, creative_id }) => {
    const payload = {};
    if (status) payload.status = status;
    if (name) payload.name = name;
    if (creative_id) payload.creative = JSON.stringify({ creative_id });

    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No updates provided." }] };
    }

    const params = new URLSearchParams(payload);
    
    const data = await graphRequest(`/${ad_id}`, {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return {
      content: [{ type: "text", text: `Ad updated successfully:\n${JSON.stringify(data, null, 2)}` }],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Meta Ads MCP Server running on stdio");
}

main().catch(console.error);
