# Hướng dẫn Triển khai & Vận hành VPS Monitor V1

## 1. Yêu cầu Hệ thống & Kiểm tra Trước Triển khai

### Yêu cầu nền tảng:
- Hệ điều hành: **Ubuntu 24.04 LTS** (hoặc 22.04 LTS).
- Runtime: **Node.js >= 22.0.0** (hỗ trợ `node:sqlite` và `crypto.verify` chuẩn native).
- Bộ nhớ trống tối thiểu: **64MB RAM** (tiến trình thực tế tiêu thụ < 35MB).
- Dung lượng ổ đĩa: **< 100MB** (bao gồm SQLite database 30 ngày).
- Cổng mạng: **Cổng 5050 TCP** (hoặc cổng cấu hình tùy chọn trong file `.env`).
- Gói bổ sung khuyến nghị: `sqlite3` CLI (để hỗ trợ online backup `VACUUM INTO` và `PRAGMA integrity_check`).

### Kiểm tra xung đột trước khi cài đặt:
Trước khi chạy script cài đặt, kiểm tra xung đột cổng và tài nguyên trên máy chủ production:

```bash
# 1. Kiểm tra cổng 5050 đã bị tiến trình nào chiếm dụng chưa:
sudo ss -tulnp | grep ":5050"

# 2. Kiểm tra bộ nhớ RAM khả dụng:
free -m

# 3. Kiểm tra dung lượng ổ cứng:
df -h /
```

---

## 2. Các bước Cài đặt Tự động

### Trên VinaHost (11Ship):
```bash
# 1. Clone repository về thư mục cài đặt:
git clone https://github.com/trungtn87/vps-monitor.git /tmp/vps-monitor
cd /tmp/vps-monitor

# 2. Chạy script cài đặt với quyền root (bảo lưu .git repository):
sudo bash scripts/install.sh vinahost

# 3. Cấu hình các tham số bảo mật và địa chỉ IP trong /opt/vps-monitor/.env:
sudo nano /opt/vps-monitor/.env
```
Các thông số bắt buộc cần cập nhật trong `/opt/vps-monitor/.env`:
- `PEER_URL`: `https://nhanhoa.yourdomain.com:5050` (hoặc IP mạng riêng ảo WireGuard).
- `HEARTBEAT_SECRET`: Một chuỗi bí mật ngẫu nhiên **tối thiểu 32 ký tự** (giống hệt nhau trên cả 2 VPS).
- `DASHBOARD_PASS`: Mật khẩu đăng nhập Web Dashboard (hệ thống fail-closed nếu thiếu).
- `TLS_CERT_PATH` & `TLS_KEY_PATH`: Đường dẫn chứng chỉ SSL Let's Encrypt nếu kích hoạt native HTTPS.
- `DISCORD_WEBHOOK_URL`: Webhook URL của kênh Discord nhận cảnh báo.
- `DISCORD_CHANNEL_ID`: Channel ID Discord cho Bot.
- `EXPIRY_DATE`: Ngày hết hạn gói VPS VinaHost (`YYYY-MM-DD`).
- `PEER_EXPIRY_DATE`: Ngày hết hạn gói VPS Nhân Hòa (`YYYY-MM-DD`).

```bash
# 4. Khởi động dịch vụ:
sudo systemctl start vps-monitor
sudo systemctl status vps-monitor

# 5. Kiểm tra health endpoint:
curl http://127.0.0.1:5050/healthz   # hoặc https://127.0.0.1:5050/healthz
```

---

### Trên Nhân Hòa (AutoTrade):
Thực hiện các bước tương tự nhưng chỉ định profile `nhanhoa`:

```bash
cd /tmp/vps-monitor
sudo bash scripts/install.sh nhanhoa
sudo nano /opt/vps-monitor/.env
```
Các thông số cần cập nhật:
- `PEER_URL`: `https://vinahost.yourdomain.com:5050`
- `HEARTBEAT_SECRET`: Chuỗi bí mật giống hệt như trên VinaHost.
- `APP_HEALTH_URL`: Endpoint health của AutoTrade bot (e.g. `http://127.0.0.1:3000/healthz`).
- Khởi động dịch vụ:
```bash
sudo systemctl start vps-monitor
```

