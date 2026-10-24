# Security remediation and triage — 2026-10-24

This document records the disposition of the linked DiamondTrading audit against repository baseline
`3cb964bddadcf61145c1f8694786b6c0b72fe58d`. The report's vulnerable Hardhat PoCs were independently
reproduced before remediation: **18 passing, 2 pending**. The proposed fixed files were treated as
comparison material, not copied blindly.

The implementation keeps the explicit v3 product constraints: no QMAX, no pause, no surplus sweep,
transparent FIFO debt, adaptive minting, and the 200% launch emission ceiling.

## Finding disposition

| Finding | Decision | Implemented behavior / rationale |
|---|---|---|
| F-01 donation freezes accounting | Fixed | House/Options use a solvency inequality that includes pull credits. Donations are surplus and cannot freeze buys, settlement, harvest, LP exit, or refunds. No owner/player sweep was added. |
| F-02 JIT stake captures revenue | Fixed | RevenueSplit streams each notification over seven days, updates indexes before stake-weight changes, handles multiple stakers pro-rata, and pauses an unfinished stream while total stake is zero. There is no retroactive carry gifted to a later staker. |
| F-03 Merkle epoch over-claims / budget replay | Fixed | `epochClaimed` enforces aggregate `totalMint`; budget signatures bind chain ID, distributor address, epoch, anchor, and price. An unset attester is rejected. |
| F-04 first LP captures orphaned pool | Fixed, then hardened beyond the report | The first LP deposit initializes a persistent offset from all pre-LP pool assets. Those assets remain non-redeemable virtual-share value. Tests cover both a 1-wei depositor and a 100,000-USDC depositor against a 1,000-USDC orphan pool. A fixed small virtual-share offset alone was rejected because a whale could dilute it. Once both pool and real shares reach zero, the offset resets to its minimum so consumed orphan assets cannot dilute a later 100-USDC recapitalization. |
| F-05 donation/share inflation | Fixed | Virtual assets plus persistent share offsets protect deposits and withdrawals; pool-zero recapitalization is handled separately at 1:1. Self-donation and later-LP rounding regressions are included. |
| F-06 LP withdrawal ignores `queueDebt` | No NAV change; report PoC does not establish theft under v3 | The PoC LP deposited 100 USDC and withdrew its own 100 USDC while 480.05 USDC of deferred winner debt remained. v3 explicitly defines queue debt as deferred protocol debt, not a senior LP cash reserve. Subtracting it from LP NAV would change the product's capital structure and can strand LP withdrawals at NAV zero. This remains a disclosed liquidity risk, not a claim that queued winners are guaranteed timely payment. |
| F-07 public deployment mnemonic | Fixed | Deployment refuses missing keys before deployment. `DEMO_KEYS=1` is required for the public mnemonic and is restricted to local chain IDs 31337/1337. Other chains require all signing keys through environment variables; private keys are never written to `deploy.json`. |
| F-08 unsafe sink / unlimited allowances | Fixed | Sinks must be contracts or zero; old allowances are revoked on rotation; each notification approves exactly its amount and requires zero allowance afterward. A test-only sink that refuses to pull causes the whole notification to revert. No governance timelock was silently added. |
| F-09 unsigned TTL | Fixed | `ttl` is part of both EIP-712 quote structs and must equal the purchase argument. |
| F-10 quote replay | Fixed | The complete domain-bound quote digest is consumed on the first successful purchase. Original-signature and ECDSA-malleable replay tests are included. |
| F-11 blocklisted payee stalls FIFO | Fixed | Refused token transfers become pull credits in House, Options, and RevenueSplit. Queue processing and other users continue; blocked-payee withdrawal succeeds after unblocking. |
| F-12 zero queue entries / unset budget attester | Fixed | Zero-value enqueue is a no-op; zero-profit wins do not create 1→1 queue artifacts. `postEpoch` rejects an unset attester even with an all-zero signature. |
| F-13 revenue stranded without stakers | Fixed with source retention, not carry | No-staker notifications are rejected before the source House debits its pool, so the cash remains in the source. Active-staker revenue uses seven-day streaming without retroactive carry. |
| F-14 fee double-count / 200% farming | Accounting fixed; tokenomics retained | The anchor is now realized net revenue `max(0, stake−payout)`; payout is fee-net, so fees are not added again. The 200% launch subsidy remains an explicit incentive choice. The audit's farming example is off-chain and does not prove an on-chain enforcement failure; no reduction to 100% was made. |

## Deliberately unchanged / residual risks

- **Governance remains powerful.** The report's V1/Gov-1 owner-power and timelock proposals were not
  implemented as part of these accounting/security fixes. Ownership, verifier/quoter rotation, class
  configuration, sink configuration, founder configuration, and budget-attester configuration still
  require operational controls and key management outside these contracts.
- **Deferred debt can remain unpaid.** LP NAV does not reserve `queueDebt`; LP request locks and public
  claim information do not guarantee winner payment timing.
- **Oracle trust remains.** O3-style close-price/time binding and the L1Read sanity design are not
  replaced by this patch. Settlement still relies on the configured attester quorum.
- **H5 LP-lock extension and N1 class-cap tightening concerns are not changed.** They require a separate
  product/governance decision rather than being bundled into payout remediation.
- **Real-asset and live-chain behavior is not proven here.** Tests use six-decimal mock tokens plus a
  blocklist-capable test token on ganache. There is no formal verification, mainnet deployment, real
  USDC integration test, or independent audit sign-off in this repository change.

## Regression evidence

All tests compile production contracts with solc 0.8.26, viaIR, and the shanghai EVM target. The
security suite uses the same production artifacts as the ordinary tests; it does not mix vulnerable
and fixed builds.

| Suite | Result | Coverage |
|---|---:|---|
| `node test/diamond.test.js` | 130 passed, 0 failed | Core House/Options/verifier/token/distributor behavior, fee cash gates, streaming, exact sink allowance |
| `node test/engine.test.js` | 51 passed, 0 failed | Quote/verifier interop, Options stream, ledger/merkle/domain-signed anchor |
| `node test/security.test.js` | 43 passed, 0 failed | Finding-specific regressions, whale/dust LP attacks, blocklisted payees, deploy guards |
| `node test/fuzz.js` | Five seeds passed | 150 operations per seed; cash/debt/FIFO/fee mirrors after every operation |
| `DEMO_KEYS=1 node scripts/deploy.js` | Passed on local ganache | Full deployment, menu configuration, mock staking, and deployment-output generation |

These are regression results, not a proof of security. The residual risks above remain part of the
system's trust and economic model.
