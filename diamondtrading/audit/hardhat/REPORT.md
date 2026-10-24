# DiamondTrading — Round 13 Independent Hardhat Security Audit

**Date:** 2026-10-25  
**Audited base:** `1e5a4dc67b22247504d31f5ea94401961e8b4db0`  
**Execution branch:** `arena/9769a1ba-go-f3`  
**EVM:** Hardhat 2.29.1, in-process Shanghai EVM, chain ID 31337  
**Artifacts:** the repository's production solc 0.8.26 + viaIR pipeline; no second compiler or vulnerable/fixed artifact mixing

## 1. Executive result

This was a new adversarial review, not a rerun of the previous audit. It included manual source review, a real `scripts/deploy.js` execution on a Hardhat node, independent attack PoCs, and deterministic stateful fuzzing with persisted seeds.

- **No critical or high-severity unprivileged smart-contract drain was reproduced.** House/Options token lanes, FIFO debt, pull credits, LP real-share accounting, Merkle claims, and epoch budgets held in the tested campaigns.
- **One high-risk deployment/integration mismatch was reproduced:** all seven configured class IDs differ between `config/menu.json` and the actual deployment script. A quote rejected by the menu's intended class/cap mapping can be accepted by the deployed table.
- Medium findings cover paused-revenue handoff, Hyperliquid/Binance tape integrity, zero-NAV LP recapitalization, and a zero-address attester configuration footgun.
- Some reproduced behaviors are explicitly documented design or trust decisions. They are labeled as such below rather than being presented as new external exploits.
- **No production remediation or tokenomics change was applied in this audit round.** Changes are the Hardhat audit harness, PoCs, fuzz seeds/results, and a provider switch in the existing security test.

### Verification totals

| Suite | Result |
|---|---:|
| Original diamond tests | 130 passed |
| Original engine tests | 51 passed |
| Original security tests on Ganache | 43 passed |
| Same security tests on Hardhat | 43 passed |
| Independent Hardhat attack/negative PoCs | 24 checks passed |
| Stateful fuzz | **21,672 invariant checks, 20 seeds, 150 operations/epochs per seed** |
| Distributor-specific coverage | 750 epochs across five seeds |
| Original seed-1337 fuzz | Passed |

Fuzz passing is evidence, not a proof that no bug exists.

## 2. Finding summary

| ID | Severity | Classification | Status | Finding |
|---|---|---|---|---|
| DT13-01 | **High** | Deployment / integration | Reproduced on a real local deployment | Menu and deployed class IDs/caps are different for 7/7 menu entries |
| DT13-02 | **Medium** | Economic / documented stream design | Reproduced | A later 1-wei staker can receive almost all of an old paused stream |
| DT13-03 | **Medium** | Off-chain integration | Reproduced with deterministic adapter data | Hyperliquid drops trades sharing a millisecond |
| DT13-04 | **Medium** | Off-chain integration | Reproduced with delayed mocked HTTP | Overlapping Binance polls append the same aggregate trade repeatedly |
| DT13-05 | **Medium** | LP economic design | Reproduced | Outstanding zero-NAV shares revive against a later LP's deposit |
| DT13-06 | **Medium** | Governance configuration | Reproduced; owner action required | Enabling `address(0)` reduces an effective 2-of-N quorum to one real attester |
| DT13-07 | **Low** | Reward-stream availability/design | Reproduced through a real House ticket | A one-base-unit fee resets the rolling seven-day stream |
| DT13-08 | **Low** | Known availability residual | Reproduced | A blocked/non-pulling revenue sink reverts clean-book WON settlement |

There is no finding labeled “critical” merely because an owner or attester is trusted. Those powers are listed separately in §5.

---

## 3. Detailed findings

### DT13-01 — High: deployment does not implement the declared menu

**Sources:** `config/menu.json:8-14`, `scripts/deploy.js:88-96`  
**PoC:** `audit/hardhat/deployment-audit.cjs`  
**Evidence:** `audit/hardhat/results/deployment.json`

`menu.json` declares BTC through XYZ100 as class IDs **0 through 6**. `deploy.js` independently hard-codes them as **1 through 7**, with different multipliers and caps. The menu comment calls `classId` the single source of truth shared by the quoter, attesters, and contract table, but the deployment script does not consume that file.

The audit started an actual Hardhat node and ran the unmodified `scripts/deploy.js`. It then read every deployed `House.classCfg` and submitted signed quotes:

