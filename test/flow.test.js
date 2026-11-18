// Kiểm thử luồng chính ở chế độ simulator + luật dự phòng (không cần API key / Twilio).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "medcall-")), "db.json");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.TWILIO_ACCOUNT_SID;

const { db } = await import("../src/db.js");
const core = await import("../src/core.js");
const { ruleTurn } = await import("../src/agent.js");

let patient;
before(() => {
  db.reset();
  patient = db.insert("patients", { name: "Lan", honorific: "bác", phone: "+84900000001",
    caregiverPhone: "+84900000002", timezone: "Asia/Ho_Chi_Minh" });
  db.insert("medications", { patientId: patient.id, name: "Metformin", dosage: "500mg", times: ["08:00"], active: true });
  db.insert("medications", { patientId: patient.id, name: "Amlodipin", dosage: "5mg", times: ["08:00", "20:00"], active: true });
});

// 08:02 giờ VN = 01:02 UTC
const at = (hhmm, day = "2026-11-18") => new Date(`${day}T${hhmm}:00+07:00`);

test("đến giờ: gộp 2 thuốc cùng giờ vào 1 cuộc gọi, không tạo trùng", async () => {
  await core.tick(at("07:59"));
  assert.equal(db.all("doses").length, 0);
  await core.tick(at("08:02"));
  await core.tick(at("08:03"));
  const doses = db.all("doses");
  assert.equal(doses.length, 1);
  assert.equal(doses[0].medicationIds.length, 2);
  assert.equal(doses[0].status, "calling");
  assert.equal(db.all("calls").length, 1);
});

test("người bệnh hẹn 20 phút -> gọi lại đúng hẹn, rồi xác nhận đã uống", async () => {
  const call = db.all("calls")[0];
  const hello = core.startConversation(call.id);
  assert.match(hello.reply, /Metformin.*Amlodipin/);
  const t1 = await core.handleSpeech(call.id, "để lát nữa 20 phút bác ăn cơm xong đã");
  assert.equal(t1.outcome, "snooze");
  assert.equal(t1.snooze_minutes, 20);
  core.onCallEnded(call.id, "completed");
  const dose = db.all("doses")[0];
  assert.equal(dose.status, "snoozed");
  const wait = (new Date(dose.nextAttemptAt) - Date.now()) / 60000;
  assert.ok(wait > 19 && wait <= 20, `hẹn ${wait} phút`);

  await core.tick(new Date(Date.now() + 21 * 60000));
  const call2 = db.all("calls")[1];
  assert.ok(call2, "phải có cuộc gọi lại");
  assert.match(core.startConversation(call2.id).reply, /gọi lại/);
  const t2 = await core.handleSpeech(call2.id, "bác uống rồi con ơi");
  assert.equal(t2.outcome, "taken");
  assert.equal(t2.end_call, true);
  core.onCallEnded(call2.id, "completed");
  assert.equal(db.all("doses")[0].status, "taken");
});

test("không nghe máy -> gọi lại tối đa MAX_ATTEMPTS rồi đánh dấu lỡ thuốc", async () => {
  await core.tick(at("20:00"));
  const dose = db.find("doses", (d) => d.slot.endsWith("20:00"))[0];
  assert.deepEqual(dose.medicationIds.length, 1);
  let now = Date.now();
  for (let i = 0; i < 3; i++) {
    const call = db.find("calls", (c) => c.doseId === dose.id).at(-1);
    core.onCallEnded(call.id, "no-answer");
    now += 11 * 60000;
    await core.tick(new Date(now));
  }
  assert.equal(db.get("doses", dose.id).status, "missed");
  assert.equal(db.find("calls", (c) => c.doseId === dose.id).length, 3);
});

test("luật dự phòng: cấp cứu, bỏ liều, im lặng", () => {
  const ctx = { honorific: "cô" };
  const say = (text, prior = []) => ruleTurn(ctx, [...prior, { role: "patient", text }]);
  assert.ok(say("cô thấy đau ngực quá").concern);
  assert.equal(say("cô không uống đâu").outcome, "skipped");
  assert.equal(say("").outcome, "pending");
  assert.equal(say("", [{ role: "patient", text: "" }]).outcome, "unclear");
});
