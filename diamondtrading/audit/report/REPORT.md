# Báo cáo audit bảo mật — `diamondtrading/` (go-f3)

> Bản chi tiết (PoC đầy đủ, log, mã lỗi, bản vá, retest, phụ lục SHA-256) nằm trong `audit/report/WHITEPAPER.md`, sinh từ `WHITEPAPER.src.md` bằng `build_whitepaper.py`. File này là bản tóm tắt.


| | |
|---|---|
| Repo / nhánh | `marssapcex/go-f3` / `arena/a5d74a8e-go-f3` |
| Commit gốc được audit | `3cb964b` (main) |
| Ngày | 2026-10-24 |
| Phạm vi | `contracts/` (DiamondHouse, DiamondOptions, DiamondDistributor, RevenueSplit, DiamondToken, MockUSDC, Verifiers), `engine/` (ledger, pricer, quoter, caps), `scripts/deploy.js` |
| Mục tiêu | Tìm mọi lỗi có thể **ăn cắp / đóng băng tiền** của dự án hoặc người dùng khi triển khai |
| Môi trường | Chain local (Hardhat network, chainId 31337). Không gửi tiền thật, không deploy mạng công cộng |

---

## 0. Tóm tắt điều hành

Đã tìm được **14 nhóm lỗi (F-01 … F-14)** và thêm các điểm rủi ro governance/kinh tế (mục 4–5). Mỗi nhóm lỗi:

- có **PoC chạy được** trên mã gốc (nhánh `vulnerable`, snapshot byte-identical của `3cb964b`) — **18/18 PoC tái hiện lỗi**;
- đã được **vá** trong mã production (`contracts/`, `engine/`, `scripts/`);
- được **kiểm lại** trên mã đã vá (nhánh `fixed`) — **19 pass, 1 pending** (PoC F-07 chỉ có nghĩa trên nhánh vulnerable, đúng thiết kế), **0 fail**.

| ID | Mức | Tiêu đề | Vị trí lỗi (mã gốc `3cb964b`) | Ăn cắp / đóng băng | PoC vulnerable | Retest fixed |
|---|---|---|---|---|---|---|
| F-01 | High | 1 wei donation đóng băng toàn bộ House/Options | `DiamondHouse.sol` L149–150, các `require(lanesIntact())` L212, 268, 280, 329, 343, 365, 382; `DiamondOptions.sol` L119–120 | Đóng băng ~100,150 USDC | PASS (tái hiện) | PASS |
| F-02 | High | JIT-stake ăn gần như toàn bộ phí staker | `RevenueSplit.sol` L85–92 | **Ăn cắp** của staker (90% phí) | PASS | PASS |
| F-03 | Critical¹ | Distributor không ràng buộc claim ≤ budget đã ký | `DiamondDistributor.sol` L118, L127–138 | **Mint vô hạn** tới CAP (1e9 DIAMOND) | PASS | PASS |
| F-04 | High | Chiếm pool mồ côi bằng 1 wei | `DiamondHouse.sol` L333–336 | **Ăn cắp** ~1000 USDC của người chơi thua | PASS | PASS |
| F-05 | High | Share inflation (donation) → victim mất tiền | `DiamondHouse.sol` L336 (làm tròn xuống) | **Ăn cắp** 499.5 USDC của victim | PASS | PASS |
| F-06 | High | `lpWithdraw` bỏ qua `queueDebt` | `DiamondHouse.sol` L360–363 | **Ăn cắp** của người thắng đang chờ (100 USDC) | PASS | PASS |
| F-07 | Critical² | Khoá ký deploy được derive từ mnemonic công khai | `scripts/deploy.js` L17, L90 | **Ăn cắp** 48,044.9 USDC từ pool 100,000 | PASS | PASS (guard exit 2) |
| F-08 | High³ | `setRevenueSink(EOA)` + approve max không thu hồi | `DiamondHouse.sol` L394–396; `DiamondOptions.sol` L294–296 | **Ăn cắp** 102,000 USDC (gồm stake mở) | PASS | PASS |
| F-09 | High | `ttl` không nằm trong chữ ký quote | `DiamondHouse.sol` L76, L173; `DiamondOptions.sol` L151; `engine/quoter.js` | **Kinh tế**: người mua chọn ttl → EV +33.5% cho người mua | PASS | PASS |
| F-10 | Medium | Quote dùng lại vô hạn lần | `DiamondHouse.sol` L173–213; `DiamondOptions.sol` L151–191 | Tích tụ exposure ở giá cũ (5/5 mua) | PASS | PASS (1/5) |
| F-11 | Medium⁴ | Head-of-line DoS khi token từ chối chuyển (blocklist) | `DiamondHouse.sol` L255, 263, 278, 318; `DiamondOptions.sol` L222, 275 | Đóng băng queue, settlement, harvest | PASS | PASS |
| F-12 | Low | (a) queue entry 0; (b) chữ ký rỗng khi `budgetAttester` chưa set | `DiamondHouse.sol` L303; `DiamondDistributor.sol` L116 | Rác trong queue; cho phép postEpoch không ký | PASS | PASS |
| F-13 | Medium | Doanh thu bị kẹt khi chưa có staker | `RevenueSplit.sol` L88–90 | Kẹt vĩnh viễn 1000 USDC | PASS | PASS |
| F-14 | High | Ledger tính phí hai lần + LAUNCH 200% → farm có lãi | `engine/ledger.js` L14, L54–55; `DiamondDistributor.sol` L38 | **Farm** +1900.36 USD (M=1.92) | PASS | PASS (net ≈ 0) |

¹ Critical nếu owner/root bị lộ; nội bộ thì High. ² Critical **nếu** hệ thống được deploy bằng khoá công khai; trên chain demo thì là rủi ro cấu hình. ³ Phụ thuộc quyền owner. ⁴ High nếu token thật có blocklist (USDC có).

**Kết luận ngắn:** Lỗi ăn cắp trực tiếp không cần quyền admin nằm ở F-02, F-04, F-05, F-06, F-09, F-10, F-14. Các lỗi cần khoá/quyền admin là F-03, F-07, F-08 và rủi ro centralization ở mục 4. Tất cả đã vá; các điểm cần **quyết định sản phẩm/governance** được liệt kê ở mục 4.2.

