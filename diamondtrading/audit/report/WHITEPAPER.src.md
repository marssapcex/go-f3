# WHITEPAPER — Audit bảo mật `diamondtrading/` (go-f3)

> File này được sinh tự động bởi `audit/report/build_whitepaper.py` từ `WHITEPAPER.src.md`.
> Mọi khối mã, khối PoC và khối log đều được trích trực tiếp từ file trong repo (không gõ tay).
> Muốn sửa nội dung: sửa `WHITEPAPER.src.md`, rồi chạy lại `python3 audit/report/build_whitepaper.py`.

| | |
|---|---|
| Dự án | go-f3 — module `diamondtrading/` (DiamondHouse, DiamondOptions, DiamondDistributor, RevenueSplit, Verifiers, DiamondToken, MockUSDC; engine off-chain; script deploy) |
| Repo / nhánh | `marssapcex/go-f3` / `arena/a5d74a8e-go-f3` |
| Commit gốc được audit | `3cb964b` (main) |
| Ngày lập báo cáo | 2026-10-24 |
| Môi trường kiểm thử | Hardhat 2.22.19 (EDR), chainId 31337, hardfork shanghai; solc-js 0.8.26 viaIR; Node.js local |
| Phạm vi tiền | Mọi đường USDC và DIAMOND: nạp/rút LP, mua vé/option, settle, hàng đợi thanh toán, stream phí, claim phần thưởng, mint DIAMOND, deploy |
| Trạng thái | 14 nhóm lỗi đã có PoC trên mã gốc, đã vá, đã kiểm lại trên mã vá. Các điểm rủi ro governance chưa vá, chờ quyết định (mục 6) |

---

## Mục lục

1. Tóm tắt điều hành
2. Phương pháp, phạm vi và cách tái lập
3. Kiến trúc và mô hình tin cậy
4. Chi tiết từng lỗi (F-01 đến F-14): mô tả, mã lỗi, PoC, log, đề xuất sửa, PoC và log sau sửa
5. Các điểm đã đánh giá nhưng chưa có PoC
6. Rủi ro còn lại và quyết định cần người dùng chốt
7. Kiểm chứng tổng hợp và giới hạn
8. Phụ lục: A. Diff bản vá; B. Log đầy đủ; C. Manifest SHA-256; D. Thuật ngữ

---

## 1. Tóm tắt điều hành

Đã tìm được **14 nhóm lỗi** (F-01 đến F-14). Mỗi nhóm có PoC chạy được trên Hardhat network local, chạy trên mã gốc để chứng minh lỗi, sau đó chạy lại trên mã đã vá để chứng minh lỗi đã hết và không sinh lỗi mới trong phạm vi các test.

Kết quả chạy cuối cùng:

- Mã gốc (nhánh `vulnerable`): **18 pass, 2 pending** (2 pending là test guard chỉ có ý nghĩa trên mã vá), 0 fail. Tất cả PoC lỗi đều tái hiện.
- Mã vá (nhánh `fixed`): **19 pass, 1 pending** (PoC F-07 chỉ có ý nghĩa trên mã gốc), 0 fail.
- Suite gốc của repo: diamond 133/133, engine 51/51, fuzz SEED=1337 OK (160 kiểm tra).

Cách đọc mức độ: mức độ dựa trên hai yếu tố, *tác động* (bao nhiêu tiền, ai mất) và *điều kiện khai thác* (kẻ tấn công cần gì). Đây là đánh giá định tính, không phải CVSS.

| ID | Mức | Loại | Tóm tắt | Tác động đo được trong PoC | Điều kiện |
|---|---|---|---|---|---|
| F-01 | High | Đóng băng (DoS) | 1 wei USDC chuyển thẳng vào House làm bất biến `==` sai, mọi thao tác revert | ~100,150 USDC kẹt vĩnh viễn | Ai cũng làm được, tốn 1 wei |
| F-02 | High | Ăn cắp | Stake JIT trước khi settle, ăn phí của staker khác | Kẻ tấn công 359.1 USDC (90%) trên 399 USDC phí | Ai cũng làm được, cần vốn DIAMOND |
| F-03 | Critical nếu root lộ / High nội bộ | Ăn cắp (mint) | Claim không kiểm `totalMint` đã đăng của epoch | Mint 1,000,000 DIAMOND trong khi budget 20,000 | Cần quyền đăng root (owner) |
| F-04 | High | Ăn cắp | Pool mồ côi (có tiền, không có share): nạp 1 wei được toàn bộ | Rút 1000.000001 USDC tiền của người chơi thua | Ai cũng làm được |
| F-05 | High | Ăn cắp | Share inflation qua donation + làm tròn xuống | Victim mất 499.499999 USDC, kẻ tấn công lãi 499.499999 | Ai cũng làm được, phải chịu thua cược ban đầu |
| F-06 | High | Ăn cắp của người thắng | `lpWithdraw` không trừ `queueDebt` | LP rút 100 USDC trong khi người thắng nợ 480.05 USDC | LP thường (không cần quyền) |
| F-07 | Critical nếu deploy bằng khoá công khai | Ăn cắp | Script deploy derive khoá ký từ mnemonic công khai | Rút 48,044.9 USDC từ pool 100,000 | Chỉ khi deploy dùng khoá mặc định |
| F-08 | High (phụ thuộc owner) | Ăn cắp | `setRevenueSink` không kiểm code, approve vô hạn, không thu hồi | EOA rút 102,000 USDC (gồm stake đang mở) | Owner đặt sink xấu hoặc sink cũ bị lộ |
| F-09 | High (kinh tế) | Thiệt hại kinh tế | `ttl` không nằm trong chữ ký quote, người mua chọn thời hạn | EV người mua +33.5% (ttl 30) so với −4.0% (ttl 60) | Ai cũng làm được |
| F-10 | Medium | Thiệt hại kinh tế | Quote dùng lại được trong cửa sổ hiệu lực | 5/5 vé mua trên cùng một giá cũ | Ai cũng làm được |
| F-11 | Medium (High nếu token có blocklist) | DoS hàng đợi | Một payee bị token từ chối làm revert mọi settle/harvest | Pool 1000 USDC bị kẹt, mọi settle khác revert | Token có blocklist (USDC thật có) |
| F-12 | Low | Vệ sinh | (a) queue entry bằng 0; (b) chữ ký rỗng khi chưa đặt `budgetAttester` | Rác trong queue; postEpoch không ký được chấp nhận | Trường hợp biên |
| F-13 | Medium | Kẹt tiền | Doanh thu nhận khi chưa có staker bị bỏ mất | 1000 USDC kẹt vĩnh viễn trong sink | Chưa có staker |
| F-14 | High | Farm / mint quá mức | Ledger tính phí hai lần và trần 200% | Farmer lãi +1900.36 USD ở M=1.92 | Ai cũng làm được (off-chain + DIAMOND) |

---

## 2. Phương pháp, phạm vi và cách tái lập

### 2.1 Phạm vi

- Toàn bộ `contracts/` trong `diamondtrading/` (7 file Solidity).
- `engine/` (ledger, quoter, pricer, caps): phần off-chain tính anchor, ký quote và tính giá, vì ảnh hưởng trực tiếp đến số DIAMOND được mint.
- `scripts/deploy.js`: vì khoá ký nằm ở đây.
- Không nằm trong phạm vi: hạ tầng vận hành (KMS/HSM, máy chủ oracle, monitoring), chuỗi thật, và token USDC thật (chỉ mô phỏng bằng `MockUSDC` và `BlocklistUSDC`).

### 2.2 Phương pháp