- **7/7 menu entries differed on-chain.**
- Menu BTC class 0 was disabled and reverted `class disabled`.
- Menu class 1 is ETH with a 25,000-USDC profit cap. The deployed class 1 instead has a 250,000-USDC cap.
- A class-1 ticket with **100,000 USDC profit** was accepted on-chain, despite exceeding the menu's ETH cap by 75,000 USDC.
- Unexpected class 7 was enabled.

**Impact:** if this script and menu are used together, off-chain asset selection and on-chain risk limits do not describe the same product. This is an integration/deployment failure, not proof that any live chain currently has this state.

**Recommended correction:** generate the deployment table from one versioned menu artifact, reject unknown/extra enabled IDs, and make post-deployment `classCfg` assertions a mandatory CI step. Do not repair the mapping by manually editing one side again.

### DT13-02 — Medium: a paused stream hands old revenue to a later dust staker

**Source:** `contracts/RevenueSplit.sol:69-81`  
**PoC:** `attack-pocs.cjs`, POC-01

When `totalStaked == 0`, `_update()` moves `periodFinish` forward instead of expiring the unfinished stream. The PoC executed this sequence:

1. An honest staker was active when 399 USDC was notified.
2. That staker unbonded everything, leaving zero total stake.
3. The stream remained empty for 30 days.
4. A new account staked **1 wei of DIAMOND**.
5. After the resumed seven-day stream, that account received **398.999999 USDC**.

This is not an instant JIT claim: the new staker must remain through the resumed stream. It also does not create value above the notified amount. It does, however, give old revenue to someone who supplied no stake when that revenue arrived.

**Impact:** retroactive reward allocation and negligible-capital capture when there is no competing staker. The pause/resume behavior is visible in the source, so this is classified as an economic/design issue rather than a hidden contract invariant break.

**Recommended product decision:** either explicitly document this handoff or change the empty-stake policy so unfinished revenue expires/returns to a designated source. A minimum stake only changes the capture cost; it does not resolve the allocation policy.

### DT13-03 — Medium: Hyperliquid timestamp filtering loses valid prints

**Source:** `engine/venues/live.js:56-67`  
**PoC:** `attack-pocs.cjs`, POC-05

The adapter accepts a trade only when `t.time > lastT`. Two mocked `recentTrades` entries at the same millisecond, with prices 100/101 and quantities 3/2, produced only one tape print.

The filter can also discard a newly observed trade in a later poll if its millisecond equals the last accepted trade. This can distort VWAP, realized volatility, and any downstream quote or cap that consumes the tape.

**Recommended correction:** deduplicate with a stable unique trade identifier, retain distinct same-millisecond prints, and add a single-flight/ordering policy. Do not “fix” this by making `TradeTape` reject all equal timestamps; multiple real trades can share one.

**Limit:** the adapter logic was tested deterministically, not against a live Hyperliquid endpoint from this sandbox.

### DT13-04 — Medium: overlapping Binance polls double-count aggregate trades

**Source:** `engine/venues/live.js:24-35`  
**PoC:** `attack-pocs.cjs`, POC-06

`setInterval(tick, pollMs)` does not wait for the previous asynchronous tick. There is no in-flight guard and no persistent set of processed aggregate-trade IDs. With a 25 ms response delay and a 5 ms poll interval, five overlapping responses each contained the same trade (`a = 7`, quantity 2). The tape retained **five prints**, and VWAP quantity became **10 instead of 2**.

**Impact:** duplicated flow and repeated prints can distort volume weighting and volatility. Depending on response ordering, `fromId` can also be overwritten by an older request.

**Recommended correction:** enforce one in-flight request per tape, advance `fromId` monotonically only after ordered processing, and deduplicate by aggregate-trade ID. Add finite/positive price and quantity validation before inserting into `TradeTape`.

### DT13-05 — Medium: zero-NAV LP shares revive on recapitalization

**Source:** `contracts/DiamondHouse.sol:382-388`  
**PoC:** `attack-pocs.cjs`, POC-07

At `pool == 0`, `lpDeposit()` issues `amount * LP_SHARE_SCALE` even when old real shares remain outstanding. The PoC created this state:

- Old LP deposited 1,000 USDC and retained shares after the pool reached zero.
- At zero NAV, the old LP's matured exit reverted `nav empty`.
- A new LP deposited 1,000 USDC.
- The old LP immediately withdrew **500 USDC**; the new LP later withdrew **500 USDC**.

The old LP did not profit relative to its original 1,000-USDC deposit, but half of the new LP's capital restored old zero-NAV shares. This is a wealth transfer caused by the chosen recapitalization rule, not phantom share creation or a broken token-lane invariant. Existing comments already describe pool-zero issuance as 1:1, so the finding is an economic/design risk.