---

## 1. Phương pháp và môi trường

**Công cụ.**
- Hardhat 2.22.19 + `@nomicfoundation/hardhat-ethers` 3.x, network `hardhat` (EDR, chainId 31337, hardfork shanghai, 30 accounts). Cấu hình tại `audit/hardhat.config.js`.
- Biên dịch bằng `solc-js` 0.8.26 viaIR qua `audit/lib/build.js` → artifact `audit/build/{fixed,vulnerable,helpers}/`.
- **Foundry không dùng được** trong sandbox: tải binary từ `objects.githubusercontent.com`/`foundry.paradigm.xyz` bị chặn. Hardhat thay thế theo yêu cầu “Foundry hoặc Hardhat”. solc binary từ `binaries.soliditylang.org` cũng bị chặn nên dùng solc-js cục bộ.

**Cách tái lập.** (từ `diamondtrading/`)
```
npm run audit:poc       # build + PoC trên mã gốc: kỳ vọng 18 pass, 2 pending (guard fixed-only)
npm run audit:regress   # build + cùng bộ test trên mã đã vá: kỳ vọng 19 pass, 1 pending (PoC vulnerable-only)
npm test                # suite gốc: compile + diamond (133) + engine (51) + fuzz SEED=1337
```

**Kiểm tra mã và vector tấn công đã xét.** Rà soát thủ công toàn bộ đường tiền (`pay in`/`pay out`, `transferFrom`, `approve`, `notifyRevenue`, `_payQueue`, `lpDeposit`/`lpWithdraw`, `claim`, `postEpoch`, `setX`). Các vector đã thử, có PoC hoặc đã loại trừ (mục 5):

- donation / forced transfer vào contract (F-01, F-05);
- first-depositor / share inflation / rounding (F-04, F-05);
- NAV/queue ưu tiên và rút trước người thắng (F-06);
- JIT stake và timing quanh sự kiện phí (F-02);
- replay quote, thay đổi tham số ký (ttl, domain, buyer binding) (F-09, F-10, D2);
- chữ ký rỗng / signer = 0 (F-12b, và `quoterSigner != 0` đã kiểm);
- token từ chối chuyển, blocklist, DoS hàng đợi (F-11);
- địa chỉ nhận tiền là EOA / sink bị thay (F-08);
- khoá deploy công khai (F-07);
- ledger/kinh tế farm (F-14), pricing EV theo ttl (F-09);
- governance và quyền owner (mục 4.2);
- reentrancy: các hàm chuyển tiền đều `nonReentrant` (đã kiểm tra, không có vòng lặp chuyển tiền không kiểm soát).

**Fuzz.** `test/fuzz.js` (SEED=1337): 160 kiểm tra, 34 lần mua, 24 lần settle, 8 lần refund khi stall, 47 lần harvest, 15 lần trả FIFO, bất biến OK (`audit/evidence/root-suite-run.txt`). Lưu ý giới hạn ở mục 7.

---

## 2. Mô hình tin cậy

| Thực thể | Tin cậy | Ghi chú |
|---|---|---|
| Owner | Có quyền cấu hình (sink, class cap, minter, targetPool, verifier) | Xem F-08, mục 4.2 |
| Quoter / attester / budgeter (khoá ký off-chain) | Tin cậy để ký đúng | Xem F-03, F-07 |
| USDC | Chuẩn ERC20, **có thể** blocklist/pause | Xem F-11 |
| Người chơi / LP / staker | Không tin cậy | Mọi lỗi ăn cắp mà người dùng khai thác không cần quyền đặc biệt được xếp High trở lên |

---

## 3. Chi tiết các lỗi

Mỗi mục gồm: mô tả → tác động → vị trí mã (mã gốc và mã đã vá) → PoC → log → đề xuất fix đã áp dụng → retest.

Đường dẫn log: `audit/evidence/poc-vulnerable-final.txt` và `audit/evidence/regress-fixed-final.txt` (chạy đầy đủ), log từng file trong `audit/evidence/per-file/{vulnerable,fixed}-F*.txt`.

### F-01 — 1 wei donation đóng băng House và Options (High, đóng băng)

**Mô tả.** Bất biến "cash lane" dùng dấu bằng: `lanesIntact()` = `balance() == pool + openStakes`. Bất kỳ ai chuyển trực tiếp 1 wei USDC vào House đều làm bất biến sai. Mọi thao tác có `require(lanesIntact(), "lane drift")` bị revert vĩnh viễn: mua vé, settle, harvest, rút LP, refund. Không có hàm nào rút phần thừa, nên số tiền kẹt không lấy lại được.

**Vị trí.**
- Mã gốc: `DiamondHouse.sol` L149–150 (định nghĩa), kiểm tra L212, 268, 280, 329, 343, 365, 382. `DiamondOptions.sol` L119–120 (định nghĩa), L190, 227, 258, 284.
- Mã đã vá: `DiamondHouse.sol` L172–173 (solvency `>=` với `pool + openStakes + totalCredits`); `sweepSurplus` L180 (chỉ owner, chỉ phần thừa). `DiamondOptions.sol` L137, L140.

**PoC.** `audit/test/F01-donation-freeze.test.js`: “House: 1-wei donation freezes buy / settle / harvest / refund / LP exit” và “Options: 1-wei donation blocks new option sales and settlement”.

**Log (vulnerable).**
```
[EVIDENCE] attacker p5 sent 1 wei USDC to House. lanesIntact()=false
[EVIDENCE] buyTicket by honest p2            → lane drift
[EVIDENCE] settleWithProof(id, KNOCKED)      → lane drift
[EVIDENCE] harvest(1)                        → lane drift
[EVIDENCE] lpWithdraw() after 7d lock        → lane drift
[EVIDENCE] refundAfterStall(unsettled id) after stall → lane drift
[EVIDENCE] stuck USDC in House = 100150000001 (6dp) — no sweep function exists
[EVIDENCE] Options.buyOption after donation  → lane drift
```
**Log (fixed).** `lanesIntact()=true`; mọi thao tác → OK; “surplus (donation) in House = 1 wei; owed = 10000001”; sweep bởi người lạ → “not owner”; sweep bởi owner → đúng 1 wei; `lanesIntact()` vẫn true.