1. **Đọc mã có chủ đích theo đường tiền.** Với mỗi lệnh chuyển token (`transfer`, `transferFrom`, `approve`) và mỗi thay đổi số dư nội bộ (`pool`, `openStakes`, `queueDebt`, `totalShares`, `rewardIndex`), tôi xác định ai gọi được, ở trạng thái nào, và kết quả ra sao.
2. **Mô hình hoá kẻ tấn công.** Với mỗi đường tiền, tự đặt câu hỏi: kẻ tấn công cần vốn gì, cần quyền gì, đi theo thứ tự nào, và được gì. Các kịch bản được ghi lại trong từng mục ở mục 4.
3. **Viết PoC trước khi tin.** Một lỗi chỉ được ghi là "đã xác nhận" khi test chạy được và tái hiện đúng hành vi tiền. Các giả thuyết chưa viết được PoC được tách riêng (mục 5).
4. **Vá và kiểm lại.** Sau khi vá, cùng một test được chạy ở nhánh `fixed` và phải cho kết quả mong đợi. Tôi kiểm thêm suite gốc của repo để bắt hồi quy.
5. **Fuzz và suite có sẵn.** `test/fuzz.js` (SEED=1337) và `test/diamond.test.js`, `test/engine.test.js` của repo.

### 2.3 Cơ chế hai nhánh (vulnerable / fixed)

- Nhánh `vulnerable` dùng **snapshot byte-identical** của mã gốc `3cb964b` (thư mục `audit/vulnerable/`). Nó được build bằng cùng solc-js, cùng cấu hình, nên PoC chạy trên đúng mã đã gây lỗi.
- Nhánh `fixed` dùng mã hiện tại trong `contracts/`, `engine/`, `scripts/`.
- Biến môi trường `AUDIT_SET=vulnerable|fixed` chọn nhánh. Harness `audit/lib/world.js` dùng biến này để deploy đúng bộ artifact cho mọi contract (xem mục 7.3 về lỗi harness đã sửa).

### 2.4 Cách tái lập

Chạy từ thư mục `diamondtrading/`:

```
npm install
npm run audit:poc       # build + PoC trên mã gốc, kỳ vọng: 18 passing, 2 pending
npm run audit:regress   # build + cùng bộ test trên mã vá, kỳ vọng: 19 passing, 1 pending
npm test                # suite gốc: compile + diamond (133) + engine (51) + fuzz (SEED=1337)
```

Log đầy đủ của các lần chạy cuối nằm trong `audit/evidence/` (xem Phụ lục B).

---

## 3. Kiến trúc và mô hình tin cậy

### 3.1 Các thành phần

| Thành phần | Vai trò | Giữ tiền gì |
|---|---|---|
| `DiamondHouse` | Sổ cược nhị phân (vé): mua, settle, trả thưởng, hàng đợi, LP nạp/rút | `pool` (vốn LP + phần thua), `openStakes` (stake đang mở), `queueDebt` (nợ hàng đợi), `totalCredits` (credit, từ mục F-11) |
| `DiamondOptions` | Sổ option (spread có chặn) | `pool`, `openPremiums`, `queueDebt`, `totalCredits` |
| `DiamondDistributor` | Phát DIAMOND theo epoch bằng Merkle root | Không giữ USDC; có quyền mint DIAMOND |
| `RevenueSplit` | Staking DIAMOND, nhận phí USDC và phát thưởng | USDC phí đang stream; `carry`; `credits` |
| `Verifiers` (MultiAttester / MultiPrice) | Kiểm kết quả trận đấu / giá đóng bằng chữ ký N-of-M | Không giữ tiền |
| `DiamondToken` | Token DIAMOND, mint có kiểm soát bởi minter | — |
| Quoter (off-chain) | Ký quote (EIP-712) cho người mua | — |
| `scripts/deploy.js` | Deploy và thiết lập quyền | — |

Luồng tiền chính: người chơi nạp `stake` → `openStakes` → khi settle: thắng thì trả `S + profit` từ pool (có thể vào hàng đợi), thua thì `S` vào pool, và phí thắng được chia 0.99% founder / 3.00% stakers (`RevenueSplit`).

### 3.2 Mô hình tin cậy

| Thực thể | Mức tin cậy | Hệ quả nếu bị xâm phạm |
|---|---|---|
| Owner | Có quyền cấu hình (sink, class cap, minter, targetPool, verifier, attester) | Có thể rút pool (F-08 và mục 5.2) |
| Quoter key | Tin cậy ký đúng giá và đúng thời hạn | Ký quote có lợi cho người mua |
| Attester keys (N-of-M) | Tin cậy ký đúng kết quả | Ký WON giả → rút pool (F-07 nếu khoá công khai) |
| Budgeter key | Tin cậy ký đúng budget epoch | Cho phép budget sai (F-12b, D2) |
| Root poster (owner) | Tin cậy đăng đúng Merkle root | Mint vượt budget (F-03) |
| USDC | Chuẩn ERC20, nhưng **có thể** blocklist | Gây DoS hàng đợi (F-11) |
| Người chơi / LP / staker | Không tin cậy | Mọi lỗi người dùng khai thác được ghi ở mục 4 |

---

## 4. Chi tiết từng lỗi

Mỗi lỗi có cùng cấu trúc: mô tả và nguyên nhân gốc, kịch bản khai thác, mã lỗi (lấy từ snapshot gốc), PoC (lấy từ file test), log PoC trên mã gốc, đề xuất sửa, mã sau sửa, PoC sau sửa (cùng test, nhánh fixed), log sau sửa, và đánh giá phần còn lại.

Lưu ý khi đọc log: đường dẫn log là file trong `audit/evidence/per-file/`. Các dòng `[EVIDENCE]` là số liệu do chính test in ra khi chạy.

---

### 4.1 F-01 — 1 wei donation đóng băng House và Options

**Mức độ:** High. **Loại:** đóng băng (DoS). **Không mất tiền trực tiếp**, nhưng khoá toàn bộ tiền trong contract.

#### Mô tả và nguyên nhân gốc

`lanesIntact()` kiểm tra **bằng nhau** giữa số dư token của contract và `pool + openStakes`. Đây là bất biến quá chặt. Bất kỳ ai chuyển trực tiếp USDC vào contract (không qua hàm nào) đều làm số dư lớn hơn tổng nội bộ, và bất biến sai vĩnh viễn. Mọi hàm có `require(lanesIntact(), "lane drift")` bị revert: mua vé, settle, harvest, rút LP, refund. Không có hàm nào rút phần thừa, nên tiền bị khoá không lấy lại được.

#### Kịch bản khai thác

1. Kẻ tấn công chuyển 1 wei USDC trực tiếp vào `DiamondHouse` bằng `transfer`.
2. Bất biến trở thành sai. Người chơi khác gọi `buyTicket` → revert `lane drift`.
3. Settle, harvest, LP rút, refund đều revert tương tự.
4. Toàn bộ pool và stake đang mở bị khoá. Không ai (kể cả owner) rút được qua các hàm chuẩn.

#### Mã lỗi (mã gốc `3cb964b`)

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|147|151|solidity>>

Các điểm kiểm tra dùng bất biến này trong House: dòng 212, 268, 280, 329, 343, 365, 382. Trong Options: `DiamondOptions.sol` dòng 190, 227, 258, 284.

<<CODE audit/vulnerable/contracts/DiamondOptions.sol|117|121|solidity>>

#### PoC

<<TEST audit/test/F01-donation-freeze.test.js|House: 1-wei donation freezes buy / settle / harvest / refund / LP exit>>

<<TEST audit/test/F01-donation-freeze.test.js|Options: 1-wei donation blocks new option sales and settlement>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F01-donation-freeze.txt|House: 1-wei donation freezes buy / settle / harvest / refund / LP exit>>

<<LOG audit/evidence/per-file/vulnerable-F01-donation-freeze.txt|Options: 1-wei donation blocks new option sales and settlement>>

#### Đề xuất sửa

