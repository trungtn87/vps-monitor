# Hướng dẫn Triển khai & Vận hành VPS Monitor V1

## 1. Yêu cầu Hệ thống & Kiểm tra Trước Triển khai

### Yêu cầu nền tảng:
- Hệ điều hành: **Ubuntu 24.04 LTS** (hoặc 22.04 LTS).
- Runtime: **Node.js >= 22.0.0** (hỗ trợ `node:sqlite` và `crypto.verify` chuẩn native).
- Bộ nhớ trống tối thiểu: **64MB RAM** (process thực tế tiêu thụ < 35MB).
- Dung lượng ổ đĩa: **< 100MB** (bao gồm SQLite database 30 ngày).
- Cổng mạng: **Cổng 5050 TCP** (hoặc cổng cấu hình tùy chọn trong file `.env`).

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
# 1. Clone repository về thư mục tạm hoặc trực tiếp:
git clone https://github.com/trungtn87/vps-monitor.git /tmp/vps-monitor
cd /tmp/vps-monitor

# 2. Chạy script cài đặt với quyền root:
sudo bash scripts/install.sh vinahost

# 3. Cấu hình các tham số bảo mật và địa chỉ IP trong /opt/vps-monitor/.env:
sudo nano /opt/vps-monitor/.env
```
Các thông số cần cập nhật trong `/opt/vps-monitor/.env`:
- `PEER_URL`: `http://<IP_NHANHOA>:5050`
- `HEARTBEAT_SECRET`: Một chuỗi bí mật ngẫu nhiên tối thiểu 32 ký tự (giống nhau trên cả 2 VPS).
- `DASHBOARD_PASS`: Mật khẩu đăng nhập Web Dashboard.
- `DISCORD_WEBHOOK_URL`: Webhook URL của kênh Discord nhận cảnh báo.
- `EXPIRY_DATE`: Ngày hết hạn gói VPS VinaHost (`YYYY-MM-DD`).
- `PEER_EXPIRY_DATE`: Ngày hết hạn gói VPS Nhân Hòa (`YYYY-MM-DD`).

```bash
# 4. Khởi động dịch vụ:
sudo systemctl start vps-monitor
sudo systemctl status vps-monitor

# 5. Kiểm tra health endpoint:
curl http://127.0.0.1:5050/healthz
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
- `PEER_URL`: `http://<IP_VINAHOST>:5050`
- `HEARTBEAT_SECRET`: Chuỗi bí mật giống hệt như trên VinaHost.
- `APP_HEALTH_URL`: Endpoint health của AutoTrade bot (e.g. `http://127.0.0.1:3000/healthz`).
- Khởi động dịch vụ:
```bash
sudo systemctl start vps-monitor
```

---

## 3. Quản lý Dịch vụ qua systemd

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

## 4. Quy trình Cập nhật (Update) An toàn

Script cập nhật tự động tạo một bản snapshot lưu trữ toàn bộ code và database SQLite trước khi tải code mới:

```bash
sudo bash /opt/vps-monitor/scripts/update.sh
```

Quy trình tự động thực hiện:
1. Tạo snapshot tại `/opt/vps-monitor/backups/pre_update_<timestamp>`.
2. `git pull --ff-only` tải phiên bản mới nhất từ nhánh `main`.
3. Phân quyền lại thư mục cho user `vpsmon`.
4. Khởi động lại systemd service `vps-monitor.service`.
5. Tự động kiểm tra HTTP endpoint `/healthz`. Nếu không phản hồi 200, sẽ báo lỗi để rollback.

---

## 5. Quy trình Hoàn tác (Rollback) Khẩn cấp

Nếu bản cập nhật mới gặp lỗi hoặc không qua được healthcheck:

```bash
# Rollback về bản snapshot gần nhất:
sudo bash /opt/vps-monitor/scripts/rollback.sh

# Hoặc rollback về một thư mục snapshot chỉ định:
sudo bash /opt/vps-monitor/scripts/rollback.sh /opt/vps-monitor/backups/pre_update_20261031_120000
```

---

## 6. Sao lưu & Phục hồi Cơ sở dữ liệu SQLite

```bash
# Tạo bản sao lưu database độc lập:
sudo bash /opt/vps-monitor/scripts/backup.sh

# Phục hồi database từ bản sao lưu:
sudo bash /opt/vps-monitor/scripts/restore.sh /opt/vps-monitor/backups/monitor_backup_20261031_120000.db
```
