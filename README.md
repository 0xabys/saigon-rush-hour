# Sài Gòn · Giờ Cao Điểm

Mô phỏng giao thông isometric 3D Quận 1 (TP.HCM) chạy trên trình duyệt — Three.js + TypeScript + Vite.
Khoảng 80,5 % phương tiện là xe hai bánh (xe máy + xe ôm công nghệ Grab/Be/Xanh SM, trong đó ~30 % là xe công nghệ), ~14,7 % ô tô (kể cả taxi và ô tô công nghệ Xanh SM/Grab Car/Be Car, trong đó ~45 % là xe công nghệ) — len lỏi như nước giữa ô tô, xe buýt, taxi Vinasun/Mai Linh và xích lô. Tỉ lệ ô tô theo số liệu 2025 mới nhất của TP.HCM (≈ 1,4 triệu ô tô / 11,3 triệu xe máy đang quản lý 8/2025, cộng 102.354 ô tô và 290.570 xe máy đăng ký mới năm 2025 theo Cục CSGT → ≈ 11,2 % ô tô cuối 2025) cộng taxi; phần chia xe công nghệ là giả định theo quan sát thực tế (chưa có số đếm công bố cho Quận 1); mức ùn tắc và tốc độ đối chiếu với TomTom Traffic Index 2025.

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
| `T` | Cỗ máy thời gian — tua lại 60 giây mô phỏng gần nhất |
| `F` · `Esc` | Theo dõi một xe ngẫu nhiên · bỏ theo dõi |
| `H` | Ẩn/hiện bảng điều khiển |

## Có gì trong mô phỏng

- **Mô hình lái**: ô tô, taxi, buýt, tải theo **IDM** (Intelligent Driver Model) — tăng tốc tự do, giữ khoảng cách thời gian, phanh êm theo xe trước. **Xe máy** theo **mô hình lực xã hội** (social force): lực hút về khe trống phía trước + lực đẩy hàm mũ (bất đẳng hướng, ưu tiên phía trước) từ xe xung quanh, người đi bộ, mép lề và tim đường; IDM chỉ còn làm “phanh an toàn” với xe ngay trước mũi.
- **Tính cách tài xế**: mỗi xe có độ **hung hăng**, **thận trọng** và **tốc độ mong muốn** riêng, seed từ id (xe ôm công nghệ, buýt hung hơn; xích lô hiền nhất). Tính cách đổi tham số IDM (gia tốc, khoảng cách thời gian, khoảng dừng, mức phanh), vùng an toàn cá nhân trong lực xã hội, độ kiên nhẫn khi nhập vòng xoay — thẻ xe hiện “Tính cách” và “Tốc độ mong muốn”.
- **Chất Sài Gòn** (càng hung hăng càng hay làm): **lấn làn ngược chiều** một đoạn ngắn rồi phải quay về (gặp xe ngược chiều thì nhường), **leo lề đi vỉa hè** khi kẹt lâu, **dừng đèn đỏ đè qua vạch** (xe máy tràn lên vạch kẻ, vài ô tô cũng lấn mũi), **vượt đèn đỏ khi đồng hồ còn 1–2 giây**, **cố vượt đèn vàng**, **bóp còi** (bong bóng “•••”) — người hung hăng còn bóp khi xe trước chạy chậm. Xe máy **lách vào giao lộ** khi còn khe trống ở đầu đường ra (không cần cả đường trống); xe ở **nhánh phụ chờ lâu thì chen vào** — càng chờ càng chấp nhận khe hẹp, ô tô trên đường chính chừa chỗ cho xe đang chen.
- **Hành trình & định tuyến**: xe không chỉ chạy xuyên bản đồ giữa hai cửa ngõ — một phần xuất phát **giữa khối phố** và kết thúc **ngay trong mạng** (tấp vào lề rồi rời đi), nhất là ở các phố thương mại như Nguyễn Huệ, Lê Lợi, Đồng Khởi, Lê Thánh Tôn. Ở mỗi ngã rẽ, tài xế chọn hướng theo **chi phí thời gian thực** (độ dài đường còn lại + mức ùn tắc trên từng nhánh, softmax theo tính cách) nên dòng xe tự lách sang đường vắng hơn khi một trục kẹt.
- **Đèn tín hiệu** có đồng hồ đếm ngược; rẽ phải khi đèn đỏ được phép trừ nơi có biển cấm. Từ **23:00 đến 05:00** đèn chuyển **vàng nhấp nháy**, bảng đếm ngược tắt: xe giảm tốc quan sát, chỉ vào giao lộ khi không có xe hướng ngang đang chạy qua, ai chờ lâu hơn thì được đi trước (xe máy liều thì bỏ qua phần nhường). Nút “Khuya” nhảy tới 23:30.
- **Người đi bộ qua đường**: băng qua vạch kẻ khi hướng đó đèn đỏ, và kiểu “Sài Gòn” — đội nón lá, đi chậm đều giữa dòng xe ở giữa đoạn đường. Mọi xe phải nhường; xe máy lách vòng, ô tô dừng chờ (thẻ xe hiện “Nhường người đi bộ qua đường”).
- **Sự kiện**: va chạm nhẹ (xe nằm chắn làn, có cọc tiêu, xe sau giảm tốc nhìn và đi vòng), **ngập nước** ở các điểm trũng trên Tôn Đức Thắng, Hàm Nghi, Lê Lai, Pasteur, Calmette khi mưa to — nước đục dâng trong ~30 s, rút sau ~90 s khi tạnh (xe đi chậm, vài xe chết máy phải dắt), **cấm xe tải** vào nội đô 6–9h và 16–20h (biển ở mọi cửa ngõ vào bản đồ).
- **Ngày đêm & thời tiết**: thanh thời gian, giờ cao điểm 07–09 / 17–19 đông xe hơn (chiều đông nhất), đèn xe và cửa hàng sáng về đêm.
- **Phố đặc người xe**: ~8 000 xe máy đậu kín vỉa hè trước nhà phố (tĩnh, chỉ trang trí, không ảnh hưởng mô phỏng), dày hơn ở dãy cửa hàng và quanh chợ Bến Thành.

