# VPS Monitor V1 — Giám sát Hai Chiều Độc Lập

Hệ thống giám sát hai chiều (cross-monitoring) và cảnh báo tự động độc lập giữa hai máy chủ:
- **VinaHost:** Máy chủ chạy hệ thống **11Ship Production Backend**.
- **Nhân Hòa:** Máy chủ chạy bot giao dịch **AutoTrade BingX**.

Không phụ thuộc bất kỳ máy chủ trung tâm thứ ba hay dịch vụ đám mây bên ngoài (Render, UptimeRobot,...).

---

## 🚀 Tính năng Nổi bật

- **Kiến trúc Đối xứng Độc lập:** Cùng một codebase triển khai trên 2 VPS. Nếu một bên gặp sự cố, bên còn lại vẫn hoạt động bình thường và gửi cảnh báo về Discord.
- **Bảo mật Fail-Closed & TLS:** Bắt buộc mật khẩu/token, cấm truy cập nặc danh; yêu cầu bí mật HMAC tối thiểu 32 ký tự trong production; hỗ trợ native HTTPS/TLS hoặc mạng riêng ảo WireGuard.
- **Hàng đợi Cảnh báo Bền vững (Alert Outbox):** Lưu trữ cảnh báo vào SQLite và retry lũy tiến; đảm bảo không bao giờ mất cảnh báo ngay cả khi Discord gặp sự cố kéo dài.
- **Phát hiện Mất kết nối & Boot-time Grace:**
  - Chuyển sang `DISCONNECTED` khi quá 180 giây không nhận được heartbeat, hoặc hết thời gian khởi động (180s) mà chưa từng nhận được heartbeat từ đối tác.
  - Tự động phát hiện và gửi cảnh báo `RECOVERED` khi kết nối được khôi phục.
- **Giám sát Dịch vụ Ứng dụng:** Probe HTTP endpoint `/healthz` cục bộ của 11Ship hoặc AutoTrade; phân biệt rành mạch giữa sự cố mạng/máy chủ và sự cố ứng dụng.
- **Dashboard Web Hiện đại & Responsive:**
  - Thiết kế mobile-first, giao diện tối (dark mode).
  - Thẻ trực quan cho VinaHost và Nhân Hòa.
  - Biểu đồ biến thiên tài nguyên (CPU & RAM) bằng SVG native không phụ thuộc thư viện ngoài.
  - Đăng nhập bảo vệ bằng HTTP Basic Auth hoặc Bearer Token (fail-closed).
- **Discord Bot & Cảnh báo Tự động:**
  - Tự động gửi cảnh báo khẩn cấp (mất kết nối, phục hồi, app sập, tài nguyên vượt 85%, sắp hết hạn VPS).
  - Cảnh báo thời hạn VPS đúng 5 mốc (30, 15, 7, 3, 1 ngày) và quá hạn, không lặp lại hàng ngày.
  - Tra cứu trạng thái qua Slash Commands: `/status`, `/vinahost`, `/nhanhoa`, `/expiry`.
  - Phân quyền người dùng và máy chủ Discord (`DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_GUILD_IDS`).
  - Hỗ trợ xác thực chữ ký Ed25519 native cho Discord HTTP Interactions.
- **Lưu trữ Bền vững & Sao lưu Nhất quán:**
  - Lưu trữ độc lập bằng SQLite (chế độ WAL, foreign keys enabled).
  - Hỗ trợ sao lưu online an toàn (`VACUUM INTO`) và kiểm tra toàn vẹn (`PRAGMA integrity_check`).
  - Tự động cắt tỉa và dọn dẹp dữ liệu cũ sau **30 ngày**.
  - Lưu trạng thái cảnh báo trên đĩa thật để không gửi lặp lại (spam) và khôi phục chính xác sau khi restart service.
- **Vận hành Tiêu chuẩn Ubuntu 24.04:**
  - Chạy dưới người dùng hệ thống không đặc quyền `vpsmon`.
  - Quản lý qua systemd (`Restart=always`, giới hạn RAM tối đa 256MB).
  - Tích hợp logrotate giới hạn dung lượng log.
  - Bộ script cài đặt, cập nhật an toàn (`update.sh`) kèm snapshot và hoàn tác khẩn cấp (`rollback.sh`).

---

## 📁 Cấu trúc Thư mục