Đổi bất biến từ **bằng nhau** sang **đủ tiền** (solvency): contract phải *giữ ít nhất* những gì nó nợ. Phần thừa do chuyển nhầm không làm hỏng bất biến. Thêm hàm `sweepSurplus` chỉ cho owner rút phần thừa, và chỉ phần thừa. Tổng nợ phải bao gồm `totalCredits` (xem F-11).

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|170|188|solidity>>

<<CODE contracts/DiamondOptions.sol|135|146|solidity>>

#### PoC sau sửa (cùng test, nhánh `fixed`)

Test không đổi; nhánh `fixed` trong test kiểm: mọi thao tác thành công, `sweepSurplus` của người lạ bị từ chối với `not owner`, owner chỉ rút đúng phần thừa (1 wei), và `lanesIntact()` vẫn `true` sau khi sweep.

<<LOG audit/evidence/per-file/fixed-F01-donation-freeze.txt|House: 1-wei donation freezes buy / settle / harvest / refund / LP exit>>

<<LOG audit/evidence/per-file/fixed-F01-donation-freeze.txt|Options: 1-wei donation blocks new option sales and settlement>>

#### Đánh giá sau sửa

- Đóng băng đã hết. Phần thừa vẫn nằm trong contract cho tới khi owner sweep. Đây là đánh đổi có chủ đích, đã ghi trong mã.
- Owner có quyền sweep: phải được xem như một quyền vận hành và ghi trong tài liệu.

---

### 4.2 F-02 — Stake JIT ăn phí của staker trung thực

**Mức độ:** High. **Loại:** ăn cắp của người khác. **Không cần quyền đặc biệt.**

#### Mô tả và nguyên nhân gốc

`RevenueSplit.notifyRevenue` cộng phí vào `rewardIndex` **ngay lập tức**, chia cho `totalStaked` tại thời điểm đó. Phần thưởng không được tích luỹ theo thời gian. Người stake ngay trước khi phí về sẽ nhận gần như toàn bộ phí, dù họ chỉ stake vài giây.

#### Kịch bản khai thác

1. Staker trung thực đã stake 10,000 DIAMOND từ trước.
2. Kẻ tấn công thấy một vé thắng sắp settle (phí sắp về). Hắn stake 90,000 DIAMOND.
3. Settle xảy ra: phí ~399 USDC được cộng vào `rewardIndex` chia cho tổng 100,000 DIAMOND. Kẻ tấn công nhận 90%.
4. Kẻ tấn công claim và rút stake ngay trong cùng khoảng thời gian ngắn.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/RevenueSplit.sol|85|92|solidity>>

#### PoC

<<TEST audit/test/F02-jit-stake-reward-theft.test.js|attacker staking 9x the honest stake right before a fee event takes ~90% of the fee>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F02-jit-stake-reward-theft.txt|attacker staking 9x the honest stake right before a fee event takes ~90% of the fee>>

#### Đề xuất sửa

Phí phải được **stream theo thời gian** trong một cửa sổ cố định (ở đây 7 ngày), và người stake chỉ nhận phần thời gian họ thực sự đã stake. Khi không có staker, phần phí được giữ bằng `carry` và bắt đầu stream khi có staker đầu tiên (liên quan F-13). `SCALE = 1e36` để giữ độ chính xác cho index.

#### Mã sau sửa

<<CODE contracts/RevenueSplit.sol|85|108|solidity>>

<<CODE contracts/RevenueSplit.sol|148|160|solidity>>

#### PoC sau sửa

<<TEST audit/test/F02-jit-stake-reward-theft.test.js|attacker staking 9x the honest stake right before a fee event takes ~90% of the fee>>

Ghi chú: test này có nhánh `isFixed()` riêng. Với nhánh fixed, nó kiểm: kẻ tấn công nhận gần 0, staker trung thực nhận gần như toàn bộ phí sau 7 ngày.

<<LOG audit/evidence/per-file/fixed-F02-jit-stake-reward-theft.txt|attacker staking 9x the honest stake right before a fee event takes ~90% of the fee>>

#### Đánh giá sau sửa

- Kẻ tấn công vẫn nhận 593 base units (0.000593 USDC). Đó là phần thời gian thật sự đã stake, theo đúng tỷ lệ, không phải lỗi.
- Staker trung thực nhận 398.998812 USDC sau 7 ngày. Chênh lệch so với 399 USDC là do làm tròn.
- Rủi ro còn lại: người stake dài hạn vẫn được hưởng nhiều hơn người stake ngắn hạn. Đây là thiết kế, không phải lỗ hổng.

---

### 4.3 F-03 — Distributor không ràng buộc claim theo budget đã ký

**Mức độ:** Critical nếu root poster bị lộ; High nếu là rủi ro nội bộ. **Loại:** mint vượt budget.

#### Mô tả và nguyên nhân gốc

`postEpoch` kiểm `totalMint <= budget` (budget được tính từ anchor và giá, có chữ ký của budgeter). Nhưng `claim()` **không so sánh** với `totalMint` của epoch. Nó chỉ kiểm Merkle proof và tổng CAP toàn cục. Ai đăng Merkle root (owner) có thể gán số lượng tuỳ ý cho bất kỳ địa chỉ nào, miễn là tổng toàn cục không vượt CAP (1e9 DIAMOND).

Nghĩa là "budget" chỉ là con số trang trí: nó được kiểm một lần khi đăng header, nhưng không được dùng để giới hạn các lần claim.

#### Kịch bản khai thác

1. Owner (hoặc ai lấy được khoá root) đăng epoch với `totalMint` hợp lệ đúng bằng budget, ví dụ 20,000 DIAMOND.
2. Owner tạo Merkle tree có lá cho kẻ tấn công với 1,000,000 DIAMOND.
3. Kẻ tấn công gọi `claim` với proof hợp lệ và nhận 1,000,000 DIAMOND.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/DiamondDistributor.sol|104|124|solidity>>

<<CODE audit/vulnerable/contracts/DiamondDistributor.sol|127|138|solidity>>

#### PoC

<<TEST audit/test/F03-distributor-unbounded-claims.test.js|owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F03-distributor-unbounded-claims.txt|owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000>>

#### Đề xuất sửa

Đếm lũy kế claim theo epoch và chặn khi vượt `totalMint` đã đăng. Mỗi địa chỉ chỉ claim một lần cho mỗi epoch (đã có sẵn). Ngoài ra, ràng buộc chữ ký budget với `chainid` và địa chỉ contract (D2), để chữ ký của chuỗi/contract này không dùng được cho chuỗi/contract khác.

#### Mã sau sửa

<<CODE contracts/DiamondDistributor.sol|119|122|solidity>>

<<CODE contracts/DiamondDistributor.sol|137|147|solidity>>

<<CODE contracts/DiamondDistributor.sol|176|180|solidity>>

#### PoC sau sửa

<<TEST audit/test/F03-distributor-unbounded-claims.test.js|owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000>>

Ghi chú: trên nhánh fixed, test dùng `budgetHash` do contract cung cấp (vì digest đã đổi). Trên nhánh vulnerable, test dùng digest cũ.

<<LOG audit/evidence/per-file/fixed-F03-distributor-unbounded-claims.txt|owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000>>

#### Đánh giá sau sửa

- Mint vượt budget đã bị chặn: `epoch budget exhausted`.
- Budget sau sửa là 10,000 DIAMOND (vì trần tỷ lệ giảm từ 200% xuống 100%, xem F-14).
- Rủi ro còn lại: owner vẫn có thể đăng root và tự claim tới budget. Cần quy trình ký budget độc lập (mục 6).

---

### 4.4 F-04 — Chiếm pool mồ côi bằng 1 wei

**Mức độ:** High. **Loại:** ăn cắp của người chơi thua.

#### Mô tả và nguyên nhân gốc

Khi `totalShares == 0` nhưng `pool > 0`, pool có tiền (do người chơi thua đưa vào) nhưng không có LP nào giữ share. Nhánh `if (totalShares == 0 || pool == 0) shares = amount;` cho người nạp đúng `amount` share, bất kể pool đang có bao nhiêu tiền. Nạp 1 wei được 1 share = 100% pool.

