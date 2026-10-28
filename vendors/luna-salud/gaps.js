export function redactVideoLinks(value) {
  if (Array.isArray(value)) return value.map(redactVideoLinks);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "video_call_url") {
      out[key] = child ? "[redacted-video-link]" : child;
    } else {
      out[key] = redactVideoLinks(child);
    }
  }
  return out;
}

export function dryRunResult(method, path, body) {
  return {
    dry_run: true,
    method,
    path,
    body: body ?? null,
  };
}

export function assertNoSingleAddressNotify(args) {
  if (args && args.notifyPatient === true) {
    throw new Error(
      "notifyPatient is refused. A one-address reschedule send does not exist. you need to do this directly: send the new time to one address only."
    );
  }
}

export function appointmentBody(args) {
  const body = {
    patientId: args.patientId,
    staffId: args.staffId,
    serviceId: args.serviceId,
    startTime: args.startTime,
  };
  if (args.locationId) body.locationId = args.locationId;
  if (args.telemedicine === true) body.telemedicine = true;
  return body;
}

export const CLINICAL_TOOLS = [
  "list_appointments",
  "list_patients",
  "get_patient",
  "get_patient_charts",
  "get_biomarkers",
  "get_lab_test_biomarkers",
  "list_lab_tests",
  "get_webhook_config",
];

export const READ_TOOLS = ["list_staff", "list_services", "get_availability"];

export const FORM_TOOLS = ["list_patient_forms", "get_patient_form", "get_patient_form_pdf"];

export const REPORTES_TOOLS = [...READ_TOOLS, ...FORM_TOOLS];

export const BOOKING_TOOLS = [
  ...READ_TOOLS,
  "create_appointment",
  "reschedule_appointment",
];

const PROFILES = new Set(["read", "booking", "clinical", "reportes", "all"]);

export function allowedToolNames(profile = process.env.LUNA_TOOL_PROFILE || "all") {
  if (!PROFILES.has(profile)) return READ_TOOLS;
  if (profile === "read") return READ_TOOLS;
  if (profile === "booking") return BOOKING_TOOLS;
  if (profile === "clinical") return CLINICAL_TOOLS;
  if (profile === "reportes") return REPORTES_TOOLS;
  return [...CLINICAL_TOOLS, ...BOOKING_TOOLS, ...FORM_TOOLS];
}

export function parsePatientFormPdf(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Luna Salud API error: patient form PDF response was not JSON");
  }
}

export function pdfToolErrorText(error) {
  const message = error && typeof error.message === "string" && error.message
    ? error.message
    : "Request failed";
  if (
    message.includes("%PDF") ||
    message.includes("content_base64") ||
    /[A-Za-z0-9+/]{80,}={0,2}/.test(message)
  ) {
    return "Luna Salud API error: patient form PDF could not be read";
  }
  return message;
}

export function writesAreDryRun(args) {
  if (process.env.LUNA_ALLOW_LIVE_WRITES !== "1") return true;
  return !args || args.dry_run !== false;
}

export function rescheduleBody(args) {
  assertNoSingleAddressNotify(args);
  if (!args.startTime && !args.staffId) {
    throw new Error("reschedule_appointment needs startTime, staffId, or both");
  }
  const body = {};
  if (args.startTime) body.startTime = args.startTime;
  if (args.staffId) body.staffId = args.staffId;
  return body;
}