**Recommended product decision:** disclose this explicitly to recapitalizing LPs or redesign zero-NAV issuance/reset semantics. Any reset of existing shares is itself a governance/tokenomics decision and was not made during this audit.

### DT13-06 — Medium: zero-address attester defeats the intended quorum floor

**Sources:** `contracts/Verifiers.sol:48-56`, `141-149`  
**PoC:** `attack-pocs.cjs`, POC-03

Constructors reject zero attesters, but both `setAttester` implementations accept `address(0)`. After the owner enabled it, the verifier accepted:

- one valid signature from a real attester; and
- one invalid 65-byte signature whose recovery result is `address(0)`.

Those two distinct recovered addresses met threshold 2. Thus the nominal two-signature floor becomes one real attester plus zero.

**Precondition:** the owner must explicitly enable zero. This is not reachable by an unprivileged user and is therefore a governance footgun, not an external signature-forgery finding.

**Recommended correction:** reject zero and duplicate enablement in setters, track active attester count, and constrain threshold to a sane range relative to that count.

### DT13-07 — Low: a real one-base-unit fee rolls the full stream

**Sources:** `contracts/RevenueSplit.sol:92-99`, `contracts/DiamondHouse.sol:299-318`  
**PoC:** `attack-pocs.cjs`, POC-02

A 520-base-unit, 1.05x winning House ticket generated 26 base units of gross profit and exactly **one base unit of fee**. That normal authorized notification moved `periodFinish` to `now + 7 days` while preserving the old remainder.

For an initial 100-USDC stream, the tiny notification arrived after one day. At the original finish, only **87.755244 USDC** was claimable. The remainder is delayed, not destroyed.

Only House/Options or an authorized pusher can notify. Repeated rolling requires ongoing revenue-generating settlements; this PoC does not establish a free arbitrary-user DoS.

### DT13-08 — Low: sink failure still reverts settlement

**Source:** `contracts/DiamondHouse.sol:299-318`  
**PoC:** `attack-pocs.cjs`, POC-08

With an active staker and a clean queue, blocklisting `RevenueSplit` in the test USDC made `notifyRevenue → transferFrom` revert. The entire WON settlement reverted and the ticket stayed unsettled. Disabling the sink allowed settlement to recover with the test token.

This matches the previously documented behavior that a non-pulling sink causes notification to revert. It is therefore retained as an availability residual, not presented as a new blocklisted-payee queue exploit. Real Circle USDC blocklist/upgrade behavior was not tested.

---

## 4. Off-chain integration review

### The engine is a demo, not a complete production worker

`engine/index.js` explicitly identifies itself as a mock-mode wiring demo. It computes and prints routing, pricing, and cap values; it does not run a persistent production quote/attestation service. `EpochLedger`, `menu.json`, `Quoter`, and `Attester` are exercised in tests, but there is no production worker in this repository connecting all of them to settlement events and epoch posting.

Consequences for assurance:

- Passing engine unit tests does not prove that dynamic G3 caps are enforced before every production signature.
- The low-level `Quoter` signs fields supplied by its caller; risk controls must be enforced by the missing/outer worker.
- No live signer operational policy, persistence, crash recovery, or key-management implementation was available to audit.

### Fail-open dual-read hazard

`engine/quoter.js:45-49` returns the non-null leg when the other price is absent. That is appropriate only for an intentional single-read route. A caller expecting dual-read must fail closed when either leg is missing; otherwise one failed venue silently degrades the manipulation-cost assumption. No production caller was present, so this is an integration hazard, not a reproduced live exploit.

### Tape input validation

`TradeTape` accepts zero/non-finite quantities and prices without validation. A single zero-quantity print produced `NaN` VWAP instead of `NO-PRINT` in POC-10. Normal exchange responses should have positive values, but adapters should reject malformed data before it reaches pricing.

## 5. Trust boundaries and reproduced design residuals

These are important but are not mislabeled as new unprivileged vulnerabilities:

- **Early House WON/KNOCKED settlement:** two valid attester signatures settled WON before expiry in POC-04. The contract explicitly permits this; attesters are trusted to sign only the correct outcome at the correct time.
- **Owner authority:** the token owner can replace the minter; engine owners can replace quoter/verifier/sink/class configuration; verifier owners can replace attesters/thresholds. There is no governance timelock in this version.
- **Deferred winner debt:** `queueDebt` is not reserved from LP NAV. LP and winner liquidity can therefore depend on future cash flow. The fuzz campaign checked accounting consistency, not guaranteed timely solvency.
- **Launch subsidy:** the adaptive 200% launch ceiling remains intentional. The audit did not reclassify it as an accidental fee double-count.
- **Fee and product constraints:** 3.99% total fee, no QMAX/pause/sweep, DiamondToken/DIAMOND, and mint-on-loss behavior were not changed.

