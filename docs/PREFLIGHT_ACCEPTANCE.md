# Quy trình Kiểm tra & Nghiệm thu Trước Triển khai (Production Preflight Acceptance Gate)

> **Tài liệu Bắt buộc cho Đợt Triển khai VPS Monitor V1 trên VinaHost (11Ship) và Nhân Hòa (AutoTrade)**  
> Áp dụng theo kết quả review kỹ thuật độc lập đợt 3. Phải hoàn thành và ký xác nhận từng tiêu chí trước khi Owner duyệt merge PR #1 và khởi chạy chính thức trên VPS production.

---

## 1. Mục đích & Nguyên tắc Vận hành

Hệ thống VPS Monitor V1 giám sát độc lập chéo giữa hai node:
- **VinaHost (11Ship)**
- **Nhân Hòa (AutoTrade)**

Để bảo đảm an toàn tuyệt đối cho hệ thống đang chạy của 11Ship và AutoTrade, quá trình cài đặt, nâng cấp và vận hành phải tuân thủ nghiêm ngặt 3 nguyên tắc:
1. **Không can thiệp vào mã nguồn/dữ liệu** của 11Ship và AutoTrade.
2. **Không công khai cổng HTTP nội bộ (5050) ra Internet** khi sử dụng cơ chế TLS Termination qua Nginx reverse proxy.
3. **Mọi thao tác cập nhật (update) và phục hồi (rollback) đều phải có snapshot sao lưu nhất quán (WAL-consistent)** trước khi chạm vào mã nguồn hoặc cơ sở dữ liệu.

---

## 2. Tiêu chuẩn 1: Kiểm tra Môi trường & Hệ điều hành Host

Thực hiện trên cả hai VPS trước khi chạy script cài đặt:

```bash
# 1. Kiểm tra phiên bản Ubuntu (Yêu cầu Ubuntu 22.04 hoặc 24.04 LTS)
lsb_release -d

# 2. Kiểm tra phiên bản Node.js (Yêu cầu Node.js >= 22.0.0 hỗ trợ node:sqlite native)
node -v

# 3. Kiểm tra cổng 5050 chưa bị chiếm dụng
sudo ss -tulnp | grep ":5050"
# (Kết quả phải trống, không có tiến trình nào đang lắng nghe)

# 4. Kiểm tra gói sqlite3 CLI (được khuyến nghị để thực hiện online snapshot)
command -v sqlite3 || sudo apt-get update && sudo apt-get install -y sqlite3
```

- [ ] **Xác nhận Tiêu chuẩn 1:** Ubuntu LTS, Node.js >= 22, cổng 5050 sẵn sàng.

---

## 3. Tiêu chuẩn 2: Thực thi Cài đặt Thực tế (`scripts/install.sh`)

Chạy trực tiếp script cài đặt với quyền `root` (hoặc `sudo`):

```bash
# Trên VinaHost:
cd /tmp
git clone https://github.com/trungtn87/vps-monitor.git
cd /tmp/vps-monitor
sudo bash scripts/install.sh vinahost

# Trên Nhân Hòa:
sudo bash scripts/install.sh nhanhoa
```

**Các điểm kiểm tra bắt buộc sau khi chạy `install.sh`:**
1. Thư mục cài đặt `/opt/vps-monitor` được tạo đầy đủ quyền sở hữu `vpsmon:vpsmon`.
2. Thư mục `.git` được bảo lưu nguyên vẹn tại `/opt/vps-monitor/.git` (phục vụ `update.sh` sau này):
   ```bash
   sudo test -d /opt/vps-monitor/.git && echo "OK: .git preserved"
   ```
3. User hệ thống phi đặc quyền `vpsmon` được tạo (`nologin`):
   ```bash
   id vpsmon
   # uid=... (vpsmon) gid=... (vpsmon) groups=...
   ```
4. File dịch vụ `/etc/systemd/system/vps-monitor.service` được cài đặt và enable.

- [ ] **Xác nhận Tiêu chuẩn 2:** `install.sh` chạy thành công, `.git` bảo toàn, user `vpsmon` hoạt động.

---

## 4. Tiêu chuẩn 3: An toàn Mạng & Nginx TLS Termination (Chống lộ cổng 5050)

> [!CAUTION]
> **RỦI RO AN NINH:** Nếu dịch vụ Node.js lắng nghe trên `0.0.0.0:5050` với `REQUIRE_TLS=false`, toàn bộ API và Dashboard sẽ bị lộ ra Internet không mã hóa, bỏ qua lớp bảo vệ HTTPS của Nginx!

### Bước 4.1: Cấu hình Bắt buộc trong `/opt/vps-monitor/.env`
Khi sử dụng Nginx Reverse Proxy làm cổng kết thúc TLS (khuyến nghị số 1):

```ini
# BẮT BUỘC BIND VÀO LOOPBACK 127.0.0.1 (Hệ thống fail-closed chặn 0.0.0.0 nếu thiếu TLS)
HOST=127.0.0.1
PORT=5050

# Reverse Proxy xử lý TLS ở tầng ngoài, Node.js không cần chứng chỉ trực tiếp
REQUIRE_TLS=false
TLS_CERT_PATH=
TLS_KEY_PATH=
```

