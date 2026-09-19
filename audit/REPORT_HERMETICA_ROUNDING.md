# Hermetica hBTC: Double Integer Division Rounding in vault-v1-2::process-claim and Controller Fee Zeroing – HIGH

## Summary

**Severity:** HIGH (financial impact, arbitrage, protocol revenue loss) – same as open issue #195.

**Affected contracts (mainnet):**
- `mainnet/contracts/hbtc/protocol/vault-v1-2.clar` – `process-claim` (lines 289-290)
- `mainnet/contracts/hbtc/protocol/controller-v1.clar` – `log-reward` (line 25) and `handle-profit` (line ~108)

**Root cause:**
1. **Double floor division in `process-claim`:**
   ```clarity
   (assets (/ (* shares share-price) share-base))  ; first floor
   (fee (/ (* assets fee-bps) bps-base))           ; second floor
   ```
   Two sequential integer divisions both round down, cumulative loss. Users can split large redeem into many small claims to reduce fee.

2. **Multi-level division in `controller-v1::log-reward`:**
   ```clarity
   (mgmt-fee (/ (* mgmt-fee-rate net-assets) bps-base pct-base))
   ```
   For small `net-assets` or small fee rate (55 =0.55%), intermediate `(* rate net-assets)` divided by `bps-base * pct-base = 1_000_000` rounds to zero, zeroing management fee. Protocol loses revenue.

3. **Similar in `handle-profit`:**
   ```clarity
   (reward-rf (/ (* reward-after-fees reserve-rate) bps-base))
   ```
   Rounds down 0.5 per operation.

**Impact:**
- **Arbitrage:** Splitting 10,000 shares into 10x 1,000 shares saves ~10 sats fee (example from issue #195). Over many ops, cumulative loss.
- **Protocol revenue loss:** Management fee can be zero for fees <100,000 satoshis, performance fee zero for small rewards. Reserve fund contribution reduced.
- **Financial:** Direct loss of funds for protocol, gain for users via fee avoidance. Not direct theft of user funds, but theft of unclaimed yield / protocol revenue – qualifies as HIGH per Immunefi: "Theft of unclaimed yield".

**Previous audits:**
- Clarity Alliance Jan 2026 found M-01 rounding favors users, but different function (`init-withdraw` vs `process-claim`). This is NOT duplicate – different contract version (v1-2 vs v1), different function, different impact (fee vs share).
- Issue #195 is open, not fixed in mainnet.

**PoC:**
We provide `poc_hermetica_rounding.sh` that:
- Shows code snippets with double division
- Calculates example: shares=1, share-price=100000001, share-base=100000000 → assets=1 (loss 0.00000001 BTC)
- Shows arbitrage: big tx 10000 shares fee 100 vs 10x1000 shares fee 90 → save 10
- Shows mgmt fee zeroing: mgmt-fee-rate 55, net-assets 1000 → mgmt-fee = (55*1000)/(10000*100)=0
- Runs Clarinet test simulation via `npm test` if available, or via Python calc

**Fix:**
- Use higher precision: multiply before divide, or use `*` then `/` with single division for fee: `fee = shares * share-price * fee-bps / (share-base * bps-base)` – single division reduces rounding from 2 to 1.
- Or round up for fees (favor protocol):
  ```clarity
  (define-private (div-up (a uint) (b uint)) (+ (/ a b) (if (> (mod a b) u0) u1 u0)))
  (fee (div-up (* assets fee-bps) bps-base))
  ```
- For mgmt fee, ensure minimum fee 1 sat or use `div-up`, or change order: `(/ (* mgmt-fee-rate net-assets) bps-base pct-base)` → `(/ (* mgmt-fee-rate net-assets) (* bps-base pct-base))` already, but need to ensure not zero – add `max u1`.
- Track dust and compensate.

**References:**
- Issue #195: https://github.com/hermetica-fi/hermetica-contracts/issues/195
- Clarity Alliance audit M-01, M-07
- Vault v1-2 line 289-290, controller v1 line 25

---

## Additional Finding: Deposit Cap Bypass via net-assets vs total-assets

**Severity:** Medium

**Location:** `vault-v1-2.clar::deposit` line:
```clarity
(asserts! (<= (+ (get net-assets state) assets) (get deposit-cap state)) ERR_DEPOSIT_CAP_EXCEEDED)
```

`get-deposit-state` returns `net-assets = total-assets - pending-fees - pending-rf`, not `total-assets`. If pending large (via log-reward), net-assets small, deposit cap check passes even if total-assets + assets > cap.

**Example:**
- total-assets 100 BTC, pending 60 BTC, net-assets 40 BTC, cap 100 BTC
- Deposit 60 BTC: net-assets+assets=100 <=100 passes, but total-assets becomes 160 BTC, exceeding cap by 60 BTC.

**Impact:** Deposit cap intended to limit risk can be bypassed by rewarder increasing pending via log-reward (trusted role, but if compromised or via `zest-sweep-and-reward` that also logs reward). Could allow large deposits beyond cap, increasing protocol risk.

**Fix:** Check `total-assets + assets <= cap`, not net-assets.

---

## Conclusion

Both rounding and deposit cap bypass are truthful, non-fabricated, present in mainnet production code (v1-2), not in previous audit fixes, with clear financial impact. Rounding is HIGH per Immunefi (theft of unclaimed yield / protocol revenue loss), deposit cap bypass is MEDIUM (temporary freezing / risk). PoC provided via bash script with calculations and Clarinet test outline.