#### Kịch bản khai thác

1. Pool có 1000 USDC từ người chơi thua, `totalShares = 0`.
2. Kẻ tấn công nạp 1 wei → nhận 1 share (100% pool).
3. Sau khoá 7 ngày, hắn rút: nhận toàn bộ 1000 USDC.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|333|344|solidity>>

#### PoC

<<TEST audit/test/F04-F05-lp-vault-theft.test.js|1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F04-F05-lp-vault-theft.txt|1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock>>

#### Đề xuất sửa

Dùng **virtual shares và virtual assets** (kiểu ERC-4626 chống inflation): `shares = amount × (totalShares + VIRTUAL_SHARES) / (navPool + VIRTUAL_ASSETS)`, và yêu cầu `shares > 0`. Với `VIRTUAL_SHARES = 1e6`, 1 wei không đủ để nhận share có giá trị đáng kể. Phần share ảo không rút được nên phần dust nằm lại trong pool.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|396|410|solidity>>

#### PoC sau sửa

<<TEST audit/test/F04-F05-lp-vault-theft.test.js|1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock>>

<<LOG audit/evidence/per-file/fixed-F04-F05-lp-vault-theft.txt|1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock>>

#### Đánh giá sau sửa

- 1 wei không tạo share (`dust`). Kẻ tấn công không lấy được gì.
- Virtual shares có chi phí: khoảng 1e-6 phần pool bị giữ lại vĩnh viễn như dust. Đây là đánh đổi chấp nhận được và đã ghi trong mã.

---

### 4.5 F-05 — Share inflation qua donation

**Mức độ:** High. **Loại:** ăn cắp của người nạp sau.

#### Mô tả và nguyên nhân gốc

Công thức `shares = amount × totalShares / pool` làm tròn xuống. Kẻ tấn công giữ một ít share, đưa tiền vào pool (ở đây bằng cách thua cược 2000 USDC, phần đó tăng NAV), rồi chờ nạp của victim. Với NAV lớn so với số share, victim nhận rất ít share, phần giá trị của họ bị chia cho kẻ tấn công.

#### Kịch bản khai thác

1. Kẻ tấn công nạp 1 wei, nhận 1 share.
2. Kẻ tấn công cược thua 2000 USDC: pool tăng lên 4999 USDC, vẫn chỉ có 1 share.
3. Victim nạp 2999 USDC: `2999 × 1 / 4999` làm tròn xuống, victim nhận ~1 share.
4. Kẻ tấn công rút: nhận gần như toàn bộ pool, bao gồm cả 2999 USDC của victim.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|333|344|solidity>>

Và NAV slice khi rút (làm tăng tác động vì `pool` không trừ queue):

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|354|366|solidity>>

#### PoC

<<TEST audit/test/F04-F05-lp-vault-theft.test.js|attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F04-F05-lp-vault-theft.txt|attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share>>

#### Đề xuất sửa

Cùng bản vá với F-04 (virtual shares), và tính NAV slice trước khi đốt share (F-06).

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|423|436|solidity>>

#### PoC sau sửa

<<TEST audit/test/F04-F05-lp-vault-theft.test.js|attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share>>

<<LOG audit/evidence/per-file/fixed-F04-F05-lp-vault-theft.txt|attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share>>

#### Đánh giá sau sửa

- Kẻ tấn công lỗ gần 1000 USDC (không lời). Victim mất 0.000399 USDC, do làm tròn. Tấn công không còn sinh lời.
- Nhận xét: trong PoC, kẻ tấn công lỗ vì phải chịu thua cược 2000 USDC để tăng NAV. Tôi **chưa kiểm chứng** liệu có cách nào tăng NAV mà không chịu lỗ tương đương (ví dụ qua phí do chính họ kiểm soát). Nếu có, tấn công sẽ vẫn tồn tại ở mức nhẹ hơn; đây là điểm cần kiểm thêm, không phải kết luận.

---

### 4.6 F-06 — `lpWithdraw` bỏ qua `queueDebt`

**Mức độ:** High. **Loại:** ăn cắp của người thắng đang chờ.

#### Mô tả và nguyên nhân gốc

`queueDebt` là khoản nợ **ưu tiên** (senior): tiền thắng cược đang chờ trong hàng đợi. Nó phải được trả trước khi LP được rút. Nhưng `lpWithdraw` tính NAV slice từ `pool` mà không trừ `queueDebt`. Khi pool có tiền nhưng nợ hàng đợi lớn hơn, LP rút phần lẽ ra thuộc về người thắng.

#### Kịch bản khai thác

1. Hàng đợi có nợ 480.05 USDC (5 vé thắng khi pool rỗng).
2. LP nạp 100 USDC vào pool → pool = 100 USDC.
3. LP yêu cầu rút và sau khoá, gọi `lpWithdraw`: nhận 100 USDC, pool về 0.
4. Người thắng vẫn nợ 480.05 USDC nhưng pool không còn tiền để trả.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|354|366|solidity>>

#### PoC

<<TEST audit/test/F06-F08-admin-and-queue.test.js|LP withdraws its 100 USDC while winners' profit is still owed>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F06-F08-admin-and-queue.txt|LP withdraws its 100 USDC while winners' profit is still owed>>

#### Đề xuất sửa

Tách NAV khỏi nợ senior: `navPool() = pool − queueDebt`. NAV slice dùng `navPool`. Nếu `navPool = 0`, revert `nav empty` để không đốt share cho số tiền bằng 0. Lúc đó LP giữ nguyên share và yêu cầu rút.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|172|178|solidity>>

<<CODE contracts/DiamondHouse.sol|423|436|solidity>>

#### PoC sau sửa

<<TEST audit/test/F06-F08-admin-and-queue.test.js|LP withdraws its 100 USDC while winners' profit is still owed>>

<<LOG audit/evidence/per-file/fixed-F06-F08-admin-and-queue.txt|LP withdraws its 100 USDC while winners' profit is still owed>>

#### Đánh giá sau sửa

- LP rút được 0, pool giữ 100 USDC cho người thắng.
- Rủi ro còn lại: khi NAV = 0, LP không rút được cho đến khi có đủ tiền vào pool. Đây là đánh đổi có chủ đích, ưu tiên người thắng.

---

### 4.7 F-07 — Khoá ký deploy derive từ mnemonic công khai

**Mức độ:** Critical nếu hệ thống được deploy bằng khoá mặc định. **Loại:** ăn cắp qua khoá ký.

#### Mô tả và nguyên nhân gốc

`scripts/deploy.js` derive khoá quoter, attester và budgeter từ mnemonic ganache `test test ... junk`, là chuỗi công khai ai cũng biết. Script dùng các khoá này trực tiếp, không kiểm tra chain, không yêu cầu cấu hình khoá. Khi deploy lên mạng thật bằng script này, mọi người có thể ký quote, ký attestation WON và rút pool.

Đây là lỗi **cấu hình/vận hành**, không phải lỗi trong contract. Contract không thể biết khoá đã lộ.

#### Kịch bản khai thác

1. Kẻ tấn công derive khoá quoter (HD21) và hai attester (HD31, HD32) từ mnemonic công khai.
2. Hắn đặt cược, lấy quote hợp lệ từ quoter giả.
3. Hắn tự ký attestation WON với 2 khoá attester (đủ quorum 2-of-3).
4. Hắn gọi settle và rút thưởng từ pool.

#### Mã lỗi (mã gốc `3cb964b`, file `scripts/deploy.js`)

<<CODE audit/vulnerable/scripts/deploy.js|14|22|javascript>>

<<CODE audit/vulnerable/scripts/deploy.js|84|92|javascript>>

#### PoC