---

## 3. Thiết lập Bảo mật Đường truyền (TLS / HTTPS / VPN)

Để đảm bảo an toàn tuyệt đối khi trao đổi heartbeat giữa hai VPS qua mạng Internet công cộng:

### Cách 1: Native HTTPS tích hợp sẵn (Khuyến nghị nếu có domain)
1. Cài đặt Certbot và lấy chứng chỉ Let's Encrypt cho subdomain của VPS:
   ```bash
   sudo certbot certonly --standalone -d vinahost.yourdomain.com
   ```
2. Cấu hình trong `/opt/vps-monitor/.env`:
   ```ini
   TLS_CERT_PATH=/etc/letsencrypt/live/vinahost.yourdomain.com/fullchain.pem
   TLS_KEY_PATH=/etc/letsencrypt/live/vinahost.yourdomain.com/privkey.pem
   REQUIRE_TLS=true
   ```

### Cách 2: Sử dụng Kênh Mạng Riêng Ảo WireGuard (Point-to-Point VPN)
- Thiết lập tunnel WireGuard giữa VinaHost (`10.8.0.1`) và Nhân Hòa (`10.8.0.2`).
- Cấu hình `HOST=10.8.0.1` và `PEER_URL=http://10.8.0.2:5050`. Toàn bộ lưu lượng được mã hóa ở tầng mạng mà không cần chứng chỉ công cộng.

---

## 4. Quản lý Dịch vụ qua systemd

```bash
# Xem trạng thái dịch vụ:
sudo systemctl status vps-monitor

# Khởi động / Dừng / Khởi động lại:
sudo systemctl start vps-monitor
sudo systemctl stop vps-monitor
sudo systemctl restart vps-monitor

# Xem log thời gian thực:
sudo journalctl -u vps-monitor -f

# Xem 50 dòng log gần nhất:
sudo journalctl -u vps-monitor -n 50
```

---

## 5. Quy trình Cập nhật (Update) An toàn

Script cập nhật tự động tạo một bản snapshot lưu trữ toàn bộ code và database SQLite trước khi tải code mới:

```bash
sudo bash /opt/vps-monitor/scripts/update.sh
```

Quy trình tự động thực hiện:
1. Tạo snapshot tại `/opt/vps-monitor/backups/pre_update_<timestamp>`.
2. Tạo bản sao lưu SQLite nhất quán thông qua `VACUUM INTO` (Finding 6).
3. Kiểm tra sự tồn tại của thư mục `.git` và thực hiện `git fetch && git pull --ff-only` (Finding 5).
4. Phân quyền lại thư mục cho user `vpsmon`.
5. Khởi động lại systemd service `vps-monitor.service`.
6. Tự động kiểm tra HTTP/HTTPS endpoint `/healthz`. Nếu không phản hồi 200, sẽ báo lỗi để rollback.

---

## 6. Quy trình Hoàn tác (Rollback) Khẩn cấp

Nếu bản cập nhật mới gặp lỗi hoặc không qua được healthcheck:

```bash
# Rollback về bản snapshot gần nhất:
sudo bash /opt/vps-monitor/scripts/rollback.sh

# Hoặc rollback về một thư mục snapshot chỉ định:
sudo bash /opt/vps-monitor/scripts/rollback.sh /opt/vps-monitor/backups/pre_update_20261031_120000
```

---

## 7. Sao lưu & Phục hồi Cơ sở dữ liệu SQLite

```bash
# Tạo bản sao lưu database nhất quán giao dịch (Atomic Online Backup):
sudo bash /opt/vps-monitor/scripts/backup.sh

# Phục hồi database và kiểm tra toàn vẹn PRAGMA integrity_check:
sudo bash /opt/vps-monitor/scripts/restore.sh /opt/vps-monitor/backups/monitor_backup_20261031_120000.db
```
