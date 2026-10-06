# Sài Gòn · Giờ Cao Điểm

Mô phỏng giao thông isometric 3D Quận 1 (TP.HCM) chạy trên trình duyệt — Three.js + TypeScript + Vite.
Hơn 75% là xe máy, len lỏi như nước giữa ô tô, xe buýt, taxi Vinasun/Mai Linh, xe công nghệ và xích lô.

## Chạy

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + bundle vào dist/
npm run preview    # phục vụ bản build
```

Cần trình duyệt có WebGL2 (Chrome, Edge, Firefox, Safari bản mới).

## Điều khiển

| Thao tác | Tác dụng |
|---|---|
| Kéo chuột trái / phải, cuộn | Xoay / di chuyển / thu phóng camera |
| Nhấp vào xe | Theo dõi xe, hiện thẻ thông tin |
| Nhấp vào đường (tab **Tuyến đường**) | Xem mật độ và tốc độ trung bình theo giờ |
| `Space` · `1` `2` `4` | Tạm dừng · tốc độ ×1 ×2 ×4 |
| `R` | Bật/tắt mưa (đường trơn, ngập nước) |
| `T` | Cỗ máy thời gian — tua lại 1 giờ gần nhất |
| `F` · `Esc` | Theo dõi một xe ngẫu nhiên · bỏ theo dõi |
| `H` | Ẩn/hiện bảng điều khiển |

## Có gì trong mô phỏng

- **Mô hình lái**: ô tô, taxi, buýt, tải theo **IDM** (Intelligent Driver Model) — tăng tốc tự do, giữ khoảng cách thời gian, phanh êm theo xe trước. **Xe máy** theo **mô hình lực xã hội** (social force): lực hút về khe trống phía trước + lực đẩy hàm mũ (bất đẳng hướng, ưu tiên phía trước) từ xe xung quanh, người đi bộ, mép lề và tim đường; IDM chỉ còn làm “phanh an toàn” với xe ngay trước mũi.
- **Tính cách tài xế**: mỗi xe có độ **hung hăng**, **thận trọng** và **tốc độ mong muốn** riêng, seed từ id (xe ôm công nghệ, buýt hung hơn; xích lô hiền nhất). Tính cách đổi tham số IDM (gia tốc, khoảng cách thời gian, khoảng dừng, mức phanh), vùng an toàn cá nhân trong lực xã hội, độ kiên nhẫn khi nhập vòng xoay — thẻ xe hiện “Tính cách” và “Tốc độ mong muốn”.
- **Chất Sài Gòn** (càng hung hăng càng hay làm): **lấn làn ngược chiều** một đoạn ngắn rồi phải quay về (gặp xe ngược chiều thì nhường), **leo lề đi vỉa hè** khi kẹt lâu, **dừng đèn đỏ đè qua vạch** (xe máy tràn lên vạch kẻ, vài ô tô cũng lấn mũi), **vượt đèn đỏ khi đồng hồ còn 1–2 giây**, **cố vượt đèn vàng**, **bóp còi** (bong bóng “•••”) — người hung hăng còn bóp khi xe trước chạy chậm.
- **Đèn tín hiệu** có đồng hồ đếm ngược; rẽ phải khi đèn đỏ được phép trừ nơi có biển cấm. Từ **23:00 đến 05:00** đèn chuyển **vàng nhấp nháy**, bảng đếm ngược tắt: xe giảm tốc quan sát, chỉ vào giao lộ khi không có xe hướng ngang đang chạy qua, ai chờ lâu hơn thì được đi trước (xe máy liều thì bỏ qua phần nhường). Nút “Khuya” nhảy tới 23:30.
- **Người đi bộ qua đường**: băng qua vạch kẻ khi hướng đó đèn đỏ, và kiểu “Sài Gòn” — đội nón lá, đi chậm đều giữa dòng xe ở giữa đoạn đường. Mọi xe phải nhường; xe máy lách vòng, ô tô dừng chờ (thẻ xe hiện “Nhường người đi bộ qua đường”).
- **Sự kiện**: va chạm nhẹ (xe nằm chắn làn, có cọc tiêu, xe sau giảm tốc nhìn và đi vòng), **ngập nước** ở 5 điểm trũng khi mưa to — nước đục dâng trong ~30 s, rút sau ~90 s khi tạnh (xe đi chậm, vài xe chết máy phải dắt), **cấm xe tải** vào nội đô 6–9h và 16–20h.
- **Ngày đêm & thời tiết**: thanh thời gian, giờ cao điểm 07–09 / 17–19 đông xe hơn, đèn xe và cửa hàng sáng về đêm.

## Kiến trúc

```
src/
  core/rng.ts            PRNG + hash có seed — không dùng Math.random()
  sim/network.ts         mạng đường: link, connector giao lộ, vòng xoay
  sim/signals.ts         đèn tín hiệu: hàm thuần của sim time
  sim/traffic.ts         mô phỏng xe (struct-of-arrays), sự kiện, snapshot/restore
  sim/events.ts          tai nạn, vùng ngập, giờ cấm xe tải
  sim/roadStats.ts       thống kê mỗi tuyến đường theo giờ
  sim/timeMachine.ts     tua lại bằng snapshot + phát lại tất định
  render/*               cảnh Three.js (InstancedMesh cho xe, nhà, cây…)
  ui/hud.ts              HUD bằng DOM thuần
  main.ts                khởi động, vòng lặp, nối input
```

**Một đồng hồ mô phỏng duy nhất.** Sim chạy bước cố định 1/60 s; render nội suy giữa hai bước. Mọi lựa chọn ngẫu nhiên đều lấy từ `hash(id xe, muối)` hoặc một PRNG có seed nằm trong trạng thái sim. Đèn, thuyền, người đi bộ, cây đung đưa, mưa đều là hàm của sim time.

**Cỗ máy thời gian.** Mỗi giây sim lưu một snapshot (toàn bộ mảng xe, PRNG, sự kiện, thống kê, giờ, mưa, mật độ). Thay đổi của người dùng (giờ, mưa, mật độ, tự trôi giờ) được ghi kèm số bước. Tua lại = khôi phục snapshot gần nhất rồi chạy lại từng bước, áp đúng input ở đúng bước → khớp chính xác khung hình cũ. “Tiếp tục từ đây” rẽ nhánh lịch sử mới; “Về hiện tại” phát lại tới bước mới nhất. Cửa sổ là **1 giờ trong game** (= 60 giây sim ở tốc độ đồng hồ mặc định 1 phút/giây).

**Hiệu năng.** Xe dùng InstancedMesh (một draw call mỗi mẫu xe), lưới không gian cho tra cứu láng giềng, chỉ upload buffer đèn tín hiệu khi đổi trạng thái. Nếu khung hình chậm kéo dài, chất lượng tự hạ (pixel ratio 1, rồi tắt bloom và giảm shadow map).

## Giới hạn đã biết

- Ở mật độ giờ cao điểm, cửa vào vòng xoay Bến Thành có thể chờ vài phút — cố ý giữ như ùn tắc thật.
- Xe kẹt giữa giao lộ quá 90 s sẽ rời bản đồ (biện pháp chống tắc cuối cùng); không áp dụng cho hàng chờ trên đường.
- Dưới 820 px, bảng điều khiển gập lại thành nút “Điều khiển”.
