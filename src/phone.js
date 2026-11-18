// Lớp gọi điện: Twilio (gọi thật) hoặc simulator (thử trên trình duyệt, không tốn tiền).
import twilio from "twilio";

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL } = process.env;
const live = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && PUBLIC_BASE_URL);
const client = live ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

export const mode = () => (live ? "twilio" : "simulator");

/** Bắt đầu gọi ra. Trả về call SID. */
export async function dial({ to, callId }) {
  if (!live) {
    console.log(`[simulator] Đang "gọi" ${to} (call ${callId}) — mở giao diện web để nghe máy.`);
    return `SIM-${callId}`;
  }
  const base = PUBLIC_BASE_URL.replace(/\/$/, "");
  const call = await client.calls.create({
    to,
    from: TWILIO_FROM_NUMBER,
    url: `${base}/voice/answer?callId=${callId}`,
    statusCallback: `${base}/voice/status?callId=${callId}`,
    statusCallbackEvent: ["completed"],
    timeout: 30, // đổ chuông 30 giây
    // Phát hiện hộp thư thoại: nếu máy trả lời tự động thì coi như không nghe máy.
    machineDetection: process.env.TWILIO_AMD === "off" ? undefined : "Enable",
  });
  return call.sid;
}

export async function sms({ to, body }) {
  if (!live) return console.log(`[simulator] SMS tới ${to}: ${body}`);
  await client.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
}

export const isLive = () => live;
