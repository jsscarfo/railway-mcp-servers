import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import {
  allowedToolNames,
  appointmentBody,
  dryRunResult,
  parsePatientFormPdf,
  pdfToolErrorText,
  redactVideoLinks,
  rescheduleBody,
  writesAreDryRun,
} from "./gaps.js";

const API_KEY = process.env.LUNA_SALUD_API_KEY || "";
if (!API_KEY && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.error("LUNA_SALUD_API_KEY is not set; luna-salud will stay up but tools will error.");
}

const BASE_URL = "https://account.lunahealth.app/api";

const server = new Server({
  name: "luna-salud-mcp",
  version: "1.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

async function lunaRequest(endpoint, { method = "GET", params, body, safeParse = false } = {}) {
  if (!API_KEY) {
    throw new Error("LUNA_SALUD_API_KEY is not set");
  }
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.append(key, String(value));
      }
    }
  }
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body: payload });
  if (!response.ok) {
    throw new Error(`Luna Salud API error: ${response.status} ${response.statusText}`);
  }
  if (safeParse) {
    return parsePatientFormPdf(await response.text());
  }
  return response.json();
}

function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(redactVideoLinks(data), null, 2) }],
  };
}

const dryRunSchema = {
  type: "boolean",
  description: "Preview only. Defaults to true. Ignored unless LUNA_ALLOW_LIVE_WRITES=1.",
};