**Fix đã áp dụng.** Bất biến chuyển từ “bằng” sang “≥” (solvency: contract phải *giữ ít nhất* số nợ). Phần thừa do donation không khoá được protocol; owner sweep được đúng phần thừa, không chạm pool/openStakes/credits.

**Rủi ro còn lại.** Owner có thể sweep phần thừa — đúng thiết kế, nhưng cần ghi rõ trong tài liệu vận hành.

### F-02 — JIT-stake ăn phí của staker trung thực (High, ăn cắp)

**Mô tả.** `RevenueSplit.notifyRevenue` cộng phí vào `rewardIndex` ngay lập tức, chia cho tổng stake *tại thời điểm đó*. Kẻ tấn công stake 90,000 DIAMOND ngay trước khi settle một vé thắng, nhận gần như toàn bộ phí, rồi rút stake.

**Vị trí.** Mã gốc `RevenueSplit.sol` L85–92 (`rewardIndex += amount * 1e18 / totalStaked`, không có stream). Mã đã vá: `RevenueSplit.sol` L85–108 (`_update`, `_addToStream` — stream 7 ngày, `SCALE = 1e36`), L150–157 (`notifyRevenue` có carry).

**PoC.** `audit/test/F02-jit-stake-reward-theft.test.js`: “attacker staking 9x the honest stake right before a fee event takes ~90% of the fee”.

**Log (vulnerable).**
```
fee streamed to stakers (rewardIndex delta) ≈ 399 USDC
attacker (90k DIAMOND, staked 0s) claimable=359100000 paid=359100000 (base units, 6dp)
honest (10k DIAMOND, staked since genesis) earned=39900000 (base units, 6dp) after the 7d stream
attacker share of the single fee event = 90.00%
```
**Log (fixed).** `attacker … claimable=0 paid=593 (base units)`; `honest … earned=398998812 (base units) after the 7d stream`; `attacker share … = 0.00%`.

**Fix đã áp dụng.** Phí được *stream* tuyến tính trong 7 ngày; người stake sau chỉ nhận phần thời gian đã stake (pro-rata theo thời gian). Khi `totalStaked == 0` stream bị tạm dừng và bảo toàn phần còn lại (xem mục 5). Phần phí chưa có người nhận được giữ bằng `carry` (F-13).

### F-03 — Distributor không ràng buộc claim theo budget đã ký (Critical nếu root lộ / High nội bộ)

**Mô tả.** `postEpoch` kiểm `totalMint <= budget` (budget do budgeter ký từ anchor × rate). Nhưng `claim()` chỉ kiểm Merkle proof và tổng CAP toàn cục, không so với `totalMint` của epoch. Ai đăng Merkle root (owner) có thể gán số lượng tuỳ ý cho bất kỳ địa chỉ nào, vượt xa budget.

**Vị trí.** Mã gốc `DiamondDistributor.sol` L118 (`require(totalMint <= budget)`), L127–138 (`claim`, `totalMinted += amount` L135, không có `epochClaimed`). Mã đã vá: L121 (`budgetAttester != 0`, F-12b), L137–146 (`claim`: `epochClaimed[epochId] + amount <= e.totalMint`, “epoch budget exhausted”), L178 (`budgetHash`, D2).

**PoC.** `audit/test/F03-distributor-unbounded-claims.test.js`: “owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000”.

**Log (vulnerable).**
```
signed anchor=$100, price=$0.01 → on-chain budget = 20000.0 DIAMOND
postEpoch(totalMint=20000.0 DIAMOND) accepted
attacker claim(1,000,000 DIAMOND) → OK; attacker balance = 1000000.0 DIAMOND
dist.totalMinted = 1000000.0 DIAMOND vs epoch budget 20000.0
```
**Log (fixed).** `budget = 10000.0 DIAMOND` (rate 100%); `attacker claim(1,000,000) → epoch budget exhausted; balance = 0.0`; `totalMinted = 0.0`.

**Fix đã áp dụng.** Đếm lũy kế theo epoch (`epochClaimed`) và chặn vượt `totalMint`; mỗi địa chỉ chỉ claim một lần (`claimed`).

**Rủi ro còn lại.** Owner vẫn có thể đăng root đúng budget cho địa chỉ của mình (trong giới hạn budget). Điều này cần quy trình ký budget độc lập (xem mục 8).

### F-04 — Chiếm pool mồ côi bằng 1 wei (High, ăn cắp)

**Mô tả.** Khi `totalShares == 0` nhưng `pool > 0` (pool có USDC từ người chơi thua nhưng chưa có LP nào), nhánh `if (totalShares == 0 || pool == 0) shares = amount;` cho người nạp 1 wei đúng 1 share = 100% pool. Sau khoá 7 ngày, người đó rút toàn bộ pool.

**Vị trí.** Mã gốc `DiamondHouse.sol` L333–336 (`lpDeposit`, nhánh `shares = amount`). Mã đã vá: L400 (`VIRTUAL_SHARES = 1e6`), L405–406 (`shares = amount × (totalShares + VS) / (navPool + VA)`, `require(shares > 0, "dust")`).

**PoC.** `audit/test/F04-F05-lp-vault-theft.test.js`: “1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock”.

**Log (vulnerable).**
```
pool after loss = 1000000000 (6dp), totalShares = 0
attacker lpDeposit(1 wei) → OK; shares = 1
attacker paid 1 wei + gas, withdrew 1000000001 (6dp) = 1000.000001 USDC of player losses
```
**Log (fixed).** `attacker lpDeposit(1 wei) → dust; shares = 0`.

**Fix đã áp dụng.** Virtual shares/assets (kiểu ERC-4626 chống inflation). 1 wei không tạo đủ share; phần “ảo” không rút được.

### F-05 — Share inflation qua donation (High, ăn cắp)

**Mô tả.** Kẻ tấn công giữ 1 share, đưa 2000 USDC vào pool bằng cược thua (phần đó làm tăng NAV), rồi nạp tiếp của victim. Công thức `shares = amount × totalShares / pool` làm tròn xuống, nên victim nhận rất ít share trong khi phần giá trị của họ bị chia cho kẻ tấn công.

