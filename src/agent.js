// "Nhân viên" AI nói chuyện qua điện thoại. Mỗi lượt: đọc hội thoại -> trả về câu nói tiếp theo + kết quả.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = process.env.CLAUDE_EFFORT || "low"; // gọi điện cần phản hồi nhanh
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 9000); // Twilio chờ webhook tối đa ~15s
const AGENT_NAME = process.env.AGENT_NAME || "Thu Hà";
const CLINIC_NAME = process.env.CLINIC_NAME || "MedCall";

const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasClaude ? new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 }) : null;

export const OUTCOMES = ["pending", "taken", "snooze", "skipped", "unclear"];

const SYSTEM = `Bạn là ${AGENT_NAME}, nhân viên chăm sóc khách hàng của ${CLINIC_NAME}, đang GỌI ĐIỆN THOẠI để nhắc người bệnh uống thuốc đúng giờ.

Cách nói chuyện:
- Tiếng Việt, lễ phép, ấm áp như một nhân viên thật. Xưng "em", gọi người nghe theo danh xưng được cung cấp (ví dụ "bác", "cô", "anh").
- Câu ngắn, tự nhiên, dễ nghe qua điện thoại. Mỗi lượt tối đa 2-3 câu. Không dùng ký hiệu, gạch đầu dòng, emoji, chữ viết tắt.
- Đọc số và đơn vị bằng chữ khi cần (ví dụ "năm trăm mi li gam").

Nhiệm vụ:
1. Nhắc đúng tên thuốc, liều và cách dùng đã được kê. Hỏi người bệnh đã uống chưa.
2. Nếu họ nói đã uống hoặc sẽ uống ngay bây giờ: cảm ơn, chúc sức khoẻ, kết thúc cuộc gọi (outcome "taken").
3. Nếu họ muốn uống sau / đang bận: hỏi hoặc đề xuất bao nhiêu phút nữa gọi lại (mặc định 15 phút, tối đa 120), xác nhận rồi kết thúc (outcome "snooze", điền snooze_minutes).
4. Nếu họ nói không uống / bỏ liều: nhẹ nhàng hỏi lý do một lần. Nếu vẫn không uống thì tôn trọng, khuyên trao đổi với bác sĩ, kết thúc (outcome "skipped").
5. Nếu nghe không rõ hoặc họ im lặng: hỏi lại ngắn gọn (outcome "pending"). Sau 2 lần không rõ thì xin phép gọi lại sau và kết thúc (outcome "unclear").

An toàn:
- KHÔNG tự ý thay đổi liều, KHÔNG khuyên thêm thuốc khác, KHÔNG chẩn đoán. Chỉ nhắc đúng đơn thuốc.
- Nếu họ kể triệu chứng bất thường, tác dụng phụ, hoặc hỏi về thay đổi thuốc: ghi vào trường "concern" và khuyên liên hệ bác sĩ.
- Nếu có dấu hiệu cấp cứu (khó thở, đau ngực, ngất, co giật, nói lắp đột ngột...): bảo họ gọi ngay 115 hoặc nhờ người thân hỗ trợ, ghi "concern", kết thúc cuộc gọi.
- Nếu người nghe máy không phải người bệnh: nhờ họ chuyển lời nhắc, rồi kết thúc (outcome "unclear" trừ khi họ xác nhận người bệnh đã uống).

Trả về JSON đúng schema. "reply" là đúng câu bạn sẽ nói ra. end_call=true khi đã chốt kết quả.`;

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    outcome: { type: "string", enum: OUTCOMES },
    snooze_minutes: { type: "integer" },
    concern: { type: "string" },
    end_call: { type: "boolean" },
  },
  required: ["reply", "outcome", "snooze_minutes", "concern", "end_call"],
  additionalProperties: false,
};

/** Câu chào mở đầu: dùng template để người nghe không phải chờ im lặng khi vừa bắt máy. */
export function greeting(ctx) {
  const who = `${ctx.honorific} ${ctx.patientName}`.trim();
  const meds = describeMeds(ctx.medications);
  const retry = ctx.wasSnoozed ? " Em gọi lại như đã hẹn ạ." : ctx.attempt > 1 ? " Lúc nãy em gọi chưa gặp được ạ." : "";
  return `Dạ em chào ${who}, em là ${AGENT_NAME} bên ${CLINIC_NAME}.${retry} Đến giờ uống thuốc rồi ạ: ${meds}. ${cap(ctx.honorific)} đã uống thuốc chưa ạ?`;
}