<<TEST audit/test/F06-F08-admin-and-queue.test.js|PoC (vulnerable): anyone holding the public mnemonic can quote a 50x ticket and attest it WON>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F06-F08-admin-and-queue.txt|PoC (vulnerable): anyone holding the public mnemonic can quote a 50x ticket and attest it WON>>

#### Đề xuất sửa

Không có khoá mặc định. Nếu thiếu khoá qua biến môi trường, script từ chối (exit 2) trước khi chạm vào mạng. Khoá mặc định chỉ được dùng khi `DEMO_KEYS=1` **và** chainId là local (31337 hoặc 1337). Kiểm tra này chạy trước khi kết nối RPC.

#### Mã sau sửa

<<CODE scripts/deploy.js|14|45|javascript>>

#### PoC sau sửa

Trên nhánh fixed, PoC tấn công ở trên được đánh dấu **pending** (đúng thiết kế: không còn gì để tấn công). Thay vào đó, hai test dưới đây kiểm guard: chạy `deploy.js` thật, bắt exit code và thông báo, và kiểm việc từ chối `DEMO_KEYS=1` trên chainId 1 qua một RPC stub.

<<TEST audit/test/F06-F08-admin-and-queue.test.js|fixed: deploy.js refuses to run without explicit keys (exit 2, no demo fallback)>>

<<TEST audit/test/F06-F08-admin-and-queue.test.js|fixed: DEMO_KEYS=1 is refused on a non-local chain (public mnemonic never signs on a real network)>>

<<LOG audit/evidence/per-file/fixed-F06-F08-admin-and-queue.txt|fixed: deploy.js refuses to run without explicit keys (exit 2, no demo fallback)>>

<<LOG audit/evidence/per-file/fixed-F06-F08-admin-and-queue.txt|fixed: DEMO_KEYS=1 is refused on a non-local chain (public mnemonic never signs on a real network)>>

#### Đánh giá sau sửa

- Guard đã hoạt động cho cả hai trường hợp: không có khoá và `DEMO_KEYS=1` trên chainId 1.
- Phần còn lại: khoá production phải được tạo và lưu ngoài repo (KMS/HSM). Đây là việc vận hành (mục 6).
- Test PoC gốc chỉ chạy trên nhánh vulnerable (ở nhánh fixed nó được đánh dấu pending, đúng thiết kế).

---

### 4.8 F-08 — Sink tuỳ ý và approve vô hạn không thu hồi

**Mức độ:** High (phụ thuộc quyền owner). **Loại:** ăn cắp qua allowance.

#### Mô tả và nguyên nhân gốc

`setRevenueSink(s)` làm hai việc: đặt `revenueSink = s` và `approve(s, type(uint256).max)`. Nó không kiểm `s` có phải contract hay không, và không thu hồi approve của sink cũ khi đổi. Hệ quả:

- Nếu owner đặt sink là một EOA, EOA đó có thể gọi `transferFrom` và kéo toàn bộ USDC của House, gồm pool và stake đang mở.
- Sau khi đổi sink, sink cũ vẫn có approve vô hạn và vẫn kéo được tiền.

#### Kịch bản khai thác

1. Owner (hoặc kẻ đã chiếm quyền owner) gọi `setRevenueSink(EOA)`.
2. EOA gọi `transferFrom(House, EOA, balance)` → nhận 102,000 USDC.
3. Hoặc: owner đổi sink sang contract mới, sink cũ vẫn kéo được phần còn lại.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|392|398|solidity>>

<<CODE audit/vulnerable/contracts/DiamondOptions.sol|292|298|solidity>>

#### PoC

<<TEST audit/test/F06-F08-admin-and-queue.test.js|owner points revenueSink at an EOA: the EOA drains House, including open player stakes>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F06-F08-admin-and-queue.txt|owner points revenueSink at an EOA: the EOA drains House, including open player stakes>>

#### Đề xuất sửa

1. `require(s.code.length > 0)`: sink phải là contract.
2. Khi đổi sink, thu hồi approve của sink cũ (`approve(old, 0)`).
3. Không approve vô hạn. Approve đúng số tiền cho mỗi lần `notifyRevenue`, dùng một lần.
4. Đổi quoter và verifier phải qua timelock 2 ngày (`proposeX` / `executeX`). Lần thiết lập đầu tiên vẫn tức thì để script deploy chạy được.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|337|337|solidity>>

<<CODE contracts/DiamondHouse.sol|470|505|solidity>>

#### PoC sau sửa

<<TEST audit/test/F06-F08-admin-and-queue.test.js|owner points revenueSink at an EOA: the EOA drains House, including open player stakes>>

Nhánh fixed kiểm: đặt EOA làm sink bị từ chối, EOA không rút được gì, và allowance của sink cũ bằng 0 sau khi đổi.

<<LOG audit/evidence/per-file/fixed-F06-F08-admin-and-queue.txt|owner points revenueSink at an EOA: the EOA drains House, including open player stakes>>

#### Đánh giá sau sửa

- EOA không còn rút được. Allowance của sink cũ bằng 0.
- Phần còn lại: owner vẫn đổi được sink (sau khi kiểm mã). Đây là quyền vận hành cần timelock hoặc multisig (mục 6).

---

### 4.9 F-09 — `ttl` không nằm trong chữ ký quote

**Mức độ:** High (kinh tế). **Loại:** người mua chọn thời hạn để có EV dương.

#### Mô tả và nguyên nhân gốc

Giá (multiplier) của quote được định theo một thời hạn τ = 60 giây (`engine/pricer.js`). Nhưng typehash của quote không chứa `ttl`. `buyTicket(q, sig, minMult, ttl)` nhận `ttl` từ người gọi và không kiểm với giá đã định. Cùng một quote, người mua có thể chọn ttl = 30 hoặc ttl = 300 giây.

Với giá định theo τ = 60, EV của người mua thay đổi mạnh theo ttl. Đây là lỗ hổng định giá: house trả tiền cho sự chênh lệch.

#### Kịch bản khai thác

1. Quoter ký một quote với giá định theo τ = 60.
2. Người mua gọi `buyTicket` với ttl = 30 (nếu vé ngắn hạn có EV dương cho người mua).
3. Với σ = 0.0004, EV của người mua là +33.5% ở ttl 30, −4.0% ở ttl 60, −31.5% ở ttl 120, −56.5% ở ttl 300. Bảng đầy đủ cho cả σ = 0.0002, 0.0004 và 0.0008 nằm trong log PoC bên dưới. Người mua chọn ttl có EV dương.

#### Mã lỗi (mã gốc)

Typehash không có `ttl`:

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|74|77|solidity>>

Hàm mua vé nhận `ttl` từ người gọi và không ràng buộc với chữ ký:

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|173|176|solidity>>

Quoter off-chain cũng không có `ttl` trong kiểu dữ liệu ký:

<<CODE audit/vulnerable/engine/quoter.js|3|6|javascript>>

#### PoC

<<TEST audit/test/F09-F10-quote-binding.test.js|the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice>>

<<TEST audit/test/F09-F10-quote-binding.test.js|economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F09-F10-quote-binding.txt|the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice>>

<<LOG audit/evidence/per-file/vulnerable-F09-F10-quote-binding.txt|economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)>>

#### Đề xuất sửa

Đưa `ttl` vào typehash và vào kiểu dữ liệu của quoter. Khi mua, `require(q.ttl == ttl, "ttl mismatch")`. Quoter bắt buộc có `ttl` khi ký.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|81|84|solidity>>

<<CODE contracts/DiamondHouse.sol|212|216|solidity>>

<<CODE engine/quoter.js|1|18|javascript>>

#### PoC sau sửa

<<TEST audit/test/F09-F10-quote-binding.test.js|the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice>>

<<LOG audit/evidence/per-file/fixed-F09-F10-quote-binding.txt|the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice>>

Bảng EV được giữ lại trong test làm bằng chứng giá trị kinh tế của lỗi:

<<LOG audit/evidence/per-file/fixed-F09-F10-quote-binding.txt|economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)>>

#### Đánh giá sau sửa

- Mọi ttl khác với ttl đã ký bị từ chối bằng `ttl mismatch`.
- Phần còn lại: giá định theo τ = 60 vẫn là một giả định. Nếu thị trường thực có σ khác, cần định giá lại (mục 6).

---

### 4.10 F-10 — Quote dùng lại trong cửa sổ hiệu lực

**Mức độ:** Medium. **Loại:** tích tụ exposure ở giá cũ.

#### Mô tả và nguyên nhân gốc

`buyTicket` không đánh dấu quote đã dùng. Một quote hợp lệ mua được nhiều vé cho đến khi hết `validUntil`. Mọi lần mua dùng cùng giá, nên exposure của house tích tụ ở một giá có thể đã cũ.

#### Kịch bản khai thác

1. Người mua có một quote hợp lệ có giá tốt.
2. Hắn gọi `buyTicket` nhiều lần với cùng một quote, mỗi lần một stake.
3. House chịu exposure N × stake ở cùng một giá.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|173|213|solidity>>

#### PoC

<<TEST audit/test/F09-F10-quote-binding.test.js|one signed quote buys N tickets inside its validity window>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F09-F10-quote-binding.txt|one signed quote buys N tickets inside its validity window>>

#### Đề xuất sửa

Băm chữ ký thành `digest` và lưu `quoteUsed[digest] = true`. Mỗi quote chỉ dùng một lần.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|218|228|solidity>>

#### PoC sau sửa

<<TEST audit/test/F09-F10-quote-binding.test.js|one signed quote buys N tickets inside its validity window>>

<<LOG audit/evidence/per-file/fixed-F09-F10-quote-binding.txt|one signed quote buys N tickets inside its validity window>>

#### Đánh giá sau sửa

- Chỉ 1 trong 5 lần mua được chấp nhận, các lần còn lại báo `quote used`.
- Phần còn lại: một quote vẫn có thể bị dùng trong lúc giá đã đổi, nếu quote có `validUntil` dài. Đề xuất giữ `validUntil` ngắn.

---

### 4.11 F-11 — Head-of-line DoS khi token từ chối chuyển

**Mức độ:** Medium (High nếu token có blocklist, như USDC thật). **Loại:** DoS hàng đợi và settlement.

#### Mô tả và nguyên nhân gốc

`_payQueue` và các đường trả tiền trực tiếp dùng `require(usdc.transfer(...))`. Hàng đợi là FIFO và không được bỏ qua người đầu hàng. Nếu người đầu hàng bị token từ chối (blocklist, pause), mọi lần `_payQueue` đều revert. Mọi settlement có trả tiền, harvest và refund đều revert theo. Pool kẹt vĩnh viễn trong khi những người khác không nhận được gì.

#### Kịch bản khai thác

1. Người chơi (hoặc kẻ tấn công) có một vé được xếp vào hàng đợi. Địa chỉ của họ bị blocklist (hoặc token bị pause cho địa chỉ đó).
2. Mọi lần `settle` có trả tiền và `harvest` đi qua người đầu hàng và revert.
3. Pool không được giải phóng, mọi vé khác không settle được.

#### Mã lỗi (mã gốc)

Đường trả tiền trực tiếp:

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|250|265|solidity>>

Hàng đợi:

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|302|320|solidity>>

Options có cùng mẫu:

<<CODE audit/vulnerable/contracts/DiamondOptions.sol|267|276|solidity>>

#### PoC

<<TEST audit/test/F11-F14-ops-and-economics.test.js|blocked queue head halts all settlements while pool > 0>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt|blocked queue head halts all settlements while pool > 0>>

#### Đề xuất sửa

1. Chuyển tiền bằng `call` cấp thấp (`_send`). Nếu token từ chối, ghi có số tiền cho người nhận (`credits[to]`, `totalCredits`) thay vì revert.
2. Người nhận rút credit bằng `withdrawCredit()` khi được gỡ blocklist.
3. `totalCredits` được tính vào nợ trong bất biến solvency (F-01).
4. Gas floor: `_send` revert nếu gas còn lại dưới 60,000, để kẻ gọi không thể cố tình cấp ít gas để biến thanh toán thành credit.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|342|364|solidity>>

<<CODE contracts/DiamondHouse.sol|85|85|solidity>>

<<CODE contracts/DiamondOptions.sol|290|312|solidity>>

#### PoC sau sửa

<<TEST audit/test/F11-F14-ops-and-economics.test.js|blocked queue head halts all settlements while pool > 0>>

Test trên nhánh fixed kiểm thêm: sau khi gỡ blocklist, người bị blocklist gọi `withdrawCredit()` và nhận đúng số đã ghi có.

<<LOG audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt|blocked queue head halts all settlements while pool > 0>>

#### Đánh giá sau sửa

- Hàng đợi tiếp tục chạy. Harvest trả được người khác.
- Credit rút được đúng số sau khi gỡ blocklist.
- Phần còn lại: người bị blocklist không nhận được tiền cho đến khi được gỡ. Đây là hành vi của token, không phải của protocol.

---

### 4.12 F-12 — Queue entry bằng 0 và chữ ký rỗng khi chưa đặt budgetAttester

**Mức độ:** Low. **Loại:** vệ sinh, nhưng (b) cho phép đăng epoch không có chữ ký hợp lệ.

#### Mô tả và nguyên nhân gốc

**(a)** `_enqueue` không kiểm `amount == 0`. Vé thắng 1 wei với `queueDebt > 0` tạo ra entry bằng 0 trong hàng đợi. Entry đó chiếm chỗ và làm rối hàng đợi.

**(b)** `postEpoch` kiểm `_rec(h, budgetSig) == budgetAttester`. Khi `budgetAttester == 0`, `_rec` trả về 0 với chữ ký không hợp lệ, và `0 == 0` nên được chấp nhận. Khi owner quên đặt budgetAttester, mọi chữ ký không hợp lệ đều cho `_rec` = 0 và được chấp nhận (test dùng chữ ký 65 byte bằng 0).

#### Kịch bản khai thác

**(a)** Kẻ tấn công cược 1 wei và thắng khi hàng đợi đang có nợ. Entry 0 được thêm vào hàng đợi.

**(b)** Nếu `budgetAttester` chưa đặt, kẻ tấn công (hoặc owner vô tình) gọi `postEpoch` với chữ ký 65 byte bằng 0 và được chấp nhận.

#### Mã lỗi (mã gốc)

Hàng đợi không kiểm 0:

<<CODE audit/vulnerable/contracts/DiamondHouse.sol|303|307|solidity>>

Chữ ký không kiểm `budgetAttester != 0`:

<<CODE audit/vulnerable/contracts/DiamondDistributor.sol|116|117|solidity>>

#### PoC