const toolProfile = process.env.LUNA_TOOL_PROFILE || "all";
if (!["read", "booking", "clinical", "reportes", "all"].includes(toolProfile)) {
  console.error("Unknown LUNA_TOOL_PROFILE; exposing the read tools only.");
}
const allowed = new Set(allowedToolNames(toolProfile));

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_appointments",
        description: "List appointments for the organization. Read only.",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "ISO 8601 date string" },
            to: { type: "string", description: "ISO 8601 date string" },
            status: { type: "string", enum: ["NEW", "CANCELED", "COMPLETED", "PENDING", "CONFIRMED"] },
            patientId: { type: "string" },
            rowsPerPage: { type: "number", minimum: 5, maximum: 200 },
            page: { type: "number" },
            sortDir: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
      {
        name: "list_patients",
        description: "List patients in the organization. Read only. Do not dump the list into chat.",
        inputSchema: {
          type: "object",
          properties: {
            active: { type: "boolean" },
            query: { type: "string", description: "Search query over name" },
            rowsPerPage: { type: "number", minimum: 5, maximum: 200 },
            page: { type: "number" },
            sortDir: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
      {
        name: "get_patient",
        description: "Get patient by ID, including the email on the chart. Read only. Does not change active status.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "get_patient_charts",
        description: "Get patient charts. Read only. Do not copy chart item text into chat.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: { type: "string" },
          },
          required: ["patientId"],
        },
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
            limit: { type: "number", minimum: 1, maximum: 100 },
          },
          required: ["patientId"],
        },
      },
      {
        name: "get_lab_test_biomarkers",
        description: "Get biomarkers for a specific lab test",
        inputSchema: {
          type: "object",
          properties: {
            labTestId: { type: "string" },
          },
          required: ["labTestId"],
        },
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
            end_date: { type: "string" },
          },
          required: ["patientId"],
        },
      },
      {
        name: "get_webhook_config",
        description: "Get webhook configuration. Read only. Does not reveal the webhook secret and does not change settings.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_staff",
        description: "List bookable providers and their ids for availability and booking. Read only. Do not paste the roster into chat; resolve one named provider.",
        inputSchema: {
          type: "object",
          properties: {
            serviceId: { type: "string" },
            rowsPerPage: { type: "number" },
            page: { type: "number" },
          },
        },
      },
      {
        name: "list_services",
        description: "List services with duration and price. Read only. Does not change Cuenta → Servicios.",
        inputSchema: {
          type: "object",
          properties: {
            staffId: { type: "string" },
            bookable: { type: "boolean" },
            rowsPerPage: { type: "number" },
            page: { type: "number" },
          },
        },
      },
      {
        name: "get_availability",
        description: "List open slots for one provider and one service on one YYYY-MM-DD day. Read only.",
        inputSchema: {
          type: "object",
          properties: {
            staffId: { type: "string" },
            serviceId: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD in the provider timezone" },
            locationId: { type: "string" },
          },
          required: ["staffId", "serviceId", "date"],
        },
      },
      {
        name: "list_patient_forms",
        description: "List one patient's completed forms, newest first. Metadata only. Read only. Does not return drafts or answers.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: { type: "string" },
            rowsPerPage: { type: "number" },
            page: { type: "number", description: "0-indexed page" },
          },
          required: ["patientId"],
        },
      },
      {
        name: "get_patient_form",
        description: "Get one completed form as JSON: each field's label, value (answer), order, selected options, and vitals. Read only. Signature images are not included.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Completed form id from list_patient_forms" },
          },
          required: ["id"],
        },
      },
      {
        name: "get_patient_form_pdf",
        description: "Get one completed form PDF as base64 in content_base64, not an expiring link. Read only. Do not paste the base64 into chat.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Completed form id from list_patient_forms" },
          },
          required: ["id"],
        },
      },
      {
        name: "create_appointment",
        description: "Book an in-person or online visit (POST /appointments, telemedicine true for online). Dry-run only unless LUNA_ALLOW_LIVE_WRITES=1. A real book notifies the provider in Luna and does not message the patient. The join link is redacted; a person copies it in the UI.",
        inputSchema: {
          type: "object",
          properties: {
            patientId: { type: "string" },
            staffId: { type: "string" },
            serviceId: { type: "string" },
            startTime: { type: "string", description: "ISO 8601 start from get_availability" },
            locationId: { type: "string" },
            telemedicine: { type: "boolean", description: "True for an online visit. Default false." },
            dry_run: dryRunSchema,
          },
          required: ["patientId", "staffId", "serviceId", "startTime"],
        },
      },
      {
        name: "reschedule_appointment",
        description: "Move an in-person visit, change its provider, or both (POST /appointments/{id}/reschedule). Dry-run only unless LUNA_ALLOW_LIVE_WRITES=1. Online visits cannot be moved here. notifyPatient true is refused.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            startTime: { type: "string" },
            staffId: { type: "string" },
            dry_run: dryRunSchema,
          },
          required: ["id"],
        },
      },
    ].filter((tool) => allowed.has(tool.name)),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!allowed.has(request.params.name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool is not on this allowlist: ${request.params.name}`);
    }
    const args = request.params.arguments || {};
    let data;
    switch (request.params.name) {
      case "list_appointments":
        data = await lunaRequest("/appointments", { params: args });
        break;
      case "list_patients":
        data = await lunaRequest("/patients", { params: args });
        break;
      case "get_patient":
        data = await lunaRequest("/patient", { params: args });
        break;
      case "get_patient_charts":
        data = await lunaRequest("/patient-charts", { params: args });
        break;
      case "get_biomarkers":
        data = await lunaRequest("/biomarkers", { params: args });
        break;
      case "get_lab_test_biomarkers":
        data = await lunaRequest("/lab-test-biomarkers", { params: args });
        break;
      case "list_lab_tests":
        data = await lunaRequest("/lab-tests", { params: args });
        break;
      case "get_webhook_config":
        data = await lunaRequest("/webhooks/config");
        break;
      case "list_staff":
        data = await lunaRequest("/staff", { params: args });
        break;
      case "list_services":
        data = await lunaRequest("/services", {
          params: {
            staffId: args.staffId,
            bookable: args.bookable === undefined ? undefined : String(args.bookable),
            rowsPerPage: args.rowsPerPage,
            page: args.page,
          },
        });
        break;
      case "get_availability":
        data = await lunaRequest("/availability", { params: args });
        break;
      case "list_patient_forms":
        data = await lunaRequest("/patient-forms", {
          params: {
            patientId: args.patientId,
            rowsPerPage: args.rowsPerPage,
            page: args.page,
          },
        });
        break;
      case "get_patient_form":
        data = await lunaRequest("/patient-form", { params: { id: args.id } });
        break;
      case "get_patient_form_pdf":
        data = await lunaRequest("/patient-form/pdf", {
          params: { id: args.id },
          safeParse: true,
        });
        break;
      case "create_appointment": {
        const body = appointmentBody(args);
        if (writesAreDryRun(args)) {
          data = dryRunResult("POST", "/appointments", body);
          break;
        }
        data = await lunaRequest("/appointments", { method: "POST", body });
        break;
      }
      case "reschedule_appointment": {
        const body = rescheduleBody(args);
        const path = `/appointments/${encodeURIComponent(args.id)}/reschedule`;
        if (writesAreDryRun(args)) {
          data = dryRunResult("POST", path, body);
          break;
        }
        data = await lunaRequest(path, { method: "POST", body });
        break;
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }

    return textResult(data);
  } catch (error) {
    const message = request.params.name === "get_patient_form_pdf"
      ? pdfToolErrorText(error)
      : (error && error.message ? error.message : "Request failed");
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Luna Salud MCP Server running on stdio");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
