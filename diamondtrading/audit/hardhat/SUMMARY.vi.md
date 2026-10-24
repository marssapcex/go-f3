# Tóm tắt audit Round 13

Tao đã audit lại bằng **Hardhat 2.29.1**, đọc source, chạy deploy thật trên local node, làm PoC độc lập và fuzz theo state machine. Đây không phải copy report cũ.

## Kết quả chính

- **Không tái hiện được đường drain Critical/High trực tiếp từ user thường** vào House/Options/Distributor trong phạm vi đã test.
- **High — lỗi deploy/integration:** `menu.json` và `deploy.js` lệch **7/7 class ID**. BTC class 0 theo menu bị disable; class 1 on-chain accept vé có profit **100,000 USDC**, trong khi cap ETH của menu là 25,000 USDC.
- **Medium — stream cũ:** staker cũ rút hết, để trống 30 ngày, staker mới chỉ bỏ **1 wei DIAMOND** nhưng sau stream resume nhận **398.999999 / 399 USDC** của notification cũ. Đây là economic/design issue của cơ chế pause/resume, không phải mint tiền mới.
- **Medium — tape Hyperliquid:** hai trades cùng millisecond bị filter còn một.
- **Medium — tape Binance:** 5 response overlap chứa cùng aggTrade ID tạo 5 prints; VWAP quantity bị nhân từ 2 lên 10.
- **Medium — LP recapitalization:** LP cũ ở NAV=0 không rút được; sau khi LP mới nạp 1,000 USDC, LP cũ rút 500 và LP mới cũng chỉ rút 500. Đây là wealth transfer theo rule 1:1 hiện hữu, không phải lỗi tạo share vô hạn.
- **Medium — governance footgun:** owner enable `address(0)` làm attester thì chỉ cần một chữ ký thật + một chữ ký invalid recover về 0 là đủ threshold 2. User thường không tự làm được; cần owner misconfig.
- **Low:** fee đúng 1 base unit vẫn reset stream 7 ngày; sink bị block/non-pull làm WON settlement revert. Hai case này được tách rõ khỏi lỗi FIFO payee đã fix.

## Fuzz và negative results

- **21,672 invariant checks**, 20 seeds, 150 operations/epochs mỗi seed.
- Distributor riêng đã qua **750 epochs** với Merkle claims và adaptive budget khớp on-chain/off-chain.
- Không thấy lane drift, FIFO reorder, mất credit, LP share inflation hay vượt epoch budget trong campaign.
- High-s quote replay vẫn bị `quote used`; hai bản malleated của cùng attester không tạo quorum.
- Không tái hiện lỗi zero-sigma pricer hay lỗi allocation đáng kể do float.
- Test gốc vẫn pass: **130 diamond, 51 engine, 43 security**, cùng fuzz seed 1337. Bản security trên Hardhat cũng **43/43**.

`npm audit` có 48 vulnerable package entries, nhưng không phải 48 lỗi protocol. Tao đã tách cây Ganache/Hardhat/solc, lưu raw output và không chạy force-fix.

## Giới hạn

Engine hiện là mock/demo wiring, chưa có production worker nối menu → dynamic caps → quoter → attester → ledger → epoch posting. Vì vậy test engine pass không chứng minh các risk control được enforce ngoài production. Adapter PoC dùng dữ liệu mock deterministic; tao không khẳng định đã test live endpoint.

Round này **không sửa production contract hoặc tokenomics**. Chi tiết và lệnh replay nằm trong `REPORT.md`; seeds/results nằm trong `fuzz-seeds.json` và `results/`.