## 6. Deep-fuzz method and negative results

### Persisted seeds and results

Seeds are in `fuzz-seeds.json`; per-scenario outcomes are in `results/{house,options,rewards,distributor}.json`. On failure, the harness writes the seed, error, replay command, and operation journal to `counterexamples/`.

| Scenario | Seeds | Operations per seed | Invariant checks |
|---|---:|---:|---:|
| House + LP + FIFO + blocklist credits | 5 | 150 | 4,385 |
| Options + FIFO + blocklist credits | 5 | 150 | 3,826 |
| RevenueSplit staking/unbonding/streams | 5 | 150 | 7,575 |
| Ledger + Merkle + adaptive Distributor | 5 | 150 epochs | 5,886 |
| **Total** | **20** | | **21,672** |

Checked properties included:

- exact USDC balance = pool + open player lane + pull credits, absent donations;
- exact local open-stake/open-premium accounting;
- `queueDebt` equals the sum of every live FIFO entry;
- dequeue IDs never move backward and queue IDs remain sequential;
- total credits equal the sum across all recipients;
- LP real shares equal free plus pending-exit shares;
- WON/EXPIRED/Options payout and fee equations mirror contract state;
- staked/unbonding DIAMOND conservation and notified/paid/resident USDC conservation;
- off-chain/on-chain adaptive rate, token budget, Merkle claim amount, epoch claimed total, and token supply equality.

### Negative results retained

- No House/Options lane drift, FIFO reorder, credit loss, or LP real-share inflation was found in the campaign.
- No off-chain/on-chain Merkle or adaptive-budget mismatch was found in 750 generated epochs.
- High-s quote replay still reverted `quote used`; two malleated encodings from one attester did not form a quorum.
- Ledger float-to-fixed-point weighting showed a maximum relative error of approximately **1.67e-15** in the tested scales, not a material allocation error.
- Zero-sigma pricing did not reproduce the suspected bad quote: `pBust = 0`, `mOffer = 0.9601`, and the multiplier clamp rejects it.
- Harness-only failures encountered while developing the fuzzer (cached quote timestamps, a generator that removed its guaranteed anchor, and post-warp gas estimation) were corrected and are not counted as protocol findings.

## 7. Dependency triage

Raw output is preserved in `results/npm-audit-full.json` and `results/npm-audit-omit-dev.json`; the summary is in `results/dependencies.json`.

- Full audit: **48 vulnerable package entries** (10 low, 6 moderate, 27 high, 5 critical).
- `--omit=dev`: **35 entries**. Ganache and solc remain in this count because they are listed in `dependencies`, although used here as test/build tooling.
- Tree triage: 29 Ganache-only, 13 Hardhat-only, 2 solc/tmp, and 4 mixed Ganache/dev entries.
- These are not 48 independent protocol vulnerabilities. No advisory was promoted without a reachable code path and reproduction.
- `npm audit fix --force` was not run. solc remains 0.8.26 so the audit exercises the intended bytecode.

## 8. Reproduction

From `diamondtrading/`:

```bash
npm run compile
npm run audit:security
npm run audit:pocs

for scenario in house options rewards distributor; do
  FUZZ_SCENARIO=$scenario FUZZ_OPS=150 \
    npx hardhat --config audit/hardhat/hardhat.config.cjs run --no-compile \
    audit/hardhat/deep-fuzz.cjs || exit 1
done
```

Deployment evidence was produced by running a Hardhat node, then:

```bash
DEMO_KEYS=1 RPC=http://127.0.0.1:8545 node scripts/deploy.js
RPC=http://127.0.0.1:8545 node audit/hardhat/deployment-audit.cjs
```

The deployment command writes `deploy.json`; the original workspace file was restored after evidence was captured.

## 9. Limitations and priority

This was a local Hardhat audit, not formal verification or a mainnet review. Live Binance/Hyperliquid endpoints, real USDC upgrades/blocklists, production key management, and an actual persistent quoting worker were not available. Mocked adapter responses prove the deterministic adapter defects but do not assert live endpoint behavior.

Recommended priority:

1. **Fix and CI-enforce the deployment/menu mapping before any real deployment.**
2. Add adapter single-flight, ID-based deduplication, and input validation; make intended dual-read fail closed.
3. Make explicit product decisions for paused-stream ownership and zero-NAV recapitalization.
4. Reject zero attesters and define a safe sink-failure policy.
5. Preserve the remaining documented trust/economic decisions unless a separate remediation round deliberately changes them.