export function describeMeds(meds) {
  return meds
    .map((m) => [m.name, m.dosage, m.instructions].filter(Boolean).join(", "))
    .join("; ");
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/**
 * Một lượt hội thoại.
 * @param ctx { patientName, honorific, medications, notes, attempt }
 * @param transcript [{ role: "agent" | "patient", text }]
 * @returns { reply, outcome, snooze_minutes, concern, end_call, source }
 */
export async function nextTurn(ctx, transcript) {
  if (client) {
    try {
      return { ...(await claudeTurn(ctx, transcript)), source: "claude" };
    } catch (err) {
      console.error("[agent] Claude lỗi, chuyển sang luật dự phòng:", err?.message || err);
    }
  }
  return { ...ruleTurn(ctx, transcript), source: "rules" };
}

async function claudeTurn(ctx, transcript) {
  const convo = transcript
    .map((t) => `${t.role === "agent" ? "Nhân viên" : "Người nghe"}: ${t.text || "(im lặng / không nghe rõ)"}`)
    .join("\n");

  // Gửi toàn bộ bối cảnh trong MỘT tin nhắn user mỗi lượt (không dựng lại lượt assistant),
  // để không phải chỉnh sửa lịch sử có thinking block.
  const user = `Thông tin người bệnh:
- Tên: ${ctx.patientName}; danh xưng: ${ctx.honorific}
- Thuốc cần uống lúc này: ${describeMeds(ctx.medications)}
- Ghi chú: ${ctx.notes || "không có"}
- Lần gọi thứ: ${ctx.attempt}${ctx.wasSnoozed ? " (gọi lại theo hẹn của người bệnh)" : ""}

Hội thoại đến giờ:
${convo}

Hãy đưa ra câu nói tiếp theo của nhân viên.`;

  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  if (res.stop_reason === "refusal") throw new Error("model refusal");
  if (res.stop_reason === "max_tokens") throw new Error("max_tokens");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return sanitize(JSON.parse(text));
}

function sanitize(out) {
  const outcome = OUTCOMES.includes(out.outcome) ? out.outcome : "pending";
  return {
    reply: String(out.reply || "").trim() || "Dạ, em nghe chưa rõ, mình nói lại giúp em được không ạ?",
    outcome,
    snooze_minutes: Math.min(120, Math.max(5, Number(out.snooze_minutes) || 15)),
    concern: String(out.concern || ""),
    // Đã chốt được kết quả thì luôn kết thúc cuộc gọi.
    end_call: Boolean(out.end_call) || outcome !== "pending",
  };
}

// ---------------- Luật dự phòng (khi không có API key hoặc Claude lỗi/chậm) ----------------
const norm = (s) => (s || "").toLowerCase().normalize("NFC");
const has = (s, words) => words.some((w) => s.includes(w));

export function ruleTurn(ctx, transcript) {
  const last = transcript.at(-1);
  const said = norm(last?.role === "patient" ? last.text : "");
  const h = ctx.honorific || "mình";
  const silentTurns = transcript.filter((t) => t.role === "patient" && !t.text?.trim()).length;
  const base = { snooze_minutes: 15, concern: "" };

  if (has(said, ["khó thở", "đau ngực", "ngất", "co giật", "cấp cứu"])) {
    return { ...base, outcome: "unclear", end_call: true, concern: last.text,
      reply: `Dạ ${h} ơi, nếu đang khó chịu nhiều ${h} gọi ngay một một năm hoặc nhờ người nhà hỗ trợ giúp em nhé. Em sẽ báo người thân của ${h} ạ.` };
  }
  const min = said.match(/(\d+)\s*(phút|tiếng|giờ)/);
  if (has(said, ["lát", "chút nữa", "tí nữa", "sau", "bận", "chưa ăn", "đợi", "chờ"]) || min) {
    let m = min ? Number(min[1]) * (min[2] === "phút" ? 1 : 60) : 15;
    m = Math.min(120, Math.max(5, m));
    return { ...base, outcome: "snooze", snooze_minutes: m, end_call: true,
      reply: `Dạ vâng, vậy ${m} phút nữa em gọi lại nhắc ${h} nhé. Em chào ${h} ạ.` };
  }
  if (has(said, ["không uống", "bỏ", "không muốn", "hết thuốc", "thôi"])) {
    return { ...base, outcome: "skipped", end_call: true, concern: last.text,
      reply: `Dạ em ghi nhận rồi ạ. ${cap(h)} nhớ trao đổi thêm với bác sĩ để được tư vấn nhé. Em chào ${h} ạ.` };
  }
  if (has(said, ["rồi", "uống liền", "uống ngay", "đang uống", "xong", "có uống", "ok", "được"])) {
    return { ...base, outcome: "taken", end_call: true,
      reply: `Dạ tốt quá, em cảm ơn ${h}. Chúc ${h} nhiều sức khoẻ, em chào ${h} ạ.` };
  }
  if (silentTurns >= 2 || transcript.filter((t) => t.role === "patient").length >= 3) {
    return { ...base, outcome: "unclear", end_call: true,
      reply: `Dạ em nghe chưa rõ, chút nữa em gọi lại cho ${h} sau nhé. Em chào ${h} ạ.` };
  }
  return { ...base, outcome: "pending", end_call: false,
    reply: `Dạ ${h} đã uống thuốc chưa ạ? Nếu chưa tiện thì ${h} cho em biết mấy phút nữa em gọi lại nhé.` };
}

export const agentInfo = () => ({ mode: client ? "claude" : "rules", model: client ? MODEL : null });