```
vps-monitor/
├── .github/
│   └── workflows/
│       └── ci.yml                     # GitHub Actions CI workflow (Node 22, 24)
├── config/
│   ├── vinahost.env.example           # Mẫu cấu hình môi trường cho VinaHost
│   └── nhanhoa.env.example            # Mẫu cấu hình môi trường cho Nhân Hòa
├── docs/
│   ├── ARCHITECTURE.md                # Tài liệu thiết kế kiến trúc chi tiết
│   ├── DEPLOYMENT.md                  # Hướng dẫn cài đặt, cập nhật và rollback
│   ├── DISCORD_SETUP.md               # Hướng dẫn tạo Bot và cấu hình Webhook
│   └── LIMITATIONS_AND_FUTURE_HA.md   # Giới hạn mô hình 2 VPS & lộ trình HA
├── ops/
│   ├── systemd/
│   │   └── vps-monitor.service        # Systemd unit file kèm giới hạn tài nguyên
│   └── logrotate/
│       └── vps-monitor                # Cấu hình logrotate giới hạn log 50MB
├── scripts/
│   ├── install.sh                     # Script cài đặt tự động cho Ubuntu 24.04
│   ├── update.sh                      # Script cập nhật an toàn kèm snapshot
│   ├── rollback.sh                    # Script hoàn tác về snapshot gần nhất
│   ├── backup.sh                      # Script sao lưu database SQLite
│   └── restore.sh                     # Script phục hồi database SQLite
├── src/
│   ├── agent/
│   │   ├── collector.js               # Thu thập CPU, RAM, Disk, Net, Uptime
│   │   └── appHealth.js               # Kiểm tra sức khỏe HTTP của 11Ship/AutoTrade
│   ├── common/
│   │   ├── config.js                  # Nạp và kiểm tra biến môi trường
│   │   ├── crypto.js                  # HMAC-SHA256, Nonce, Ed25519 signature
│   │   └── logger.js                  # Structured bounded logger (redacts secrets)
│   ├── db/
│   │   ├── schema.sql                 # CSDL SQLite (Server, Service, Metrics, Alert)
│   │   └── database.js                # Quản trị SQLite, truy vấn & dọn dẹp 30 ngày
│   ├── monitor/
│   │   ├── heartbeatClient.js         # Gửi heartbeat sang VPS đối tác
│   │   ├── heartbeatReceiver.js       # Tiếp nhận và xác thực heartbeat từ đối tác
│   │   ├── evaluator.js               # Đánh giá ONLINE/DISCONNECTED/RECOVERED
│   │   └── alertEngine.js             # Máy trạng thái chống spam và điều phối cảnh báo
│   ├── discord/
│   │   ├── notifier.js                # Gửi embed cảnh báo qua Discord Webhook/Bot
│   │   ├── commands.js                # Xử lý nội dung lệnh /status, /vinahost, v.v.
│   │   └── interactions.js            # Tiếp nhận & kiểm tra Ed25519 Discord HTTP
│   ├── web/
│   │   ├── auth.js                    # Basic Auth & Bearer Token Guard
│   │   ├── routes.js                  # Router HTTP API (/healthz, /api/*) & Static
│   │   └── public/                    # Dashboard Web (index.html, style.css, app.js)
│   └── server.js                      # Entrypoint khởi động toàn bộ dịch vụ
├── tests/
│   ├── unit/                          # Unit tests (config, crypto, collector, ...)
│   └── integration/                   # Integration tests & 15 kịch bản bắt buộc
├── package.json
└── README.md
```

---

## 🧪 Kiểm thử (Testing)

Hệ thống có bộ test suite hoàn chỉnh sử dụng `node:test` native, kiểm thử toàn diện **15 kịch bản bắt buộc**:

```bash
# Chạy toàn bộ test suite:
npm test

# Kiểm tra cú pháp:
npm run lint
```

### 15 Kịch bản Kiểm thử Đã Xác thực:
1. ✅ Heartbeat bình thường (<= 60s -> `ONLINE`).
2. ✅ Mất heartbeat trên 180 giây (-> `DISCONNECTED` và phát cảnh báo khẩn cấp).
3. ✅ Heartbeat phục hồi (-> `RECOVERED` và phát thông báo phục hồi).
4. ✅ Agent thu thập lỗi (xử lý an toàn không sập tiến trình).
5. ✅ Monitor Service restart (khôi phục chính xác trạng thái từ SQLite, không spam).
6. ✅ Một VPS ngừng phản hồi (node sống sót phát hiện và gửi cảnh báo).
7. ✅ Mất kết nối mạng một chiều (ghi nhận bất đối xứng chính xác).
8. ✅ Discord API rate limit (429) & lỗi tạm thời (cơ chế retry lũy tiến).
9. ✅ Discord không gửi trùng cảnh báo (chống spam khi trạng thái duy trì).
10. ✅ CPU/RAM/Disk vượt ngưỡng liên tục (cảnh báo khi đạt số chu kỳ cấu hình).
11. ✅ Cảnh báo ngày hết hạn VPS vượt từng mốc (30, 15, 7, 3, 1 ngày).
12. ✅ Dữ liệu heartbeat thiếu hoặc sai cấu trúc (từ chối an toàn với HTTP 400).
13. ✅ API không được xác thực (từ chối với HTTP 401 Unauthorized).
14. ✅ Discord interaction có chữ ký Ed25519 sai (từ chối với HTTP 401).
15. ✅ Tự động dọn dẹp dữ liệu lịch sử quá 30 ngày.

---

## 🛠️ Triển khai Nhanh

Xem tài liệu chi tiết tại [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

```bash
# 1. Cài đặt tự động:
sudo bash scripts/install.sh vinahost   # trên VinaHost
# hoặc
sudo bash scripts/install.sh nhanhoa    # trên Nhân Hòa

# 2. Cấu hình file .env:
sudo nano /opt/vps-monitor/.env

# 3. Khởi động dịch vụ:
sudo systemctl start vps-monitor
```

---

## 🔒 Giấy phép & Phạm vi
- Dự án phát triển cho hạ tầng nội bộ 11Ship & AutoTrade.
- Phiên bản: **V1 (Monitoring & Alerting Only — Không tự động Failover)**.