**Vị trí.** Mã gốc `DiamondHouse.sol` L336 (`shares = amount * totalShares / pool`), L360–361 (rút theo NAV). Mã đã vá: L405–406 (như F-04), L429–430 (NAV slice trước khi burn, cap theo navPool).

**PoC.** `audit/test/F04-F05-lp-vault-theft.test.js`: “attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share”.

**Log (vulnerable).**
```
pool after attacker's losing bets = 4999000001 (6dp)
victim deposit 2,999 USDC → OK; victim shares=1, attacker shares=1
attacker cost = 2000 USDC (lost bets) + 1 wei, received = 2499.5 USDC → net 499.499999 USDC
victim deposited 2999 USDC, received 2499.500001 USDC → net -499.499999 USDC
```
**Log (fixed).** `victim shares=2998999, attacker shares=1000000`; attacker net −999.999801 USDC (không có lợi); victim net −0.000399 USDC (làm tròn).

**Fix đã áp dụng.** Như F-04: virtual shares làm cho inflation không sinh lời. Kẻ tấn công lỗ gần như toàn bộ số đã đưa vào.

### F-06 — `lpWithdraw` bỏ qua `queueDebt` (High, ăn cắp của người thắng)

**Mô tả.** `queueDebt` là khoản nợ senior: tiền thắng cược đang chờ trả từ pool. LP rút dựa trên `pool` mà không trừ `queueDebt`. LP rút phần của người thắng đang xếp hàng.

**Vị trí.** Mã gốc `DiamondHouse.sol` L354–363 (`lpWithdraw`), L360 (`amount = sh * pool / (totalShares + sh)`), L363 (transfer). Mã đã vá: L176–178 (`navPool() = pool − queueDebt`), L429–433 (NAV slice từ navPool; `require(amount > 0, "nav empty")`).

**PoC.** `audit/test/F06-F08-admin-and-queue.test.js`: “LP withdraws its 100 USDC while winners' profit is still owed”.

**Log (vulnerable).**
```
queueDebt after 5 wins with empty pool = 480050000 (6dp), pool = 0
after LP deposit 100: pool=100000000, queueDebt=480050000
lpWithdraw → OK, LP received 100 USDC
remaining queueDebt owed to winners = 480050000 (6dp), pool = 0
```
**Log (fixed).** `lpWithdraw → nav empty, LP received 0 USDC`; `remaining queueDebt owed to winners = 480.05, pool = 100` (100 USDC được giữ cho người thắng).

**Fix đã áp dụng.** Tách NAV khỏi nợ senior; khi NAV = 0 thì revert, không đốt share cho số tiền bằng 0.

### F-07 — Khoá ký deploy derive từ mnemonic công khai (Critical nếu deploy thật)

**Mô tả.** `scripts/deploy.js` derive khoá quoter (HD21), attester (HD31, HD32, HD33), budgeter (HD41) từ mnemonic ganache công khai và dùng trực tiếp. Bất kỳ ai cũng derive được các khoá này: có thể ký quote, ký attestation WON và rút pool.

**Vị trí.** Mã gốc `scripts/deploy.js` L17 (`hd = (i) => ethers.HDNodeWallet…`), L90 (ghi chú “demo only”, không có guard). Mã đã vá: L24–31 (`resolveKeys`), L25–26 (`DEMO_KEYS=1` chỉ với chain local), L43 (guard chạy trước RPC), dòng 20 `process.exit(2)`.

**PoC.** `audit/test/F06-F08-admin-and-queue.test.js`: “PoC (vulnerable): anyone holding the public mnemonic can quote a 50x ticket and attest it WON”.

**Log (vulnerable).**
```
quoter (HD21) = 0x02484cb50AAC86Eae85610D6f4Bf026f30f6627D
attester(HD31) = 0x8263Fce86B1b78F95Ab4dae11907d8AF88f841e7, attester(HD32) = 0xcF2d5b3cBb4D7bF04e3F7bFa8e27081B52191f91  (2-of-3 quorum)
derivation phrase = "test test ... test junk" (public ganache/hardhat mnemonic)
house.quoterSigner == derived HD21? true
WON attested with derived attester keys → OK; attacker received 48044.9 USDC from pool (pool before=100000000000)
```
**Log (fixed).** `deploy.js (no keys, no DEMO_KEYS) → exit 2: no signing keys (missing env: QUOTER_KEY, ATTESTER_KEY_1, …)`; `deploy.js (DEMO_KEYS=1, chainId 1) → exit 2: DEMO_KEYS=1 is only allowed on local chains (got chainId 1)`.

**Fix đã áp dụng.** Ở tầng triển khai: không có khoá mặc định; khoá mặc định chỉ dùng khi `DEMO_KEYS=1` **và** chainId là local (31337/1337). Contract không thể biết khoá đã lộ, nên fix nằm ở đây. README đã cập nhật lệnh deploy.

**Rủi ro còn lại.** Khoá production phải được tạo và lưu ngoài repo (KMS/HSM). Đây là việc vận hành, không phải code.

### F-08 — Sink tuỳ ý và approve vô hạn không thu hồi (High, phụ thuộc owner)

**Mô tả.** `setRevenueSink(s)` không kiểm `s` là contract và cấp `approve(s, type(uint256).max)`. Owner đặt sink là EOA thì EOA kéo được mọi USDC của House (gồm stake mở). Sau khi đổi sink, approve cũ vẫn còn hiệu lực: sink cũ vẫn kéo được tiền.

**Vị trí.** Mã gốc `DiamondHouse.sol` L394–396, `DiamondOptions.sol` L294–296. Mã đã vá: `DiamondHouse.sol` L337 (`approve(sink, stakerAmt)` đúng số, dùng một lần), L500–501 (`require(s.code.length > 0)`, revoke sink cũ), `DiamondOptions.sol` L274, L372–373.

**PoC.** `audit/test/F06-F08-admin-and-queue.test.js`: “owner points revenueSink at an EOA: the EOA drains House, including open player stakes”.

