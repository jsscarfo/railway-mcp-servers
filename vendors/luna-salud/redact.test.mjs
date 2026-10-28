import assert from "node:assert/strict";
import {
  allowedToolNames,
  appointmentBody,
  dryRunResult,
  redactVideoLinks,
  rescheduleBody,
  writesAreDryRun,
} from "./gaps.js";

const redacted = redactVideoLinks({
  video_call_url: "https://example.invalid/join/secret",
  nested: [{ video_call_url: null }, { video_call_url: "https://example.invalid/other" }],
});
assert.equal(redacted.video_call_url, "[redacted-video-link]");
assert.equal(redacted.nested[0].video_call_url, null);
assert.equal(redacted.nested[1].video_call_url, "[redacted-video-link]");

const preview = dryRunResult("POST", "/appointments", { telemedicine: true });
assert.equal(preview.dry_run, true);
assert.equal(preview.method, "POST");
assert.equal(preview.body.telemedicine, true);

const booked = appointmentBody({
  patientId: "p",
  staffId: "s",
  serviceId: "svc",
  startTime: "2026-11-01T15:00:00-06:00",
  telemedicine: true,
});
assert.equal(booked.telemedicine, true);
assert.equal("reasonForVisit" in booked, false);

const moved = rescheduleBody({ id: "a", startTime: "2026-11-02T15:00:00-06:00" });
assert.equal(moved.notifyPatient, undefined);
assert.throws(() => rescheduleBody({ id: "a", notifyPatient: true, startTime: "2026-11-02T15:00:00-06:00" }), /one-address/);
assert.throws(() => rescheduleBody({ id: "a" }), /startTime/);

assert.deepEqual(allowedToolNames("booking"), [
  "list_staff",
  "list_services",
  "get_availability",
  "create_appointment",
  "reschedule_appointment",
]);
assert.deepEqual(allowedToolNames("read"), ["list_staff", "list_services", "get_availability"]);
assert.equal(allowedToolNames("read").includes("create_appointment"), false);
assert.equal(allowedToolNames("reportes").includes("list_patients"), false);
assert.equal(allowedToolNames("all").includes("list_appointments"), true);
assert.equal(allowedToolNames("all").includes("create_appointment"), true);

const previousLive = process.env.LUNA_ALLOW_LIVE_WRITES;
delete process.env.LUNA_ALLOW_LIVE_WRITES;
assert.equal(writesAreDryRun({ dry_run: false }), true);
process.env.LUNA_ALLOW_LIVE_WRITES = "1";
assert.equal(writesAreDryRun({ dry_run: false }), false);
assert.equal(writesAreDryRun({}), true);
if (previousLive === undefined) delete process.env.LUNA_ALLOW_LIVE_WRITES;
else process.env.LUNA_ALLOW_LIVE_WRITES = previousLive;

console.log("luna-salud redact tests passed");
