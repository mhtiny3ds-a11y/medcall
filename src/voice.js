// Webhook Twilio Voice: chào -> nghe người bệnh nói (speech-to-text) -> agent trả lời -> lặp lại.
import express from "express";
import twilio from "twilio";
import { startConversation, handleSpeech, onCallEnded } from "./core.js";
import { db } from "./db.js";

const { VoiceResponse } = twilio.twiml;
const VOICE = process.env.TTS_VOICE || "Google.vi-VN-Wavenet-A"; // giọng nữ tiếng Việt
const LANG = "vi-VN";

export const voiceRouter = express.Router();
voiceRouter.use(express.urlencoded({ extended: false }));

// Kiểm tra chữ ký Twilio để không ai giả mạo webhook (tắt bằng TWILIO_VALIDATE=off khi dev).
if (process.env.TWILIO_VALIDATE !== "off" && process.env.TWILIO_AUTH_TOKEN) {
  voiceRouter.use(twilio.webhook()); // cần app.set("trust proxy", true) khi chạy sau ngrok/proxy
}

function speakAndListen(vr, callId, text, endCall) {
  vr.say({ voice: VOICE, language: LANG }, text);
  if (endCall) return vr.hangup();
  const g = vr.gather({
    input: "speech", language: LANG, speechTimeout: "auto", timeout: 6,
    action: `/voice/turn?callId=${callId}`, method: "POST",
    hints: "rồi, chưa, uống rồi, lát nữa, mười lăm phút, không uống",
  });
  g.pause({ length: 1 });
  // Im lặng -> vẫn gọi /voice/turn với SpeechResult rỗng để agent hỏi lại.
  vr.redirect({ method: "POST" }, `/voice/turn?callId=${callId}`);
}

voiceRouter.post("/answer", (req, res) => {
  const { callId } = req.query;
  const vr = new VoiceResponse();
  const answeredBy = req.body.AnsweredBy || "";
  if (!db.get("calls", callId)) {
    vr.hangup();
  } else if (answeredBy.startsWith("machine") || answeredBy === "fax") {
    db.update("calls", callId, { outcome: "voicemail" });
    vr.hangup(); // hộp thư thoại: cúp máy, sẽ gọi lại sau
  } else {
    const { reply } = startConversation(callId);
    speakAndListen(vr, callId, reply, false);
  }
  res.type("text/xml").send(vr.toString());
});

voiceRouter.post("/turn", async (req, res) => {
  const { callId } = req.query;
  const vr = new VoiceResponse();
  if (!db.get("calls", callId)) {
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }
  const turn = await handleSpeech(callId, req.body.SpeechResult || "");
  speakAndListen(vr, callId, turn.reply, turn.end_call);
  res.type("text/xml").send(vr.toString());
});

voiceRouter.post("/status", (req, res) => {
  const { callId } = req.query;
  if (db.get("calls", callId)) onCallEnded(callId, req.body.CallStatus || "completed");
  res.sendStatus(204);
});
