# Kiến trúc Hệ thống — VPS Monitor V1

## 1. Tổng quan kiến trúc

VPS Monitor V1 là hệ thống giám sát hai chiều (cross-monitoring) độc lập giữa 2 máy chủ:
- **VinaHost:** Máy chủ chạy dịch vụ **11Ship Production Backend**.
- **Nhân Hòa:** Máy chủ chạy dịch vụ **AutoTrade BingX Bot**.

Hệ thống hoạt động hoàn toàn độc lập, **không phụ thuộc bất kỳ server trung tâm thứ ba hay dịch vụ ngoài** (như Render, UptimeRobot, Datadog,...).

```
   +--------------------------------------------------------------+
   |                     DISCORD CHANNELS                         |
   |   (Cảnh báo tự động qua Webhook & Lệnh Slash qua Bot API)    |
   +--------------------------------------------------------------+
              ^                                        ^
              | Alerts & Commands                      | Alerts & Commands
              v                                        v
+-------------------------------+        +-------------------------------+
|     VINAHOST (11Ship)         |        |     NHÂN HÒA (AutoTrade)      |
|                               |        |                               |
| [Monitor Agent] (Read-only)   |        | [Monitor Agent] (Read-only)   |
|   - CPU, RAM, Disk, Net, Up   |        |   - CPU, RAM, Disk, Net, Up   |
|   - Probe local 11Ship health |        |   - Probe local AutoTrade     |
|                               |        |                               |
| [Monitor Service & SQLite]    |        | [Monitor Service & SQLite]    |
|   - Evaluator & Alert Engine  |        |   - Evaluator & Alert Engine  |
|   - 30-day Retention Task     |        |   - 30-day Retention Task     |
|                               |        |                               |
| [Dashboard Web UI & API]      |<======>| [Dashboard Web UI & API]      |
|   - Auth Guard (Basic/Bearer) |  HMAC  |   - Auth Guard (Basic/Bearer) |
|   - Port 5050 (systemd)       |  TLS   |   - Port 5050 (systemd)       |
+-------------------------------+        +-------------------------------+
```

---

## 2. Luồng dữ liệu và Nguyên lý giám sát hai chiều

1. **Chu kỳ thu thập cục bộ (60s):**
   - Monitor Agent trên mỗi VPS thu thập:
     - CPU (%) từ `/proc/stat`
     - RAM (used/total/%) từ `/proc/meminfo`
     - Disk (used/total/%) qua `statfs`
     - Network RX/TX từ `/proc/net/dev`
     - Uptime từ hệ điều hành
     - App Service Health: probe HTTP endpoint cục bộ (`/healthz`) của 11Ship hoặc AutoTrade.
   - Dữ liệu ghi vào SQLite nội bộ (`node_metrics`, `service_registry`).

2. **Trao đổi Heartbeat hai chiều (60s):**
   - VinaHost gửi HTTP POST `/api/heartbeat` sang Nhân Hòa (kèm metrics cục bộ).
   - Nhân Hòa gửi HTTP POST `/api/heartbeat` sang VinaHost (kèm metrics cục bộ).
   - Mỗi gói tin heartbeat chứa:
     - `senderId`, `receiverId`, `sequence`, `timestamp`, `nonce`, `metrics`.
     - Chữ ký HMAC-SHA256 tính từ payload và `HEARTBEAT_SECRET` chung.
   - Bên nhận kiểm tra:
     - Chữ ký HMAC hợp lệ.
     - Timestamp trong cửa sổ lệch đồng hồ cho phép (<= 300s).
     - Nonce chống phát lại (Replay protection).
     - Ghi nhận `received_at` vào bảng `heartbeat_log` tại máy nhận.

3. **Đánh giá trạng thái kết nối:**
   - **ONLINE:** Nhận được heartbeat hợp lệ trong vòng <= 180s.
   - **DISCONNECTED:** Quá 180s không nhận được heartbeat nào từ VPS đối tác.
   - **RECOVERED:** Nhận lại heartbeat sau khi đã ở trạng thái `DISCONNECTED`.
   - **UNKNOWN:** Khởi động ban đầu khi chưa từng nhận heartbeat.

---

## 3. Phân biệt rõ các kịch bản lỗi

Hệ thống phân biệt rành mạch 4 loại sự cố khác nhau, **không tự kết luận VPS đã sập chỉ từ một lần kiểm tra**:

| Loại sự cố | Biểu hiện kỹ thuật | Phản hồi & Cảnh báo |
|---|---|---|
| **VPS mất heartbeat** | Quá 180s không có bất kỳ heartbeat nào từ VPS đối tác. | Cảnh báo CRITICAL: `VPS MẤT KẾT NỐI`. VPS còn sống gửi cảnh báo thay mặt. |
| **Dịch vụ App không phản hồi** | Heartbeat VPS vẫn nhận bình thường, nhưng probe HTTP `healthUrl` của 11Ship/AutoTrade trả về 5xx hoặc timeout. | Cảnh báo CRITICAL: `DỊCH VỤ ỨNG DỤNG LỖI` (VPS máy chủ vẫn ONLINE). |
| **Kết nối mạng bị gián đoạn / một chiều** | Node A gửi được sang Node B, nhưng B không gửi được về A. | Trạng thái hiển thị bất đối xứng rõ ràng trên Dashboard của từng node. |
| **Monitor Agent hoặc Service lỗi** | Heartbeat bị từ chối signature hoặc HTTP 500 từ endpoint `/api/heartbeat`. | Ghi log `INVALID_SIGNATURE`, giữ nguyên an toàn cho dịch vụ production. |

---

## 4. Bảo mật và Quyền hạn (Security & Permissions)

1. **Quyền đọc hệ thống (Read-Only):**
   - Monitor Agent chạy dưới người dùng hệ thống không có quyền root (`vpsmon`).
   - Tuyệt đối không cho phép shell exec, SSH, restart service, deploy ứng dụng hay thay đổi cấu hình firewall/database.
2. **Không thu thập dữ liệu nhạy cảm:**
   - Hoàn toàn không đọc hoặc lưu trữ mật khẩu, API key BingX, dữ liệu giao dịch hay thông tin người dùng 11Ship.
3. **Bảo vệ Dashboard & API:**
   - Dashboard Web và các API `/api/status`, `/api/metrics`, `/api/events` được bảo vệ bằng Basic Auth hoặc Bearer Token.
   - Header bảo mật: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.
4. **Bảo vệ Heartbeat & Discord:**
   - Heartbeat bảo vệ bằng HMAC-SHA256 với secret bảo mật và chống replay nonce.
   - Discord Interactions bảo vệ bằng chữ ký Ed25519 từ public key của Discord.
