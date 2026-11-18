// Logic nghiệp vụ: tìm liều thuốc đến giờ, tạo cuộc gọi, xử lý kết quả, gọi lại khi lỡ.
import { db } from "./db.js";
import { greeting, nextTurn } from "./agent.js";
import * as phone from "./phone.js";

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3); // số lần gọi tối đa cho 1 liều
const RETRY_MINUTES = Number(process.env.RETRY_MINUTES || 10); // gọi lại sau bao lâu nếu không nghe máy
const LATE_WINDOW_MIN = 30; // server khởi động trễ: chỉ bắt các liều quá giờ <= 30 phút
const MAX_TURNS = 8;
const MAX_SNOOZES = Number(process.env.MAX_SNOOZES || 3);

/** Giờ địa phương của bệnh nhân: { date: "2026-11-18", hm: "08:05", dow: 0..6 } */
export function localNow(timezone, now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, dow };
}

const toMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

/** Chạy định kỳ: tạo liều mới đến giờ + thực hiện các cuộc gọi lại đã hẹn. */
export async function tick(now = new Date()) {
  // 1) Tạo liều mới. Gộp các thuốc cùng giờ của cùng 1 người vào 1 cuộc gọi.
  for (const patient of db.all("patients")) {
    const t = localNow(patient.timezone || "Asia/Ho_Chi_Minh", now);
    const groups = new Map();
    for (const med of db.find("medications", (m) => m.patientId === patient.id && m.active !== false)) {
      if (med.days?.length && !med.days.includes(t.dow)) continue;
      for (const time of med.times || []) {
        const late = toMin(t.hm) - toMin(time);
        if (late < 0 || late > LATE_WINDOW_MIN) continue;
        if (!groups.has(time)) groups.set(time, []);
        groups.get(time).push(med.id);
      }
    }
    for (const [time, medicationIds] of groups) {
      const slot = `${t.date} ${time}`;
      if (db.find("doses", (d) => d.patientId === patient.id && d.slot === slot).length) continue;
      db.insert("doses", {
        patientId: patient.id, medicationIds, slot, status: "due",
        attempts: 0, nextAttemptAt: now.toISOString(), concern: "",
      });
    }
  }

  // 2) Dọn cuộc gọi treo: simulator không ai "nghe máy" sau 60s, hoặc không nhận được callback sau 15 phút.
  for (const c of db.find("calls", (c) => ["queued", "in-progress"].includes(c.status))) {
    const age = now - new Date(c.createdAt);
    if (c.mode === "simulator" && c.status === "queued" && age > 60_000) onCallEnded(c.id, "no-answer");
    else if (age > 15 * 60_000) onCallEnded(c.id, "failed");
  }

  // 3) Gọi các liều đến lượt (liều mới, hoặc đã hẹn gọi lại).
  const due = db.find("doses", (d) =>
    ["due", "snoozed", "retry"].includes(d.status) && new Date(d.nextAttemptAt) <= now);
  for (const dose of due) await placeCall(dose.id).catch((e) => console.error("[call] lỗi:", e.message));
}

export async function placeCall(doseId) {
  const dose = db.get("doses", doseId);
  const patient = db.get("patients", dose.patientId);
  if (dose.attempts >= MAX_ATTEMPTS) return giveUp(dose, "Không liên lạc được sau nhiều lần gọi");

  const wasSnoozed = dose.status === "snoozed";
  db.update("doses", dose.id, { status: "calling", attempts: dose.attempts + 1 });
  const call = db.insert("calls", {
    doseId: dose.id, patientId: patient.id, status: "queued", transcript: [], outcome: null,
    attempt: db.find("calls", (c) => c.doseId === dose.id).length + 1, wasSnoozed, mode: phone.mode(),
  });
  try {
    const sid = await phone.dial({ to: patient.phone, callId: call.id });
    db.update("calls", call.id, { sid });
  } catch (err) {
    db.update("calls", call.id, { status: "failed", error: err.message });
    onCallEnded(call.id, "failed");
  }
  return call;
}

