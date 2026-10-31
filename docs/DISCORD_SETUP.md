# Hướng dẫn Thiết lập Discord Bot & Cảnh báo Tự động

VPS Monitor V1 hỗ trợ hai kênh tích hợp với Discord:
1. **Cảnh báo tự động (Automated Alerts qua Persistent Outbox):** Sử dụng Discord Webhook hoặc Bot Channel API kèm hàng đợi outbox bền vững chống mất tin.
2. **Tra cứu tương tác (Slash Commands):** Sử dụng Discord HTTP Interactions với xác thực chữ ký Ed25519 native và phân quyền theo User ID / Guild ID.

---

## 1. Thiết lập Cảnh báo Tự động qua Webhook

Đây là kênh cảnh báo quan trọng nhất để nhận thông báo khẩn cấp khi VPS mất kết nối, dịch vụ sập, hoặc tài nguyên vượt ngưỡng.

### Bước 1: Tạo Webhook trên Discord Server
1. Mở Discord trên máy tính hoặc trình duyệt.
2. Vào **Server Settings** > **Integrations** > **Webhooks**.
3. Bấm **New Webhook**.
4. Đặt tên: `VPS Monitor`.
5. Chọn kênh muốn nhận cảnh báo (ví dụ: `#vps-alerts`).
6. Bấm **Copy Webhook URL**.

### Bước 2: Cấu hình Webhook vào file `.env` trên cả hai VPS
Dán URL vừa copy vào biến `DISCORD_WEBHOOK_URL` trong file `/opt/vps-monitor/.env`:
```ini
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz
```

Nếu sử dụng Bot Token để gửi vào channel riêng:
```ini
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CHANNEL_ID=your_text_channel_id_here
```
*(Lưu ý: `DISCORD_CHANNEL_ID` là ID của Channel văn bản, phân biệt hoàn toàn với `DISCORD_APP_ID`)*.

---

## 2. Thiết lập Discord Bot cho Lệnh Slash (/status, /vinahost, /nhanhoa, /expiry)

### Bước 1: Tạo Discord Application
1. Truy cập [Discord Developer Portal](https://discord.com/developers/applications).
2. Bấm **New Application**, đặt tên: `VPS Monitor`.
3. Tại trang **General Information**:
   - Lưu lại **Application ID** -> điền vào `DISCORD_APP_ID`.
   - Lưu lại **Public Key** -> điền vào `DISCORD_PUBLIC_KEY`.
4. Tại trang **Bot**:
   - Bấm **Reset Token** để lấy Bot Token -> điền vào `DISCORD_BOT_TOKEN`.

### Bước 2: Đăng ký các Lệnh Slash (Slash Commands)
Chạy lệnh curl sau để đăng ký các lệnh slash cho Bot (thay thế `YOUR_APP_ID` và `YOUR_BOT_TOKEN`):

```bash
# 1. Lệnh /status
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "status",
    "description": "Xem tổng quan sức khỏe cả hai VPS VinaHost và Nhân Hòa"
  }'

# 2. Lệnh /vinahost
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "vinahost",
    "description": "Xem chi tiết sức khỏe VPS VinaHost (11Ship)"
  }'

# 3. Lệnh /nhanhoa
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nhanhoa",
    "description": "Xem chi tiết sức khỏe VPS Nhân Hòa (AutoTrade)"
  }'

# 4. Lệnh /expiry
curl -X POST https://discord.com/api/v10/applications/YOUR_APP_ID/commands \
  -H "Authorization: Bot YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "expiry",
    "description": "Xem thời hạn và số ngày còn lại của hai VPS"
  }'
```

### Bước 3: Cấu hình Interactions Endpoint URL (Yêu cầu HTTPS công cộng)
Discord bắt buộc endpoint nhận lệnh tương tác phải chạy **HTTPS hợp lệ** (không chấp nhận self-signed):
1. Cấu hình HTTPS (Let's Encrypt hoặc Cloudflare tunnel / Nginx reverse proxy) trỏ về port 5050.
2. Trên Discord Developer Portal tại **General Information**:
3. Điền URL:
   ```
   https://vinahost.yourdomain.com:5050/api/discord/interactions
   ```
4. Discord sẽ tự động gửi gói tin `PING` kèm chữ ký Ed25519. VPS Monitor V1 đã tích hợp sẵn cơ chế kiểm tra Ed25519 và tự động trả về `PONG`, Discord sẽ hiển thị thông báo xác thực thành công.

---

## 3. Phân quyền & Bảo mật Lệnh Slash (Finding 9)
Để ngăn chặn người lạ trong Discord Server gọi lệnh và xem thông tin máy chủ:
Trong file `/opt/vps-monitor/.env`, cấu hình danh sách ID được phép:
```ini
# Chỉ cho phép các User ID cụ thể (ví dụ ID của Owner / Lead)
DISCORD_ALLOWED_USER_IDS=123456789012345678,987654321098765432

# Chỉ cho phép chạy trên Server/Guild Discord nội bộ của team
DISCORD_ALLOWED_GUILD_IDS=112233445566778899
```
Mọi yêu cầu gọi lệnh từ người dùng hoặc server không có trong danh sách sẽ bị từ chối với thông báo `⛔ Bạn không có quyền thực hiện lệnh này.`