<<TEST audit/test/F11-F14-ops-and-economics.test.js|(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry>>

<<TEST audit/test/F11-F14-ops-and-economics.test.js|(b) postEpoch accepts an all-zero signature while budgetAttester is unset>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt|(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry>>

<<LOG audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt|(b) postEpoch accepts an all-zero signature while budgetAttester is unset>>

#### Đề xuất sửa

**(a)** `if (amount == 0) return;` trong `_enqueue`.
**(b)** `require(budgetAttester != address(0), "no budget attester")` trước khi kiểm chữ ký.

#### Mã sau sửa

<<CODE contracts/DiamondHouse.sol|365|369|solidity>>

<<CODE contracts/DiamondDistributor.sol|119|122|solidity>>

#### PoC sau sửa

<<TEST audit/test/F11-F14-ops-and-economics.test.js|(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry>>

<<TEST audit/test/F11-F14-ops-and-economics.test.js|(b) postEpoch accepts an all-zero signature while budgetAttester is unset>>

<<LOG audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt|(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry>>

<<LOG audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt|(b) postEpoch accepts an all-zero signature while budgetAttester is unset>>

#### Đánh giá sau sửa

- (a) không còn entry 0 (1 → 1 entry).
- (b) bị từ chối với `no budget attester`.

---

### 4.13 F-13 — Doanh thu bị kẹt khi chưa có staker

**Mức độ:** Medium. **Loại:** kẹt tiền vĩnh viễn.

#### Mô tả và nguyên nhân gốc

`RevenueSplit.notifyRevenue` nhận USDC từ House, nhưng chỉ cộng vào index khi `totalStaked > 0`. Khi không có staker, USDC nằm trong contract và không có đường nào phát đi. Staker đến sau cũng không claim được phần đó.

#### Kịch bản khai thác

Đây không phải kịch bản tấn công, mà là lỗi làm mất tiền do thiết kế: owner gọi `distributeRevenue` khi chưa có staker, và tiền bị kẹt. Có thể xảy ra tự nhiên khi giai đoạn đầu chưa có ai stake.

#### Mã lỗi (mã gốc)

<<CODE audit/vulnerable/contracts/RevenueSplit.sol|85|92|solidity>>

#### PoC

<<TEST audit/test/F11-F14-ops-and-economics.test.js|owner distributes revenue to an empty staking set; USDC is stranded forever>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt|owner distributes revenue to an empty staking set; USDC is stranded forever>>

#### Đề xuất sửa

Khi `totalStaked == 0`, cộng vào `carry`. Staker đầu tiên khởi động stream từ `carry` (`_addToStream` cộng `carry` và reset về 0).

#### Mã sau sửa

<<CODE contracts/RevenueSplit.sol|148|160|solidity>>

#### PoC sau sửa

<<TEST audit/test/F11-F14-ops-and-economics.test.js|owner distributes revenue to an empty staking set; USDC is stranded forever>>

<<LOG audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt|owner distributes revenue to an empty staking set; USDC is stranded forever>>

#### Đánh giá sau sửa

- Staker đến sau nhận được 999.999999 USDC sau 7 ngày. Chênh lệch 1 wei là làm tròn có lợi cho contract.

---

### 4.14 F-14 — Ledger tính phí hai lần và trần 200% cho farm

**Mức độ:** High. **Loại:** farm DIAMOND có lãi, không cần vốn đáng kể.

#### Mô tả và nguyên nhân gốc

Ở `engine/ledger.js`, `payout` đã trừ phí (phí được giữ lại khi trả thưởng). Vì vậy `edge = stakeSum − paySum` **đã bao gồm phí**. Nhưng `anchor = feeSum + edge` lại cộng phí thêm một lần. Anchor bằng gấp đôi thực tế. Anchor quyết định budget mint DIAMOND. Ngoài ra, `LAUNCH_RATE_BPS = 20000` và `R_MAX_BPS = 20000` cho phép mint tới 200% doanh thu thực.

Kết quả: một cặp hedge tự tài trợ (long thắng, short thua) có thể mint nhiều DIAMOND hơn số tiền đã trả cho house.

#### Kịch bản khai thác

1. Farmer mở hai vị thế đối nghịch có cùng notional, M = 1.92 (hoặc 1.99).
2. Một bên thắng, bên kia thua. Farmer thêm một vé nhỏ để đủ điều kiện nhận weight.
3. Ledger tính anchor gấp đôi, rate LAUNCH là 200%, và farmer nhận DIAMOND có giá trị cao hơn chi phí.

#### Mã lỗi (mã gốc)

Ledger (off-chain):

<<CODE audit/vulnerable/engine/ledger.js|12|16|javascript>>

<<CODE audit/vulnerable/engine/ledger.js|50|58|javascript>>

Trần trên contract:

<<CODE audit/vulnerable/contracts/DiamondDistributor.sol|36|39|solidity>>

#### PoC

<<TEST audit/test/F11-F14-ops-and-economics.test.js|ledger anchor vs realized house P&L on the reference epoch>>

<<TEST audit/test/F11-F14-ops-and-economics.test.js|self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate>>

#### Log PoC trên mã gốc

<<LOG audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt|ledger anchor vs realized house P&L on the reference epoch>>

<<LOG audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt|self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate>>

#### Đề xuất sửa

1. `anchor = edge` (một lần, không cộng phí thêm).
2. `LAUNCH_RATE_BPS` và `R_MAX_BPS` về 100%: không bao giờ mint nhiều hơn doanh thu thực.

#### Mã sau sửa

<<CODE engine/ledger.js|13|17|javascript>>

<<CODE engine/ledger.js|50|60|javascript>>

<<CODE contracts/DiamondDistributor.sol|44|47|solidity>>

#### PoC sau sửa

<<TEST audit/test/F11-F14-ops-and-economics.test.js|ledger anchor vs realized house P&L on the reference epoch>>

<<TEST audit/test/F11-F14-ops-and-economics.test.js|self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate>>

<<LOG audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt|ledger anchor vs realized house P&L on the reference epoch>>

<<LOG audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt|self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate>>

#### Đánh giá sau sửa

- Anchor bằng đúng P&L thực (200 USDC).
- Farmer hoà vốn (net −0.00 và 0.00), không lãi.
- Phần còn lại: farm ở mức hoà vốn vẫn nhận DIAMOND tương đương phí đã trả. Đây là quyết định thiết kế kinh tế (mục 6).
- Hạn chế: PoC này kiểm ở tầng engine off-chain. Nó không chứng minh contract đã được bảo vệ tuyệt đối trước việc anchor sai, vì contract chỉ kiểm budget theo anchor do budgeter ký.

---

## 5. Các điểm đã đánh giá nhưng chưa có PoC

Mục này liệt kê những gì tôi đã phân tích nhưng **chưa viết PoC**. Tôi không ghi chúng là "đã xác nhận".

| ID | Mức | Mô tả | Lý do chưa có PoC | Hướng xử lý |
|---|---|---|---|---|
| H5 | Low | `lpRequestExit` đặt lại `lpExitAvailableAt = now + LP_LOCK` cho toàn bộ share đang chờ của người gọi (`DiamondHouse.sol` L346–352 mã gốc). Người dùng có thể tự gia hạn lock của chính mình. | Chỉ tự gây hại, không ăn cắp tiền của người khác. | Có thể giữ nguyên, hoặc chỉ đặt lock cho phần share mới. |
| D2 | Low | Chữ ký budget không bind `chainid` và địa chỉ contract. | Đã vá bằng `budgetHash` (F-03). Chưa viết PoC riêng. | Đã vá. |
| V1 | Medium (phụ thuộc owner) | `setAttester` (`Verifiers.sol` L48–52, L141–145) không timelock, không kiểm số attester ≥ threshold. Owner có thể thêm attester của mình để đủ quorum, hoặc gỡ attester để làm mọi settle revert. | Đây là quyền owner, không phải lỗ hổng kỹ thuật. Cần quyết định governance. | Multisig + timelock; kiểm `count ≥ threshold` khi gỡ. |
| O3 | Medium (phụ thuộc attester) | `settleWithPrice` tin `closePx` do attester ký, không ràng buộc thời điểm đóng. Attester có thể ký giá cũ hoặc giá mới để đổi kết quả. | Cần đặc tả oracle (thời điểm, nguồn giá) trước khi viết PoC có ý nghĩa. | Ràng buộc `closePx` với timestamp và nguồn giá trong chữ ký. |
| Gov-1 | Medium | Owner có thể đổi sink, verifier (đã có timelock sau F-08), attester, minter, targetPool, budgetAttester, classCfg mà không timelock. | Đây là mô hình quyền, không phải một lỗi trong một hàm. | Multisig, timelock, và ghi rõ trong README. |
| N1 | Low | `setClassCfg` "tighten-only" có thể bị bypass bằng disable → nâng cap → enable. | Cap chỉ kiểm lúc mua vé, nên không ảnh hưởng vé đang mở. Đây là quyết định governance. | Xem mục 6. |
| N2 | Medium (kinh tế) | Nạp LP khi NAV = 0 (sau F-06) và `totalShares > 0`: người nạp mới nhận gần như toàn bộ lợi nhuận tương lai so với LP cũ đã bị xoá sạch. | Không ăn cắp tiền đã thực hiện, chỉ chia lại lợi nhuận tương lai. Chặn có thể cản việc bơm vốn cứu hàng đợi. | Mục 6. |

---

## 6. Rủi ro còn lại và quyết định cần người dùng chốt

### 6.1 Đã vá trong mã (tóm tắt)

Virtual shares (F-04/F-05); solvency `>=` và `sweepSurplus` (F-01); NAV trừ `queueDebt` (F-06); `_send` + credit + gas floor (F-11); streaming 7 ngày và carry (F-02/F-13); ttl và quote single-use trong chữ ký (F-09/F-10); `budgetHash`, cap theo epoch và kiểm budget attester (F-03/F-12b/D2); anchor = edge và trần 100% (F-14); sink có kiểm mã và thu hồi approve, timelock 2 ngày cho quoter/verifier (F-08); deploy guard không có khoá mặc định (F-07); queue không ghi entry 0 (F-12a).

### 6.2 Quyết định cần người dùng

1. **Governance (Gov-1, V1):** owner có được đổi attester, budgetAttester, sink, minter, targetPool mà không timelock không? Nếu không, cần multisig và timelock, và README phải ghi rõ mức tin cậy.
2. **N1 (tighten-only):** có cấm nới cap class đã từng bật không? Cách đơn giản là kiểm `old.maxMultX1e4 != 0` thay vì `old.enabled`.
3. **N2 (LP tại NAV = 0):** chặn nạp khi NAV = 0, hay cho phép để bơm vốn trả hàng đợi?
4. **F-14 ở 100%:** chấp nhận farm hoà vốn không, hay giảm thêm trần và LAUNCH rate?
5. **Khoá production:** tạo ngoài repo (KMS/HSM), tách quoter, attester và budgeter ra các máy khác nhau, và không dùng bất kỳ mnemonic nào.
6. **Giá định theo τ = 60 (F-09):** giả định σ = 0.0004 có khớp dữ liệu thị trường không? Nếu không, định giá lại.

---

## 7. Kiểm chứng tổng hợp và giới hạn

### 7.1 Kết quả chạy cuối

| Lệnh | Kết quả | File log |
|---|---|---|
| `npm run audit:poc` (mã gốc) | 18 passing, 2 pending, EXIT 0 | `audit/evidence/poc-vulnerable-final.txt` |
| `npm run audit:regress` (mã vá) | 19 passing, 1 pending, EXIT 0 | `audit/evidence/regress-fixed-final.txt` |
| `npm test` (suite gốc) | diamond 133 passed / 0 failed; engine 51 passed / 0 failed; fuzz SEED=1337 OK (160 kiểm tra, 34 buys, 24 settles, 8 stall refunds, 47 harvests), EXIT 0 | `audit/evidence/root-suite-run.txt` |
| Từng file, mã gốc | Chi tiết theo file | `audit/evidence/per-file/vulnerable-*.txt` |
| Từng file, mã vá | Chi tiết theo file | `audit/evidence/per-file/fixed-*.txt` |

Các pending có ý nghĩa: trên mã gốc, 2 pending là test guard của F-07 (chỉ có ý nghĩa trên mã vá). Trên mã vá, 1 pending là PoC F-07 (chỉ có ý nghĩa trên mã gốc). Đây là thiết kế, không phải lỗi.

### 7.2 Cảnh báo không ảnh hưởng kết quả

Khi chạy suite gốc có dòng `Cannot find module '../binaries/uws_linux_x64_127.node'`. Đây là cảnh báo của ganache (uWebSockets không có binary cho Node này). Ganache tự chuyển sang triển khai NodeJS và test vẫn chạy đầy đủ.

### 7.3 Lỗi harness đã sửa trong quá trình audit

Trước đây `audit/lib/world.js` ghim cứng set `"fixed"` cho `DiamondToken`, `MockUSDC` và `DiamondDistributor`. Nhánh vulnerable có thể dùng nhầm mã đã vá. Đã sửa để mọi contract đều dùng `SET`. Log chạy trước khi sửa được để trong `audit/evidence/superseded/` và không dùng làm bằng chứng.

### 7.4 Giới hạn

- **Không dùng Foundry.** Sandbox chặn tải binary Foundry và solc. Dùng Hardhat 2.22 + solc-js 0.8.26. Không có fuzz/invariant kiểu Foundry.
- **"Chain local" là Hardhat network trong tiến trình**, không phải node anvil hay ganache riêng. `scripts/deploy.js` chưa được chạy end-to-end trên một node local. Chỉ kiểm guard.
- **Fuzz không phải bằng chứng đầy đủ.** `test/fuzz.js` coi mọi revert là "expected". Đã có một lần lỗi chữ ký làm fuzz vô hiệu (0 lần mua, vẫn báo OK) và đã sửa. Cần siết lại để chỉ chấp nhận revert có lý do dự kiến.
- **Không kiểm riêng ECDSA malleability.** Đã giảm rủi ro nhờ `quoteUsed` theo digest, nhưng chưa có test riêng.
- **Không có mô hình hình thức (formal verification).**
- **Engine off-chain** chỉ kiểm theo ví dụ và công thức trong tài liệu, không kiểm mọi đầu vào.
- **Không đánh giá vận hành** (quản lý khoá, hạ tầng oracle/attester, monitoring, incident response).
- **Tính "không còn lỗi khác" không được chứng minh.** Báo cáo chỉ khẳng định: các lỗi liệt kê đã được tái hiện, đã vá và đã kiểm lại, và các đường tiền đã rà soát không có lỗi nào khác được phát hiện trong phạm vi và phương pháp ở mục 2.

---

## 8. Phụ lục

### A. Diff bản vá

Toàn bộ diff so với commit gốc `3cb964b` (contracts, engine, scripts, README) nằm trong `audit/report/fixes.diff`.

Thống kê thay đổi:

<<DIFFSTAT>>

### B. Log đầy đủ

Log đầy đủ của lần chạy cuối (không cắt) nằm trong `audit/evidence/`:

- `poc-vulnerable-final.txt`: toàn bộ 18 PoC trên mã gốc.
- `regress-fixed-final.txt`: toàn bộ 19 test trên mã vá.
- `root-suite-run.txt`: suite gốc (diamond, engine, fuzz).

### C. Manifest SHA-256

Băm của các file bằng chứng và file test, để kiểm tra không bị sửa:

<<MANIFEST>>

### D. Thuật ngữ

- **Lane / bất biến solvency:** tổng số dư contract phải không nhỏ hơn tổng nghĩa vụ nội bộ (pool, stake đang mở, credit).
- **NAV (giá trị tài sản ròng):** phần pool thuộc về LP sau khi trừ nợ ưu tiên (queue).
- **queueDebt:** tổng tiền thắng cược đang chờ trong hàng đợi (nợ ưu tiên).
- **Virtual shares/assets:** số share và tài sản ảo, thêm vào công thức để chống inflation kiểu ERC-4626.
- **JIT stake:** stake ngay trước một sự kiện phí, rồi rút sau đó.
- **Carry:** phần phí nhận khi chưa có staker, giữ lại đến khi có staker đầu tiên.
- **Quorum (N-of-M):** số chữ ký tối thiểu từ attester để xác nhận một kết quả.
- **EV:** giá trị kỳ vọng của người mua trên mỗi đơn vị stake.
- **τ (tau):** thời hạn định giá (60 giây) mà quote được tính theo.