### Bước 4.2: Cấu hình Nginx Reverse Proxy
Kích hoạt cấu hình từ repository:
```bash
sudo cp /opt/vps-monitor/ops/nginx/vps-monitor.conf /etc/nginx/sites-available/vps-monitor
sudo ln -sf /etc/nginx/sites-available/vps-monitor /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Bước 4.3: Thiết lập Tường lửa UFW Chặn Truy cập Ngoài vào Port 5050
```bash
# Đảm bảo cổng 5050 bị từ chối từ bên ngoài:
sudo ufw deny 5050/tcp

# Chỉ mở cổng Web chuẩn HTTPS (443) và SSH (22):
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

### Bước 4.4: Lệnh Kiểm chứng Độc lập (Bắt buộc chạy)
```bash
# 1. Kiểm tra cổng 5050 CHỈ lắng nghe trên loopback 127.0.0.1:
sudo ss -tulnp | grep ":5050"
# KẾT QUẢ ĐÚNG:
# tcp LISTEN 0 511 127.0.0.1:5050 0.0.0.0:* users:(("node",pid=...,fd=...))
# (NẾU HIỂN THỊ 0.0.0.0:5050 -> KHÔNG ĐẠT NGHIỆM THU, PHẢI SỬA .env NGAY)

# 2. Thử gọi từ bên ngoài qua IP công khai:
curl -m 3 http://<PUBLIC_IP_VPS>:5050/healthz
# KẾT QUẢ ĐÚNG: Connection refused hoặc Timeout (Do tường lửa chặn và bind 127.0.0.1).

# 3. Thử gọi qua Nginx HTTPS có chứng chỉ Let's Encrypt:
curl -s -k https://monitor.yourdomain.com/healthz
# KẾT QUẢ ĐÚNG: {"status":"UP","service":"vps-monitor",...} (HTTP 200).
```

- [ ] **Xác nhận Tiêu chuẩn 3:** `HOST=127.0.0.1`, cổng 5050 không thể truy cập từ bên ngoài, HTTPS 443 phản hồi UP.

---

## 5. Tiêu chuẩn 4: Nghiệm thu Sao lưu & Khôi phục (`backup.sh` & `restore.sh`)

Kiểm tra khả năng sao lưu snapshot online khi database đang ghi:

```bash
# 1. Chạy script backup trực tiếp:
sudo bash /opt/vps-monitor/scripts/backup.sh

# 2. Kiểm tra file backup được tạo:
ls -lh /opt/vps-monitor/backups/monitor_backup_*.db

# 3. Kiểm tra tính toàn vẹn SQLite snapshot:
LATEST_BAK=$(ls -t /opt/vps-monitor/backups/monitor_backup_*.db | head -1)
sqlite3 "$LATEST_BAK" "PRAGMA integrity_check;"
# KẾT QUẢ BẮT BUỘC: ok

# 4. Kiểm tra script restore phục hồi an toàn:
sudo bash /opt/vps-monitor/scripts/restore.sh "$LATEST_BAK"
# KẾT QUẢ BẮT BUỘC: Service tự động restart và trả về HTTP 200.
```

- [ ] **Xác nhận Tiêu chuẩn 4:** Sao lưu `VACUUM INTO` toàn vẹn (`ok`), khôi phục thành công.

---

## 6. Tiêu chuẩn 5: Nghiệm thu Nâng cấp & Rollback (`update.sh` & `rollback.sh`)

Kiểm tra cơ chế cập nhật không làm gián đoạn hoặc mất dữ liệu:

```bash
# 1. Chạy thử script update:
sudo bash /opt/vps-monitor/scripts/update.sh

# 2. Xác nhận snapshot pre_update được tạo tự động:
ls -td /opt/vps-monitor/backups/pre_update_* | head -1
# Thư mục snapshot phải chứa: monitor.db, package.json, thư mục src/ và .env.bak.

# 3. Chạy thử script rollback khôi phục lại snapshot:
sudo bash /opt/vps-monitor/scripts/rollback.sh
# KẾT QUẢ BẮT BUỘC: Mã nguồn và database được khôi phục, dịch vụ UP (HTTP 200).
```

- [ ] **Xác nhận Tiêu chuẩn 5:** Update tạo snapshot hợp lệ, rollback khôi phục trạng thái hoàn hảo.

---

## 7. Bảng Ký Duyệt Nghiệm thu (Preflight Sign-Off)

Sau khi kỹ sư vận hành thực hiện trực tiếp trên môi trường và kiểm tra đầy đủ 5 tiêu chí:

| Tiêu chuẩn | Người kiểm tra | Kết quả thực tế | Thời gian xác nhận |
| :--- | :--- | :--- | :--- |
| **Tiêu chuẩn 1:** OS Host & Node.js 22+ | | [ ] ĐẠT | |
| **Tiêu chuẩn 2:** `install.sh` & user `vpsmon` | | [ ] ĐẠT | |
| **Tiêu chuẩn 3:** Loopback `127.0.0.1` & Nginx HTTPS | | [ ] ĐẠT | |
| **Tiêu chuẩn 4:** `backup.sh` & `restore.sh` integrity | | [ ] ĐẠT | |
| **Tiêu chuẩn 5:** `update.sh` & `rollback.sh` cycle | | [ ] ĐẠT | |

> **Phê duyệt của Owner:** Chỉ sau khi cả 5 mục trên được đánh dấu ĐẠT, Owner mới tiến hành merge PR #1 và chính thức vận hành giám sát chéo giữa VinaHost và Nhân Hòa.