## Kiến trúc

```
src/
  core/rng.ts            PRNG + hash có seed — không dùng Math.random()
  data/                  q1-network.json, q1-scene.json (OpenStreetMap đã tiền xử lý) + schema
  sim/network.ts         mạng đường tổng quát: link, connector giao lộ, vòng xoay
  sim/osmMap.ts          dựng Network từ OpenStreetMap
  sim/legacyMap.ts       bản đồ tay cũ — chỉ cho harness
  sim/signals.ts         đèn tín hiệu: hàm thuần của sim time
  sim/traffic.ts         mô phỏng xe (struct-of-arrays), sự kiện, snapshot/restore
  sim/events.ts          tai nạn, vùng ngập (đặt lên phố thật), giờ cấm xe tải
  sim/roadStats.ts       thống kê mỗi tuyến đường theo giờ
  sim/timeMachine.ts     tua lại bằng snapshot + phát lại tất định
  render/*               cảnh Three.js (InstancedMesh cho xe, nhà, cây…; parked.ts: xe máy đậu vỉa hè)
  ui/hud.ts              HUD bằng DOM thuần
  main.ts                khởi động, vòng lặp, nối input
```

**Một đồng hồ mô phỏng duy nhất.** Sim chạy bước cố định 1/60 s; render nội suy giữa hai bước. Mọi lựa chọn ngẫu nhiên đều lấy từ `hash(id xe, muối)` hoặc một PRNG có seed nằm trong trạng thái sim. Đèn, thuyền, người đi bộ, cây đung đưa, mưa đều là hàm của sim time.

**Cỗ máy thời gian.** Mỗi giây sim lưu một snapshot (toàn bộ mảng xe, PRNG, sự kiện, thống kê, giờ, mưa, mật độ). Thay đổi của người dùng (giờ, mưa, mật độ, tự trôi giờ) được ghi kèm số bước. Tua lại = khôi phục snapshot gần nhất rồi chạy lại từng bước, áp đúng input ở đúng bước → khớp chính xác khung hình cũ. “Tiếp tục từ đây” rẽ nhánh lịch sử mới; “Về hiện tại” phát lại tới bước mới nhất. Cửa sổ là **60 giây mô phỏng** gần nhất. Nhãn “lùi N phút” (khi **Giờ tự trôi** bật) tính theo giờ trong game vì 1 giây sim = 1 phút game; khi tắt Giờ tự trôi đồng hồ đứng yên nên nhãn là “lùi N giây mô phỏng”.

**Hiệu năng.** Xe dùng InstancedMesh (một draw call mỗi mẫu xe), lưới không gian cho tra cứu láng giềng, chỉ upload buffer đèn tín hiệu khi đổi trạng thái. Nếu khung hình chậm kéo dài, chất lượng tự hạ (pixel ratio 1, rồi tắt bloom và giảm shadow map).

## Dữ liệu bản đồ

Bản đồ là **Quận 1 thật**, lấy từ OpenStreetMap: mạng đường (làn, một chiều, dải phân cách, cầu, vòng xoay, đèn tín hiệu, trạm buýt), toà nhà, sông/kênh, công viên, công trường xây dựng (`landuse=construction|brownfield`: nền đất, hàng rào tôn, khung bê tông dở dang, cần cẩu tháp), quảng trường / khu đi bộ và 8 công trình nổi bật dựng tay (Chợ Bến Thành, UBND TP, Bitexco, Cafe Apartment, Nhà thờ Đức Bà, Bưu điện Trung tâm, Nhà hát Thành phố, Dinh Độc Lập).

