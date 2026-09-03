import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.LUNA_SALUD_API_KEY || "";
if (!API_KEY) {
  console.error("LUNA_SALUD_API_KEY is not set; luna-salud will stay up but tools will error.");
}

const BASE_URL = "https://account.lunahealth.app/api";

const server = new Server({
  name: "luna-salud-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

async function lunaFetch(endpoint, params = {}) {
  if (!API_KEY) {
    throw new Error("LUNA_SALUD_API_KEY is not set");
  }
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined) {
      url.searchParams.append(key, String(params[key]));
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Luna Salud API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_appointments",
        description: "List appointments for the organization",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "ISO 8601 date string" },
            to: { type: "string", description: "ISO 8601 date string" },
            status: { type: "string", enum: ["NEW", "CANCELED", "COMPLETED", "PENDING", "CONFIRMED"] },
            patientId: { type: "string" },
            rowsPerPage: { type: "number", minimum: 5, maximum: 200 },
            page: { type: "number" },
            sortDir: { type: "string", enum: ["asc", "desc"] }
          }
        }
      },
      {
        name: "list_patients",
        description: "List patients in the organization",
        inputSchema: {
          type: "object",
          properties: {
            active: { type: "boolean" },
            query: { type: "string", description: "Search query over name" },
            rowsPerPage: { type: "number", minimum: 5, maximum: 200 },
            page: { type: "number" },
            sortDir: { type: "string", enum: ["asc", "desc"] }
          }
        }
      },
      {
        name: "get_patient",
        description: "Get patient by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" }
          },
          required: ["id"]
        }
      },
      {
        name: "get_patient_charts",
        description: "Get patient charts data",
        inputSchema: {
          type: "object",
          properties: {
            patientId: { type: "string" }
          },
          required: ["patientId"]
        }
      },
      {
        name: "get_biomarkers",
        description: "Get a user's biomarkers",
        inputSchema: {
          type: "object",
          properties: {
            patientId: { type: "string" },
            start_date: { type: "string" },
            end_date: { type: "string" },
            status: { type: "string", enum: ["ACCEPTABLE", "CRITICAL", "OPTIMAL", "IN_VERIFICATION"] },
            page: { type: "number" },
            limit: { type: "number", minimum: 1, maximum: 100 }
          },
          required: ["patientId"]
        }
      },
      {
        name: "get_lab_test_biomarkers",
        description: "Get biomarkers for a specific lab test",
        inputSchema: {
          type: "object",
          properties: {
            labTestId: { type: "string" }
          },
          required: ["labTestId"]
        }
      },
      {
        name: "list_lab_tests",
        description: "Get a user's lab tests",
        inputSchema: {
          type: "object",
          properties: {
            patientId: { type: "string" },
            page: { type: "number" },
            limit: { type: "number", minimum: 1, maximum: 100 },
            start_date: { type: "string" },
            end_date: { type: "string" }
          },
          required: ["patientId"]
        }
      },
      {
        name: "get_webhook_config",
        description: "Get webhook configuration",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    let data;
    switch (request.params.name) {
      case "list_appointments":
        data = await lunaFetch("/appointments", request.params.arguments);
        break;
      case "list_patients":
        data = await lunaFetch("/patients", request.params.arguments);
        break;
      case "get_patient":
        data = await lunaFetch("/patient", request.params.arguments);
        break;
      case "get_patient_charts":
        data = await lunaFetch("/patient-charts", request.params.arguments);
        break;
      case "get_biomarkers":
        data = await lunaFetch("/biomarkers", request.params.arguments);
        break;
      case "get_lab_test_biomarkers":
        data = await lunaFetch("/lab-test-biomarkers", request.params.arguments);
        break;
      case "list_lab_tests":
        data = await lunaFetch("/lab-tests", request.params.arguments);
        break;
      case "get_webhook_config":
        data = await lunaFetch("/webhooks/config", request.params.arguments);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Luna Salud MCP Server running on stdio");
}

main().catch(console.error);
