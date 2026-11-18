import "dotenv/config";
import express from "express";
import path from "node:path";
import { db } from "./db.js";
import { tick, placeCall, startConversation, handleSpeech, onCallEnded, localNow } from "./core.js";
import { voiceRouter } from "./voice.js";
import { agentInfo } from "./agent.js";
import * as phone from "./phone.js";

const app = express();
app.set("trust proxy", true);
app.use("/voice", voiceRouter);
app.use(express.json());
app.use(express.static(path.resolve("public")));

// Bảo vệ trang quản trị bằng mật khẩu đơn giản (đặt ADMIN_PASSWORD trong .env).
app.use("/api", (req, res, next) => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || req.get("x-admin-password") === pw) return next();
  res.status(401).json({ error: "Sai mật khẩu" });
});

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE = /^\+\d{8,15}$/;

app.get("/api/status", (_req, res) =>
  res.json({ phone: phone.mode(), agent: agentInfo(), now: localNow("Asia/Ho_Chi_Minh") }));

// ---- Bệnh nhân ----
app.get("/api/patients", (_req, res) => res.json(db.all("patients")));
app.post("/api/patients", (req, res) => {
  const { name, honorific = "bác", phone: tel, caregiverPhone = "", timezone = "Asia/Ho_Chi_Minh", notes = "" } = req.body;
  if (!name || !PHONE.test(tel || "")) return res.status(400).json({ error: "Cần tên và số điện thoại dạng +84..." });
  if (caregiverPhone && !PHONE.test(caregiverPhone)) return res.status(400).json({ error: "SĐT người thân phải dạng +84..." });
  res.json(db.insert("patients", { name, honorific, phone: tel, caregiverPhone, timezone, notes }));
});
app.delete("/api/patients/:id", (req, res) => {
  db.find("medications", (m) => m.patientId === req.params.id).forEach((m) => db.remove("medications", m.id));
  res.json({ ok: db.remove("patients", req.params.id) });
});

// ---- Thuốc & lịch ----
app.get("/api/medications", (_req, res) => res.json(db.all("medications")));
app.post("/api/medications", (req, res) => {
  const { patientId, name, dosage = "", instructions = "", times = [], days = [] } = req.body;
  if (!db.get("patients", patientId) || !name) return res.status(400).json({ error: "Thiếu bệnh nhân hoặc tên thuốc" });
  if (!times.length || !times.every((t) => HM.test(t))) return res.status(400).json({ error: "Giờ phải dạng HH:MM" });
  res.json(db.insert("medications", { patientId, name, dosage, instructions, times: [...new Set(times)].sort(), days, active: true }));
});
app.patch("/api/medications/:id", (req, res) => {
  const { active } = req.body;
  res.json(db.update("medications", req.params.id, { active: Boolean(active) }));
});
app.delete("/api/medications/:id", (req, res) => res.json({ ok: db.remove("medications", req.params.id) }));

// ---- Lịch sử ----
app.get("/api/doses", (_req, res) => res.json(db.all("doses").slice(-200).reverse()));
app.get("/api/calls", (_req, res) => res.json(db.all("calls").slice(-200).reverse()));

// Gọi thử ngay cho 1 bệnh nhân với các thuốc đang bật.
app.post("/api/patients/:id/call-now", async (req, res) => {
  const patient = db.get("patients", req.params.id);
  const meds = db.find("medications", (m) => m.patientId === patient?.id && m.active !== false);
  if (!patient || !meds.length) return res.status(400).json({ error: "Bệnh nhân chưa có thuốc nào" });
  const t = localNow(patient.timezone);
  const dose = db.insert("doses", {
    patientId: patient.id, medicationIds: meds.map((m) => m.id), slot: `${t.date} ${t.hm} (gọi thử)`,
    status: "due", attempts: 0, nextAttemptAt: new Date().toISOString(), concern: "",
  });
  res.json(await placeCall(dose.id));
});

// ---- Simulator: "nghe máy" ngay trên trình duyệt khi chưa cấu hình Twilio ----
const simCall = (id) => {
  const c = db.get("calls", id);
  return c && c.mode === "simulator" ? c : null;
};
app.post("/api/sim/:callId/answer", (req, res) => {
  if (!simCall(req.params.callId)) return res.status(404).end();
  res.json(startConversation(req.params.callId));
});
app.post("/api/sim/:callId/say", async (req, res) => {
  if (!simCall(req.params.callId)) return res.status(404).end();
  const turn = await handleSpeech(req.params.callId, String(req.body.text || ""));
  if (turn.end_call) onCallEnded(req.params.callId, "completed");
  res.json(turn);
});
app.post("/api/sim/:callId/hangup", (req, res) => {
  const c = simCall(req.params.callId);
  if (!c) return res.status(404).end();
  onCallEnded(c.id, c.answeredAt ? "completed" : "no-answer");
  res.json({ ok: true });
});

// ---- Bộ lập lịch ----
const TICK_MS = 20_000;
setInterval(() => tick().catch((e) => console.error("[tick]", e)), TICK_MS);
tick().catch((e) => console.error("[tick]", e));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  const a = agentInfo();
  console.log(`MedCall chạy tại http://localhost:${port}`);
  console.log(`  Gọi điện: ${phone.mode()}  |  Agent: ${a.mode}${a.model ? ` (${a.model})` : ""}`);
});