**Log (vulnerable).**
```
House holds 102000 USDC (pool 100,000 + open player stake 2,000)
owner.setRevenueSink(EOA) → OK
EOA.transferFrom(House → EOA, all) → OK; EOA gained 102000 USDC
previous sink after rotation: transferFrom(House, 1 USDC) → OK (allowance never revoked)
```
**Log (fixed).** `owner.setRevenueSink(EOA) → sink must be a contract`; `EOA gained 0 USDC`; `allowance House→previous sink after rotation = 0`.

**Fix đã áp dụng.** Kiểm mã sink; approve đúng số cho mỗi lần notify; thu hồi approve sink cũ khi đổi; đổi quoter/verifier qua timelock 2 ngày (`proposeQuoter`/`executeQuoter` L472–477, `proposeOutcomeVerifier`/`executeOutcomeVerifier` L483–491). `setQuoter` đã xoá.

**Rủi ro còn lại.** Owner vẫn đổi được sink (sau khi kiểm mã). Xem mục 4.2.

### F-09 — `ttl` không được ký, người mua chọn thời hạn có lợi nhất (High, kinh tế)

**Mô tả.** Quote được ký theo typehash không chứa `ttl`; `buyTicket(q, sig, minMult, ttl)` nhận `ttl` từ người gọi. Cùng một quote có thể mua với ttl = 30 s hoặc 300 s. Giá (multiplier) được định theo τ = 60 s, nên người mua chọn ttl để có EV dương.

**Vị trí.** Mã gốc `DiamondHouse.sol` L76 (typehash không có ttl), L173 (`ttl` không bind), `DiamondOptions.sol` L73, L151. `engine/quoter.js` `HOUSE_TYPES`/`OPTIONS_TYPES` (không có `ttl`). Mã đã vá: `DiamondHouse.sol` L83 (typehash có `uint64 ttl`), L215 (`require(q.ttl == ttl, "ttl mismatch")`); `DiamondOptions.sol` L184; `engine/quoter.js` L4–18, L28 (ttl bắt buộc khi ký).

**PoC.** `audit/test/F09-F10-quote-binding.test.js` (tên file theo bộ test): “the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice”; “economic impact at τ=60 pricing”.

**Log (vulnerable).**
```
same signed quote: buy(ttl=30) → OK, buy(ttl=300) → OK
resulting tickets 0,1 expiry delta = 271 s for an identical quote
at σ=0.0004: ttl=60 → EV -4.0%; ttl=30 → EV 33.5% (house pays the difference)
```
**Log (fixed).** `buy(ttl=30) → ttl mismatch, buy(ttl=300) → ttl mismatch`. Bảng EV được giữ làm bằng chứng về giá trị kinh tế của lỗi.

Bảng EV (τ = 60 s, σ = 0.0004, cùng fallback σ với `engine/index.js`): ttl 30 → +33.5%, ttl 60 → −4.0%, ttl 120 → −31.5%, ttl 300 → −56.5% (EV của người mua trên mỗi đơn vị stake).

**Fix đã áp dụng.** ttl nằm trong chữ ký và phải khớp đúng; quoter bắt buộc có ttl.

### F-10 — Quote dùng lại vô hạn lần trong cửa sổ hiệu lực (Medium)

**Mô tả.** Một quote hợp lệ mua được nhiều vé cho đến khi hết `validUntil`. Mỗi lần mua dùng cùng giá cũ, nên exposure của house tích tụ.

**Vị trí.** Mã gốc `DiamondHouse.sol` L173–213 (`buyTicket`), `DiamondOptions.sol` L151–191 (`buyOption`). Mã đã vá: `DiamondHouse.sol` L226–227 (`quoteUsed[digest]`), `DiamondOptions.sol` L198–199.

**PoC.** `audit/test/F09-F10-quote-binding.test.js`: “one signed quote buys N tickets inside its validity window”.

**Log (vulnerable).** `5 purchases with one quote → OK, OK, OK, OK, OK`; `accepted 5/5 tickets (aggregate exposure 5 × 10 stake at one stale price)`.

**Log (fixed).** `5 purchases with one quote → OK, quote used, quote used, quote used, quote used`; `accepted 1/5 tickets`.

**Fix đã áp dụng.** Đánh dấu digest đã dùng; mỗi quote chỉ dùng một lần.

### F-11 — Head-of-line DoS khi token từ chối chuyển (Medium; High nếu token có blocklist)

**Mô tả.** `_payQueue` và các đường trả tiền trực tiếp dùng `require(usdc.transfer(...))`. Một người nhận bị blocklist (USDC thật có tính năng này) khiến mọi settlement và harvest revert, vì FIFO không thể bỏ qua người đầu hàng. Pool kẹt vĩnh viễn trong khi người khác không nhận được gì.

**Vị trí.** Mã gốc `DiamondHouse.sol` L255 (pay out), L263 (rebate), L278 (refund), L318 (`_payQueue`: `require(usdc.transfer(e.owner, pay), "queue out")`). `DiamondOptions.sol` L222, L275. Mã đã vá: `DiamondHouse.sol` L344–354 (`_send`: call cấp thấp, khi từ chối → `credits[to]` + `totalCredits`), L356–363 (`withdrawCredit`), L85 (`SEND_GAS_FLOOR = 60_000`), L346–347 (revert “send gas” nếu thiếu gas). Options: L292, L304.

**PoC.** `audit/test/F11-F14-ops-and-economics.test.js`: “blocked queue head halts all settlements while pool > 0”.

**Log (vulnerable).**
```
queue: p1 & p2 owed 192.02 USDC total
settle(KNOCKED) of an unrelated ticket → blocked
harvest(4) → blocked; pool=1000
```
**Log (fixed).** `settle(KNOCKED) of an unrelated ticket → OK`; `harvest(4) → OK; pool=817.98`; p1 có `credits > 0`; sau khi gỡ blocklist, `withdrawCredit()` trả đúng số đã ghi có (test mới).

**Fix đã áp dụng.** Chuyển thất bại không làm hỏng protocol: số tiền được ghi có cho người nhận và rút sau bằng `withdrawCredit`. Solvency vẫn giữ vì `totalCredits` nằm trong bất biến. Gas floor ngăn kẻ gọi cố tình cấp ít gas để biến thanh toán thành credit (xem mục 4.1, N3).

