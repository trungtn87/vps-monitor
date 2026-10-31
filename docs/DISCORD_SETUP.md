# Hướng dẫn Thiết lập Discord Bot & Cảnh báo Tự động

VPS Monitor V1 hỗ trợ hai kênh tích hợp với Discord:
1. **Cảnh báo tự động (Automated Alerts):** Sử dụng Discord Webhook (nhanh, nhẹ, độ tin cậy cao, tự động gửi từ VPS còn sống).
2. **Tra cứu tương tác (Slash Commands):** Sử dụng Discord HTTP Interactions với xác thực chữ ký Ed25519 native.

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

### Bước 3: Cấu hình Interactions Endpoint URL
1. Trên Discord Developer Portal tại **General Information**:
2. Tìm ô **Interactions Endpoint URL**.
3. Điền URL trỏ về endpoint của VPS Monitor:
   ```
   https://<TEN_MIEN_HOAC_IP_VPS>:5050/api/discord/interactions
   ```
4. Discord sẽ tự động gửi một gói tin `PING` kèm chữ ký Ed25519 để xác thực. VPS Monitor V1 đã tích hợp sẵn cơ chế kiểm tra Ed25519 và tự động trả về `PONG`, Discord sẽ hiển thị thông báo xác thực thành công.

---

## 3. Quản lý Secret & Bảo mật
- Tất cả token và public key phải được lưu trong file `/opt/vps-monitor/.env` với phân quyền `chmod 600`.
- Tuyệt đối không commit file `.env` chứa token thật lên GitHub repository.
- Các yêu cầu HTTP từ Discord bắt buộc phải có chữ ký Ed25519 hợp lệ; mọi yêu cầu không hợp lệ đều bị từ chối với HTTP 401 Unauthorized.
