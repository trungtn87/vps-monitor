# Kiến trúc Hệ thống — VPS Monitor V1

## 1. Tổng quan kiến trúc

VPS Monitor V1 là hệ thống giám sát hai chiều (cross-monitoring) độc lập giữa 2 máy chủ:
- **VinaHost:** Máy chủ chạy dịch vụ **11Ship Production Backend**.
- **Nhân Hòa:** Máy chủ chạy dịch vụ **AutoTrade BingX Bot**.

Hệ thống hoạt động hoàn toàn độc lập, **không phụ thuộc bất kỳ server trung tâm thứ ba hay dịch vụ ngoài** (như Render, UptimeRobot, Datadog,...).

```
   +--------------------------------------------------------------+
   |                     DISCORD CHANNELS                         |
   |   (Cảnh báo qua Webhook/Outbox & Lệnh Slash qua Bot API)     |
   +--------------------------------------------------------------+
              ^                                        ^
              | Outbox Persistent Queue                | Outbox Persistent Queue
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
|   - Alert Outbox (Zero Loss)  |        |   - Alert Outbox (Zero Loss)  |
|   - 30-day Retention Task     |        |   - 30-day Retention Task     |
|                               |        |                               |
| [Dashboard Web UI & API]      |<======>| [Dashboard Web UI & API]      |
|   - Fail-Closed Auth Guard    |  HMAC  |   - Fail-Closed Auth Guard    |
|   - HTTPS / WireGuard (TLS)   |  TLS   |   - HTTPS / WireGuard (TLS)   |
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

2. **Trao đổi Heartbeat hai chiều (60s) qua TLS / Mạng riêng ảo:**
   - VinaHost gửi HTTPS POST `/api/heartbeat` sang Nhân Hòa (kèm metrics cục bộ).
   - Nhân Hòa gửi HTTPS POST `/api/heartbeat` sang VinaHost (kèm metrics cục bộ).
   - Đường truyền bắt buộc phải được mã hóa qua TLS (HTTPS) hoặc mạng riêng ảo WireGuard (Finding 2).
   - Mỗi gói tin heartbeat chứa:
     - `senderId`, `receiverId`, `sequence`, `timestamp`, `nonce`, `metrics`.
     - Chữ ký HMAC-SHA256 tính từ payload và `HEARTBEAT_SECRET` chung (tối thiểu 32 ký tự, fail-closed trong production).
   - Bên nhận kiểm tra:
     - Chữ ký HMAC hợp lệ.
     - Timestamp trong cửa sổ lệch đồng hồ cho phép (<= 300s).
     - Nonce chống phát lại (Replay protection).
     - Ghi nhận `received_at` vào bảng `heartbeat_log` tại máy nhận.

3. **Đánh giá trạng thái kết nối & Startup Grace (Finding 4):**
   - **ONLINE:** Nhận được heartbeat hợp lệ trong vòng <= 180s.
   - **DISCONNECTED:** Quá 180s không nhận được heartbeat từ VPS đối tác, hoặc sau thời gian khởi động (`startupGraceSec` = 180s) mà chưa từng nhận được heartbeat nào.
   - **RECOVERED:** Nhận lại heartbeat sau khi đã ở trạng thái `DISCONNECTED`.
   - **UNKNOWN:** Đang trong cửa sổ khởi động ban đầu (<= 180s) chờ gói heartbeat đầu tiên.

---

## 3. Hàng đợi Giao Cảnh báo Bền vững (Alert Outbox - Finding 3)

Để tránh mất cảnh báo khi Discord gặp sự cố (mất mạng, lỗi máy chủ Discord, bị rate limit 429), hệ thống sử dụng kiến trúc **Transactional Outbox**:
1. Khi có sự cố (mất heartbeat, service down, quá tải tài nguyên), Alert Engine ghi sự kiện vào SQLite và đưa payload cảnh báo vào bảng `alert_outbox` với trạng thái `PENDING`.
2. Tiến trình Outbox Worker thực hiện gửi cảnh báo sang Discord:
   - Nếu gửi thành công: Đánh dấu `DELIVERED`.
   - Nếu gửi thất bại (mạng đứt, Discord 5xx, rate limit): Giữ nguyên trong outbox và lên lịch gửi lại (retry) với thuật toán **Exponential Backoff** (10s, 20s, 40s... tối đa 300s).
3. Đảm bảo cảnh báo **không bao giờ bị mất vĩnh viễn** ngay cả khi Discord ngừng hoạt động hàng giờ.

---

## 4. Phân biệt rõ các kịch bản lỗi

Hệ thống phân biệt rành mạch 4 loại sự cố khác nhau, **không tự kết luận VPS đã sập chỉ từ một lần kiểm tra**:

| Loại sự cố | Biểu hiện kỹ thuật | Phản hồi & Cảnh báo |
|---|---|---|
| **VPS mất heartbeat** | Quá 180s không có heartbeat, hoặc hết grace period 180s khởi động mà không nhận được tin nhắn đầu tiên. | Cảnh báo CRITICAL: `VPS MẤT KẾT NỐI`. VPS còn sống gửi cảnh báo thay mặt. |
| **Dịch vụ App không phản hồi** | Heartbeat VPS vẫn nhận bình thường, nhưng probe HTTP `healthUrl` của 11Ship/AutoTrade trả về 5xx hoặc timeout. | Cảnh báo CRITICAL: `DỊCH VỤ ỨNG DỤNG LỖI` (VPS máy chủ vẫn ONLINE). |
| **Kết nối mạng bị gián đoạn / một chiều** | Node A gửi được sang Node B, nhưng B không gửi được về A. | Trạng thái hiển thị bất đối xứng rõ ràng trên Dashboard của từng node. |
| **Monitor Agent hoặc Service lỗi** | Heartbeat bị từ chối signature hoặc HTTP 500 từ endpoint `/api/heartbeat`. | Ghi log `INVALID_SIGNATURE`, giữ nguyên an toàn cho dịch vụ production. |

---

## 5. Bảo mật và Quyền hạn (Security & Permissions)

1. **Fail-Closed Authentication (Finding 1):**
   - Nếu thiếu mật khẩu hoặc token xác thực, hệ thống **tự động từ chối tất cả yêu cầu** (401 Unauthorized), không cho phép truy cập nặc danh.
   - Trong production, hệ thống từ chối khởi động nếu `HEARTBEAT_SECRET` ngắn hơn 32 ký tự hoặc dùng giá trị mặc định.
2. **Mã hóa đường truyền (Transport Encryption - Finding 2):**
   - Hỗ trợ HTTPS trực tiếp với `TLS_CERT_PATH` và `TLS_KEY_PATH`, hoặc qua Nginx / WireGuard tunnel.
3. **Quyền hạn Discord & Allowlist (Finding 9):**
   - Tách biệt rõ `DISCORD_CHANNEL_ID` và `DISCORD_APP_ID`.
   - Kiểm soát quyền gọi lệnh Slash thông qua danh sách người dùng (`DISCORD_ALLOWED_USER_IDS`) và máy chủ (`DISCORD_ALLOWED_GUILD_IDS`).
4. **Quyền đọc hệ thống (Read-Only):**
   - Tiến trình chạy dưới người dùng hệ thống không có quyền root (`vpsmon`).
   - Tuyệt đối không cho phép shell exec, SSH, restart service, deploy ứng dụng hay thay đổi cấu hình firewall/database.
