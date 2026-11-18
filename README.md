# MedCall – Nhắc uống thuốc bằng cuộc gọi AI

Đến đúng giờ uống thuốc, một "nhân viên" AI **gọi điện** cho người bệnh (thay vì push notification),
nói chuyện bằng tiếng Việt, hỏi đã uống chưa và xử lý câu trả lời:

| Người bệnh nói | App làm gì |
|---|---|
| "Uống rồi" / "uống liền đây" | Ghi **Đã uống**, chào và cúp máy |
| "Lát nữa", "20 phút nữa", "chưa ăn cơm" | Hẹn và **tự gọi lại** đúng số phút đó |
| "Không uống" | Hỏi nhẹ lý do, ghi **Bỏ liều**, SMS cho người thân |
| Không nghe máy / hộp thư thoại | Gọi lại sau 10 phút, tối đa 3 lần, sau đó SMS cho người thân |
| Kể triệu chứng lạ, dấu hiệu cấp cứu | Khuyên gọi bác sĩ / 115, ghi chú và báo người thân |

Nhiều thuốc cùng giờ được gộp vào **một** cuộc gọi. Agent không bao giờ tự đổi liều hay khuyên thêm thuốc.

## Chạy thử (không cần tài khoản nào)

```bash
npm install
npm start          # http://localhost:3000
```

Không có key thì app chạy ở **chế độ giả lập**: bấm "Gọi thử ngay", một cửa sổ cuộc gọi đến hiện lên
trên web. Bạn nghe máy, gõ hoặc nói (🎤, Chrome) để trả lời, trình duyệt đọc to câu của nhân viên.

## Bật AI thật (Claude)

Đặt `ANTHROPIC_API_KEY` trong `.env` (copy từ `.env.example`). Mỗi lượt nói, Claude nhận toàn bộ hội thoại
và trả về JSON: `{reply, outcome, snooze_minutes, concern, end_call}`. Nếu Claude lỗi/chậm quá 9 giây,
app tự dùng luật dự phòng để người nghe không phải chờ im lặng.

## Gọi điện thật (Twilio)

1. Tạo tài khoản Twilio, mua số, bật **Geo Permissions → Vietnam** cho cuộc gọi đi và SMS.
2. Mở server ra Internet, ví dụ `ngrok http 3000`, rồi đặt `PUBLIC_BASE_URL`.
3. Điền `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` vào `.env`, rồi chạy lại.

Luồng cuộc gọi: `calls.create` → `/voice/answer` (câu chào + `<Gather input="speech" language="vi-VN">`)
→ `/voice/turn` (Claude trả lời, lặp lại) → `/voice/status` (ghi kết quả, hẹn gọi lại nếu cần).

## Cấu trúc

```
src/server.js   API quản trị, simulator, bộ lập lịch (20 giây/lần)
src/core.js     Nghiệp vụ: tìm liều đến giờ, gọi, gọi lại, báo người thân
src/agent.js    Nhân viên AI (Claude) + luật dự phòng
src/voice.js    Webhook Twilio Voice (TwiML)
src/phone.js    Twilio hoặc giả lập
src/db.js       Lưu dữ liệu vào data/db.json
public/         Giao diện web
test/           npm test
```

## Trước khi dùng thật

- Dữ liệu sức khoẻ là dữ liệu nhạy cảm: đặt `ADMIN_PASSWORD`, chạy HTTPS, cân nhắc chuyển sang Postgres.
- Cần sự đồng ý của người bệnh khi gọi và ghi lại nội dung cuộc gọi.
- Đây là công cụ nhắc nhở, không thay thế tư vấn y tế.