### F-12 — Hygiene: queue entry bằng 0 và chữ ký rỗng khi chưa đặt budgetAttester (Low)

**(a)** `_enqueue` không chặn `amount == 0`: vé thắng 1 wei với `queueDebt > 0` làm phát sinh entry 0 trong hàng đợi. Vị trí mã gốc `DiamondHouse.sol` L303. Đã vá: L367 (`if (amount == 0) return;`), `DiamondOptions.sol` L314.

PoC `F11-F14`: “(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry”. Log: vulnerable `queue entries 1 → 2`; fixed `queue entries 1 → 1`.

**(b)** `postEpoch` kiểm chữ ký bằng `_rec(h, sig) == budgetAttester`. Khi `budgetAttester == 0`, chữ ký không hợp lệ cho `_rec` = 0, và `0 == 0` nên được chấp nhận. Vị trí mã gốc `DiamondDistributor.sol` L116. Đã vá: L121 (`require(budgetAttester != address(0), "no budget attester")`).

PoC: “(b) postEpoch accepts an all-zero signature while budgetAttester is unset”. Log: vulnerable `postEpoch(epoch 1, 65-byte zero sig, budgetAttester unset) → OK`; fixed `→ no budget attester`.

### F-13 — Doanh thu kẹt khi chưa có staker (Medium)

**Mô tả.** Khi `totalStaked == 0`, `notifyRevenue` nhận USDC nhưng không cộng vào index (`if (totalStaked > 0)`). USDC nằm trong sink vĩnh viễn, staker đến sau không claim được.

**Vị trí.** Mã gốc `RevenueSplit.sol` L85–92. Mã đã vá: L150–157 (`carry += amount` khi chưa có staker), L125 (staker đầu tiên khởi động stream từ carry), L101 (`_addToStream` cộng carry).

**PoC.** `audit/test/F11-F14-ops-and-economics.test.js`: “owner distributes revenue to an empty staking set; USDC is stranded forever”.

**Log (vulnerable).**
```
totalStaked = 0, distributable = 8000 USDC
distributeRevenue(1000 USDC) with no stakers → OK; sink USDC = 1000
late staker claimable = 0 (stranded USDC in sink = 1000)
```
**Log (fixed).** `late staker claimable after 7d stream = 999.999999 USDC` (sai số 1 wei do làm tròn có lợi cho contract).

### F-14 — Ledger tính phí hai lần; LAUNCH 200% khiến farm có lãi (High)

**Mô tả.** `edge = stakeSum − paySum` đã bao gồm phí (phí được giữ lại khi trả thưởng), nhưng `anchor = feeSum + edge` cộng phí thêm lần nữa. Anchor gấp đôi thực tế, và LAUNCH_RATE 200% nhân thêm. Một cặp hedge tự tài trợ (long thắng, short thua, cộng một vé nhỏ để đủ điều kiện) nhận DIAMOND có giá trị lớn hơn chi phí bỏ ra.

**Vị trí.**
- `engine/ledger.js` (mã gốc): L14 `LAUNCH_RATE_BPS = 20000`; L54 `edge` (đã gồm phí); L55 `anchor = feeSum + edge` (cộng đôi).
- `contracts/DiamondDistributor.sol` (mã gốc) L38: `R_MAX_BPS = 20_000` (trần 200%).
- Mã đã vá: `engine/ledger.js` L15–16 (`R_MAX_BPS = 10000`, `LAUNCH_RATE_BPS = 10000`), L59 (`anchor = edge`); `DiamondDistributor.sol` L46 (`R_MAX_BPS = 10_000`).

**PoC.** `audit/test/F11-F14-ops-and-economics.test.js` (2 test, engine): “ledger anchor vs realized house P&L on the reference epoch”; “self-funded hedge pair at M = 1.92 / 1.99”.

**Log (vulnerable).**
```
realized house P&L (edge, fees already withheld) = 200 USDC
anchor used for the mint budget                 = 600 USDC
M      cost(USD)  anchor(USD)  rate    DIAMOND→USD   farmer net
1.92   1166.12    1533.24      200%    3066.48       1900.36
1.99   494.05     889.10       200%    1778.20       1284.15
```
**Log (fixed).**
```
realized house P&L (edge, fees already withheld) = 200 USDC
anchor used for the mint budget                 = 200 USDC
1.92   1166.12    1166.12      100%    1166.12       -0.00
1.99   494.05     494.05       100%    494.05        0.00
```
**Fix đã áp dụng.** Anchor = edge (một lần); trần và LAUNCH rate giảm về 100%. Ở 100%, farm chỉ hoà vốn (không lãi) — xem N4.

---

## 4. Rủi ro governance, kinh tế và điểm chưa có PoC

### 4.1 Các điểm phát hiện thêm trong quá trình vá

- **N1 — `setClassCfg` “tighten-only” có thể bị bypass (governance).** Kiểm `maxMult2 <= old && profitCap <= old` chỉ chạy khi `old.enabled`. Owner có thể `disable → nâng cap → enable` để nới cap. Cap chỉ được kiểm lúc mua vé (`DiamondHouse.sol` L217–232), nên không ảnh hưởng vé đang mở. **Đây là quyết định governance**: nếu muốn cấm nới hẳn, cần kiểm tra điều kiện khác `old.maxMultX1e4 != 0` và khi đó không còn đường nới cap cho class đã từng tồn tại. Chưa thay đổi; cần người dùng chốt (mục 8).
- **N2 — Nạp LP khi NAV = 0 (dilution).** Khi `totalShares > 0` và `navPool() == 0`, giá share do `VIRTUAL_ASSETS = 1` quyết định, nên người nạp mới nhận gần như toàn bộ lợi nhuận tương lai so với LP đã bị xoá sạch. Không trộm được tiền đã thực hiện, nhưng là bất công cho LP cũ. Chưa chặn vì chặn sẽ cản việc bơm vốn để trả nợ hàng đợi. Cần quyết định chính sách (mục 8).
- **N3 — Gas floor 60k (`SEND_GAS_FLOOR`).** `_send` revert `"send gas"` nếu gas còn lại < 60k, nên kẻ gọi không thể biến thanh toán thành credit bằng cách cấp ít gas. Hệ quả: kẻ gọi cấp ít gas chỉ làm tự revert tx của chính họ; không mất tiền, và người khác có thể gọi lại với gas đủ. Đã kiểm.
- **N4 — F-14 ở 100%: vẫn là “farm hoà vốn”.** Với rate 100%, cặp hedge hoà vốn nhưng vẫn nhận DIAMOND tương đương phí đã trả. Không lãi, nhưng vẫn là phần thưởng cho khối lượng giao dịch vô ích. Đây là quyết định thiết kế kinh tế.

### 4.2 Governance / centralization (không có PoC, cần quyết định)

Owner có các quyền có thể rút toàn bộ pool nếu bị lộ hoặc hành xử xấu:

- `setRevenueSink` → sink tuỳ ý (đã vá F-08 ở mức kiểm mã và revoke, owner vẫn đổi được);
- `setOutcomeVerifier` → thay bằng verifier luôn trả true → tự ký WON (đã vá: timelock 2 ngày);
- `setAttester` (`Verifiers.sol` L48–52, L141–145) **không timelock** và không kiểm số lượng attester ≥ threshold: owner tự thêm attester của mình, đủ quorum để ký WON, hoặc làm mọi settlement revert bằng cách gỡ attester;
- `setMinter` tới CAP; `setTargetPool(0)` mở waterfall; `setBudgetAttester` đổi budget signer không timelock.

README định vị owner là bên “cấu hình”, nhưng các quyền trên trên thực tế có thể rút pool. Đây là **mâu thuẫn giữa tài liệu và thực tế**. Đề xuất: multisig + timelock cho mọi hàm owner có ảnh hưởng tiền, và ghi rõ mức tin cậy trong README. Chưa sửa vì là quyết định vận hành.

### 4.3 Các điểm đã đánh giá nhưng chưa có PoC

- **H5 — `lpRequestExit` gia hạn lock.** Mỗi lần gọi đặt lại `lpExitAvailableAt = now + LP_LOCK` cho *toàn bộ* share đang chờ của người gọi (`DiamondHouse.sol` L346–352 mã gốc; L415–421 mã hiện tại). Chỉ tự gây hại cho chính người gọi. Mức **Low**, không ăn cắp.
- **D2 — chữ ký budget không bind chainId/contract.** Đã vá: `budgetHash` (L178) bind domain. Mức **Low**. Chưa viết PoC riêng; F-03 test dùng `budgetHash` trên nhánh fixed.
- **V1 — `setAttester` không kiểm threshold.** Xem 4.2. Mức **Medium** (phụ thuộc owner).
- **O3 — `settleWithPrice` tin `closePx` do attester ký, không ràng buộc thời điểm đóng.** Attester có thể ký giá cũ hoặc mới để đổi kết quả. Mức **Medium** (phụ thuộc tin cậy attester). Cần đặc tả oracle; chưa có PoC.
- **Gas w2 (settle với gas mặc định).** Không phải lỗi sản phẩm: ước lượng gas của ganache thiếu do quy tắc 63/64 khi có external call. Test dùng `gasLimit` tường minh (`test/diamond.test.js` L218). Không đưa vào danh sách lỗi.

---

## 5. Các điểm đã kiểm tra và không phải lỗi

- `multX1e4 − 10_000` an toàn nhờ `require(multX1e4 >= 10500)`.
- `_streamFee` không underflow (đã kiểm biên).
- Bất biến lanes được kiểm sau mọi thay đổi số dư (fixed: solvency; `totalCredits` được tính vào nợ).
- `_recoverSig` trả 0 khi lỗi ecrecover — đã bị chặn bởi `quoterSigner != 0`.
- RevenueSplit: `_settleReward` chạy trước khi đổi `staked`, không có lỗi thứ tự.
- Domain tách biệt giữa DiamondOutcome và DiamondPrice; attester được de-dup theo địa chỉ.
- Pause của RevenueSplit: khi `totalStaked == 0`, `periodFinish` dời đúng bằng thời gian tạm dừng, không mất phần còn lại và không có đường rút từ phần đó. Đã xác minh bằng luồng `_update` (L85–97) và `_addToStream` (L99–108). Overflow: `rewardRate × dt` và `staked × Δindex` nằm trong uint256 với biên tiền thực tế.

---

## 6. Kiểm chứng sau vá

| Bộ | Kết quả | File log |
|---|---|---|
| `npm run audit:poc` (vulnerable, 18 PoC) | 18 pass, 2 pending (guard F-07, fixed-only), EXIT 0 | `audit/evidence/poc-vulnerable-final.txt` |
| `npm run audit:regress` (fixed) | 19 pass, 1 pending (PoC F-07, vulnerable-only), EXIT 0 | `audit/evidence/regress-fixed-final.txt` |
| `npm test` (suite gốc) | diamond 133 passed / 0 failed; engine 51 passed / 0 failed; fuzz SEED=1337 OK (160 checks); EXIT 0 | `audit/evidence/root-suite-run.txt` |
| Từng file, vulnerable | Chi tiết theo file | `audit/evidence/per-file/vulnerable-*.txt` |
| Từng file, fixed | Chi tiết theo file | `audit/evidence/per-file/fixed-*.txt` |

Log `audit/evidence/superseded/poc-vulnerable-run1.txt` cũ hơn và **không dùng làm bằng chứng**: lần chạy đó dùng harness còn lỗi (xem phần lỗi harness bên dưới).

**Cảnh báo về `root-suite-run.txt`.** Khi chạy suite gốc có dòng `Cannot find module '../binaries/uws_linux_x64_127.node'`. Đây là cảnh báo của ganache (dependency uWebSockets không có binary cho Node này); ganache tự chuyển sang triển khai NodeJS và test vẫn chạy. Không ảnh hưởng kết quả.

**Lỗi harness đã sửa trong quá trình audit (ghi nhận để minh bạch).** `audit/lib/world.js` từng ghim cứng set `"fixed"` cho `DiamondToken`, `MockUSDC`, `DiamondDistributor` nên nhánh vulnerable có thể chạy nhầm mã đã vá. Đã sửa thành `SET`. Engine F-14 nhánh vulnerable nay nạp `audit/vulnerable/engine/ledger.js` (snapshot `3cb964b`). Log cũ trước sửa đổi này bị đánh dấu superseded.

---

## 7. Hạn chế

- **Không dùng Foundry.** Hardhat + solc-js thay thế. Kết quả không phụ thuộc công cụ, nhưng không có fuzz/invariant của Foundry.
- **“Chain local” là Hardhat in-process**, không phải node anvil/ganache riêng. `scripts/deploy.js` chưa được chạy end-to-end trên một node local trong phiên này; chỉ kiểm guard (exit 2 cho cả thiếu khoá và chainId 1).
- **Fuzz không phải bằng chứng đầy đủ.** `test/fuzz.js` bắt mọi revert và coi là “expected”. Lỗi chữ ký quote đã làm fuzz vô hiệu một lần (0 lần mua, vẫn báo OK) — đã sửa. Cần siết lại chỉ chấp nhận revert có lý do dự kiến.
- **Không kiểm riêng** ECDSA malleability (đã giảm rủi ro nhờ `quoteUsed` theo digest), và không có mô hình hình thức (formal verification).
- **Off-chain engine** (`engine/`) chỉ kiểm theo ví dụ và công thức trong tài liệu, không kiểm cho mọi đầu vào.
- **Không có đánh giá vận hành** (quản lý khoá, hạ tầng oracle/attester, monitoring).

---

## 8. Khuyến nghị và quyết định cần người dùng chốt

**Đã áp dụng trong mã** (xem từng F-xx): virtual shares; solvency `>=` và `sweepSurplus`; NAV trừ `queueDebt`; `_send` + credit + gas floor; streaming 7 ngày + carry; ttl và quote single-use trong chữ ký; `budgetHash` và cap theo epoch; anchor = edge và LAUNCH/R_MAX 100%; sink có kiểm mã và revoke; timelock 2 ngày cho quoter/verifier; deploy guard không khoá mặc định.

**Cần quyết định:**

1. **Governance (4.2):** có chấp nhận owner đơn phương (không timelock) cho `setAttester`, `setBudgetAttester`, `setClassCfg`, `setRevenueSink`, `setMinter`, `setTargetPool` không? Nếu không, cần multisig + timelock và cập nhật README.
2. **N1 (tighten-only):** có cấm nới cap class đã từng bật không, hay chấp nhận nới qua disable/enable?
3. **N2 (LP tại NAV = 0):** chặn nạp khi NAV = 0 hay cho phép bơm vốn cứu hàng đợi?
4. **F-14 ở 100%:** có chấp nhận farm hoà vốn không, hay giảm R_MAX/LAUNCH thêm?
5. **Khoá production:** tạo ngoài repo (KMS/HSM), tách quoter/attester/budgeter ra các máy khác nhau.

**Việc tiếp theo nếu tiếp tục:** siết fuzz (chỉ chấp nhận revert có lý do dự kiến), thêm invariant tổng tài sản (balance = pool + openStakes + totalCredits + carry + credits-stream), chạy `scripts/deploy.js` end-to-end trên node local, và PoC cho O3 và V1.

---

## Phụ lục A — Bảng vị trí nhanh

| File (mã gốc `3cb964b`) | Dòng | Nội dung |
|---|---|---|
| `contracts/DiamondHouse.sol` | 76 | typehash quote không có `ttl` (F-09) |
| | 149–150 | `lanesIntact` strict equality (F-01) |
| | 173 | `buyTicket(…, ttl)` không bind (F-09, F-10) |
| | 255, 263, 278 | `require(usdc.transfer)` payout (F-11) |
| | 303 | `_enqueue` không chặn 0 (F-12a) |
| | 318 | `_payQueue` `require(transfer)` (F-11) |
| | 333–336 | `lpDeposit` nhánh `shares = amount`, làm tròn (F-04, F-05) |
| | 360–363 | `lpWithdraw` bỏ qua `queueDebt` (F-06) |
| | 394–396 | `setRevenueSink` approve max, không kiểm code (F-08) |
| `contracts/DiamondOptions.sol` | 119–120 | `lanesIntact` (F-01) |
| | 151 | `buyOption` không bind ttl (F-09) |
| | 222, 275 | payout `require(transfer)` (F-11) |
| | 294–296 | `setRevenueSink` (F-08) |
| `contracts/DiamondDistributor.sol` | 38 | `R_MAX_BPS = 20_000` (F-14) |
| | 116 | `_rec == budgetAttester` khi attester = 0 (F-12b) |
| | 118 | kiểm `totalMint <= budget` chỉ khi postEpoch (F-03) |
| | 127–138 | `claim` không so với totalMint (F-03) |
| `contracts/RevenueSplit.sol` | 85–92 | `notifyRevenue` cộng index tức thì; bỏ qua khi `totalStaked == 0` (F-02, F-13) |
| `engine/ledger.js` | 14 | `LAUNCH_RATE_BPS = 20000` (F-14) |
| | 54–55 | `edge` đã gồm phí, `anchor = feeSum + edge` (F-14) |
| `scripts/deploy.js` | 17 | `hd(i)` từ mnemonic công khai (F-07) |
| | 90 | ghi chú “demo only”, không guard (F-07) |
| `contracts/Verifiers.sol` (mã gốc) | 48–52, 141–145 | `setAttester` không timelock, không kiểm threshold (4.2) |

## Phụ lục B — Cấu trúc thư mục audit

```
diamondtrading/audit/
├── hardhat.config.js          # chainId 31337, shanghai, 30 accounts, mocha 600s
├── lib/build.js               # solc-js 0.8.26 viaIR → build/{fixed,vulnerable,helpers}
├── lib/world.js               # fixture makeWorld, ký quote/outcome/price, timeTravel
├── lib/expect.js              # shim expect trên node:assert
├── vulnerable/contracts/*.sol # snapshot byte-identical của 3cb964b (7 file)
├── vulnerable/engine/ledger.js# snapshot ledger gốc (F-14)
├── helpers/BlocklistUSDC.sol  # USDC giả có setBlocked (F-11)
├── test/                      # F01, F02, F03, F04-F05, F06-F08, F09-F10, F11-F14
├── evidence/                  # log chạy đầy đủ + per-file + superseded/
└── report/REPORT.md           # báo cáo này
```