- Dữ liệu đã tiền xử lý nằm sẵn trong `src/data/q1-network.json` (mạng đường) và `src/data/q1-scene.json` (cảnh 3D); schema ở `src/data/q1Schema.ts`. App không gọi mạng khi chạy.
- Tạo lại dữ liệu: `npm run osm` (dùng cache `data/osm/raw-q1.json` + `data/osm/raw-q1-extra.json` + `data/osm/raw-q1-gob.json`), `npm run osm:refresh` (tải lại cache OSM chính và cache bổ sung từ Overpass), `npm run osm:refresh-extra` (chỉ tải lại phần chỉ ảnh hưởng cảnh 3D: công trường, quảng trường; **không** đổi `q1-network.json`), `npm run osm:refresh-gob` (tải lại tile Google Open Buildings v3 ~1,9 GB và ghi `raw-q1-gob.json`; đặt `GOB_TILE_PATH=/đường/dẫn/317_buildings.csv.gz` để dùng tile đã tải sẵn), `npm run osm:check` (kiểm tra bất biến). Cần [bun](https://bun.sh).
- Bản đồ tay cũ (17 nút, 1 vòng xoay) chỉ còn dùng cho harness: `npm run harness:legacy`.
- **Lê Lợi, Nguyễn Huệ và Lê Thánh Tôn được giữ lại** trong mạng đường: OSM gắn `motor_vehicle=no` kèm điều kiện `no @ (Sa-Su 18:30-23:00)` (phố đi bộ cuối tuần) nên đây là hạn chế theo giờ chứ không cấm vĩnh viễn, còn mô phỏng là giờ cao điểm ngày thường.

**Giấy phép dữ liệu.** © OpenStreetMap contributors — dữ liệu theo giấy phép [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). Dấu chân toà nhà bổ sung lấy từ [Google Open Buildings](https://sites.research.google/gr/open-buildings/) v3 (Google LLC; phát hành kép CC BY 4.0 / ODbL — dự án này dùng theo **ODbL 1.0**, nên toàn bộ dữ liệu dẫn xuất chung một giấy phép). Ghi công của cả hai nguồn hiển thị ở góc trên bên trái của HUD (liên kết tới trang bản quyền OpenStreetMap và trang Google Open Buildings) và trên trang debug, và phải được giữ nguyên khi phân phối lại; bản đồ, dữ liệu dẫn xuất và mọi sản phẩm dựng từ chúng phải giữ nguyên giấy phép ODbL.

## Giới hạn đã biết

- Ở mật độ giờ cao điểm, các vòng xoay (Bến Thành, Quách Thị Trang…) có thể chờ vài phút — cố ý giữ như ùn tắc thật.
- Xe đứng đầu hàng chờ quá 180 s (hoặc quá 300 s tại đèn) sẽ rời bản đồ (biện pháp chống tắc cuối cùng, đếm là `teleports`); các xe phía sau trong hàng không bị áp dụng.
- Số xe tối đa 8 000 (`MAX_VEHICLES`) — mặc định (mật độ 90 %) khoảng 6 900 xe lúc 17:30. Ở tốc độ ×4, máy yếu có thể không theo kịp: HUD khi đó hiện “×4 · thực ×…” (tốc độ thực đạt được).
- **Thông lượng giao lộ chỉ bằng khoảng 1/3 thực tế**, nên mật độ trên trục lớn ≈ 9 xe/100 m/làn so với 30–80 ở đời thật: lõi đông nhất vẫn thưa hơn ngoài đời dù tổng số xe đã ở mức trần.
- **Ổ kẹt cục bộ** (lock pocket: một nhóm xe chờ nhau quanh giao lộ) vẫn xảy ra — khoảng 300+ lần trong 30 phút mô phỏng ở 8 000 xe; chúng được tự gỡ bằng cơ chế xả/rời bản đồ nói ở trên chứ chưa tránh được từ gốc.
- Xe máy **chồng thân lên nhau bên trong hộp giao lộ** là chủ ý của mô hình (không xử lý va chạm cứng giữa các xe máy ở đó).
- OSM chỉ có ~800 toà nhà cho khu vực này; ~2 000 dấu chân thật của Google Open Buildings được thêm vào trước, và phần còn lại của các khối phố mới được lấp bằng nhà ống/nhà vài tầng sinh tự động.
- Dưới 820 px, bảng điều khiển gập lại thành nút “Điều khiển”.
