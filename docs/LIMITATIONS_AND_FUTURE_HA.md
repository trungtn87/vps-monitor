# Giới hạn Mô hình 2 VPS & Định hướng Mở rộng HA Tương lai

## 1. Những Giới hạn Thực tế của Mô hình 2 VPS

Trong lý thuyết hệ thống phân tán (CAP Theorem, FLP Impossibility), một hệ thống chỉ gồm 2 node đối xứng đối mặt với các giới hạn kỹ thuật cố hữu:

### 1.1. Vấn đề "Split-Brain" (Phân mảnh não) khi xảy ra gián đoạn mạng
- Nếu đường truyền mạng giữa VinaHost và Nhân Hòa bị đứt (Network Partition) nhưng cả 2 VPS vẫn đang chạy bình thường:
  - VinaHost sẽ thấy Nhân Hòa "mất tích" (>180s).
  - Nhân Hòa cũng sẽ thấy VinaHost "mất tích" (>180s).
- Vì **không có bên thứ 3 (Witness / Quorum / Tie-breaker)**, không node nào có thể xác định một cách chắc chắn xem:
  * Đối tác đã thực sự sập nguồn?
  * Hay đối tác vẫn sống nhưng chỉ mất đường truyền trực tiếp giữa hai bên?

### 1.2. Lý do V1 KHÔNG triển khai Auto-Failover
- Nếu triển khai auto-failover trong mô hình 2 node mà không có fencing hoặc witness:
  - Khi mất kết nối mạng, cả 2 node đều tự cho rằng mình là node sống sót duy nhất và tự động kích hoạt dịch vụ của bên kia (ví dụ Nhân Hòa tự khởi động 11Ship, hoặc VinaHost tự kích hoạt AutoTrade BingX bot).
  - Kết quả: **2 bot chạy song song cùng đặt lệnh giao dịch** (gây nhân đôi khối lượng, cháy tài khoản) hoặc **2 database cùng ghi dữ liệu độc lập** (dẫn đến phân kỳ dữ liệu không thể hợp nhất).
- **Quyết định đúng đắn của V1:** Giới hạn ở **Giám sát & Cảnh báo**. Mọi hành động can thiệp sâu, chuyển đổi dịch vụ hay khởi động ứng dụng đều cần sự xác nhận và phê duyệt của con người (Owner/Lead).

---

## 2. Đánh giá Tài nguyên Tiêu thụ

VPS Monitor V1 được thiết kế chuyên biệt cho các VPS tài nguyên hạn chế chạy song song với ứng dụng production:

| Chỉ số tài nguyên | Tiêu thụ thực tế | Giới hạn Systemd (Safety Guard) | Đánh giá |
|---|---|---|---|
| **RAM (Bộ nhớ)** | **~25MB - 35MB** | `MemoryMax=256M`, `MemoryHigh=192M` | Cực kỳ nhẹ, không ảnh hưởng RAM của 11Ship hay AutoTrade. |
| **CPU** | **< 0.1%** trung bình | `CPUQuota=20%` | Thu thập metrics và gửi heartbeat mất ~15ms mỗi 60 giây. |
| **Disk I/O & Storage** | **~5MB - 15MB** (sau 30 ngày) | N/A | SQLite chạy ở chế độ WAL, chỉ ghi khi có snapshot. Tự dọn sau 30 ngày. |
| **Băng thông mạng** | **~1KB / phút** (~1.4MB / ngày) | N/A | Payload heartbeat JSON nén gọn nhẹ, không gây tắc nghẽn đường truyền. |

---

## 3. Kiến trúc Cơ sở Dữ liệu Đã Chuẩn bị Sẵn cho HA Tương lai

Mặc dù V1 không kích hoạt failover, toàn bộ schema dữ liệu và module đã được chuẩn hóa theo chuẩn HA:

1. **`server_registry`**:
   - Quản lý định danh node, host, port và trường **`role`** (`PRIMARY`, `STANDBY`, `INACTIVE`).
2. **`service_registry`**:
   - Tách biệt từng dịch vụ ứng dụng (`11ship-backend`, `autotrade-bot`), cho phép gán trạng thái chạy và mục tiêu failover sau này.
3. **`node_metrics` & `heartbeat_log`**:
   - Lưu trữ lịch sử trễ mạng (latency) và chuỗi tuần tự (`sequence`), tạo tiền đề tính toán consensus trong tương lai.
4. **`event_history` & `alert_state`**:
   - Máy trạng thái hữu hạn (FSM) phân định rõ ràng giữa các sự kiện hạ tầng và sự kiện ứng dụng.

---

## 4. Lộ trình Kỹ thuật Bổ sung cho HA Giai đoạn sau

Khi hệ thống có nhu cầu nâng cấp lên HA tự động (Failover):
1. **Bổ sung Witness Node (Node thứ 3):**
   - Sử dụng một Cloudflare Worker hoặc VPS siêu nhỏ (hoặc DNS check) đóng vai trò bỏ phiếu (quorum vote) khi 2 VPS chính mất liên lạc.
2. **Cơ chế STONITH / Fencing:**
   - Kỹ thuật cô lập node cũ qua API nhà cung cấp (VinaHost API / Nhân Hòa API reboot/poweroff) để đảm bảo node cũ đã chết hẳn trước khi node mới promote.
3. **Đồng bộ Dữ liệu Chuyên biệt:**
   - Cấu hình PostgreSQL streaming replication (Primary -> Standby) giữa hai máy chủ cho 11Ship.
   - Cơ chế di trú trạng thái vị thế (position state sync) cho bot AutoTrade.
4. **Điều hướng IP (Virtual IP / DNS Failover):**
   - Tự động cập nhật DNS record (Cloudflare API) trỏ domain `api.11ship.vn` sang VPS dự phòng khi failover được kích hoạt.