export function contextFor(callId) {
  const call = db.get("calls", callId);
  const dose = db.get("doses", call.doseId);
  const patient = db.get("patients", dose.patientId);
  return {
    call, dose, patient,
    ctx: {
      patientName: patient.name, honorific: patient.honorific || "anh chị",
      notes: patient.notes, attempt: call.attempt, wasSnoozed: call.wasSnoozed,
      medications: dose.medicationIds.map((id) => db.get("medications", id)).filter(Boolean),
    },
  };
}

/** Người nghe vừa bắt máy -> câu chào. */
export function startConversation(callId) {
  const { ctx } = contextFor(callId);
  const text = greeting(ctx);
  db.update("calls", callId, (c) => ({ status: "in-progress", answeredAt: new Date().toISOString(),
    transcript: [...c.transcript, { role: "agent", text }] }));
  return { reply: text, end_call: false };
}

/** Người nghe vừa nói (speech = "" nếu im lặng) -> câu trả lời tiếp theo của agent. */
export async function handleSpeech(callId, speech) {
  const { ctx, call } = contextFor(callId);
  const transcript = [...call.transcript, { role: "patient", text: speech || "" }];
  let turn = await nextTurn(ctx, transcript);
  if (transcript.length >= MAX_TURNS * 2 && !turn.end_call) {
    turn = { ...turn, outcome: "unclear", end_call: true,
      reply: `${turn.reply} Em xin phép gọi lại sau ạ.` };
  }
  db.update("calls", callId, {
    transcript: [...transcript, { role: "agent", text: turn.reply, source: turn.source }],
    outcome: turn.outcome, snoozeMinutes: turn.snooze_minutes,
    concern: [call.concern, turn.concern].filter(Boolean).join(" | "),
  });
  return turn;
}

/** Cuộc gọi kết thúc (Twilio statusCallback hoặc simulator). */
export function onCallEnded(callId, telcoStatus) {
  const call = db.update("calls", callId, { status: telcoStatus, endedAt: new Date().toISOString() });
  const dose = db.get("doses", call.doseId);
  if (!dose || dose.status !== "calling") return;
  const later = (min) => new Date(Date.now() + min * 60_000).toISOString();
  const concern = [dose.concern, call.concern].filter(Boolean).join(" | ");

  switch (call.outcome) {
    case "taken":
      db.update("doses", dose.id, { status: "taken", takenAt: new Date().toISOString(), concern });
      break;
    case "skipped":
      db.update("doses", dose.id, { status: "skipped", concern });
      notifyCaregiver(dose, `đã báo KHÔNG uống thuốc lúc ${dose.slot}.`);
      break;
    case "snooze":
      if ((dose.snoozes || 0) >= MAX_SNOOZES) { giveUp(dose, `Đã hoãn ${MAX_SNOOZES} lần`); break; }
      // Hẹn gọi lại không tính vào số lần "gọi lỡ".
      db.update("doses", dose.id, { status: "snoozed", nextAttemptAt: later(call.snoozeMinutes || 15),
        attempts: Math.max(0, dose.attempts - 1), snoozes: (dose.snoozes || 0) + 1, concern });
      break;
    default: // không nghe máy, bận, hộp thư, nói chuyện không rõ...
      if (dose.attempts >= MAX_ATTEMPTS) giveUp(dose, "Không xác nhận được việc uống thuốc");
      else db.update("doses", dose.id, { status: "retry", nextAttemptAt: later(RETRY_MINUTES), concern });
  }
  if (call.concern) notifyCaregiver(dose, `có ghi chú cần chú ý: ${call.concern}`);
}

function giveUp(dose, reason) {
  db.update("doses", dose.id, { status: "missed", concern: [dose.concern, reason].filter(Boolean).join(" | ") });
  notifyCaregiver(dose, `chưa xác nhận uống thuốc lúc ${dose.slot} (${reason}).`);
}

function notifyCaregiver(dose, what) {
  const patient = db.get("patients", dose.patientId);
  if (!patient?.caregiverPhone) return;
  const body = `[${process.env.CLINIC_NAME || "MedCall"}] ${patient.honorific || ""} ${patient.name} ${what}`.replace(/\s+/g, " ");
  phone.sms({ to: patient.caregiverPhone, body }).catch((e) => console.error("[sms] lỗi:", e.message));
}
