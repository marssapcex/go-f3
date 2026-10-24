# DiamondTrading v3 — transparent-queue turbo markets

Solvency-transparent rebuild of the papertrade-style casino (see `runway/` for the v0.1 full-reserve
prototype lineage, `papertrade/` for the Martin Galer ancestor + Guardian audit). v3 doctrine:
**deferred payout exists, is public to the wei, and is never an excuse to stop the machine.**
No QMAX brake, no side bucket, no pause switch — a public FIFO queue plus claim-level transparency.

## Contracts (Solidity 0.8.26, viaIR, shanghai evm)

| contract | role |
|---|---|
| `DiamondHouse.sol` | digital tickets 1.05x–1000x (per-class envelope); FIFO queue pays from pool; `claimInfo(ticketId)` → hasDebt / amountOwed / position / totalDebt |
| `DiamondOptions.sol` | 25x capped-vanilla ramps, same lanes, premium → pool directly |
| `Verifiers.sol` | MultiAttesterVerifier (2-of-3 EIP-712, floor-2) + MultiPriceVerifier (tolerance cross-check) |
| `DiamondToken.sol` | DIAMOND: minter-only mint, CAP supply, bootstrap non-transferable (allowlist), one-way `enableTransfers()` |
| `DiamondDistributor.sol` | merkle claims; **counter-cyclical adaptive rate**: boot 200% of the signed fees+edge anchor, −250bps/epoch while anchor grows (growth siết, floor 30%), +1000bps/epoch while anchor shrinks (weakness nới, ceiling 200%); absolute epoch cap 2M DIAMOND (≤5M ceiling); anchor = EIP-191(epochId, anchorUsd, priceX1e8) |
| `RevenueSplit.sol` | pull-only `notifyRevenue`, cumulative-index LP ≥60% floor, 7-day unbonding |
| `MockUSDC.sol` | test token (6 decimals) |

**Lanes** (invariant re-asserted after every mutation): `B = pool + openStakes`.
`queueDebt` is a public liability ledger — never part of B, never hidden:
winners read their position + owed amount per ticket; total debt is a broadcast.

**Winning-trade fee:** ρ=**3.99%** — 0.99% of the House profit (or Options gross payout) goes to
`founderWallet`, and the remaining 3.00% goes to `RevenueSplit` for DIAMOND stakers. The owner can
set the founder later with `setFounderWallet(address)` on both engines; while it is `address(0)`, its
slice folds into the active staker sink. Integer-rounding dust goes to stakers.

**Fee honesty / cash gating:** fee streams only on a fully cash-paid win, never on a queued or partial
claim. After paying net, the pool must also cover the outgoing stream; otherwise the unstreamable amount
stays pooled. If nobody is staking, the staker slice stays pooled rather than becoming stranded in the sink.
`Settled` / `OSettled` still records the full `feeTaken` haircut for the mint anchor, independently of the
stream. `FeeStreamed` records actual founder/staker transfers. Options books premium income only.

**Anti-sybil farm bound:** hedged multi-account long/short pairs mint at most `rate × the fees they
burned themselves` — the anchor counts only realized fees+edge.

## Engine (`engine/`)

GALE-style quoter (sigma pricer, κλω/ω̃ manipulation caps with no treasury terms, spike breaker,
Binance + Hyperliquid routing), epoch ledger (net-loss √-weights ×1e9 BigInt, fee+edge anchor,
adaptive-rate mirror of the distributor).

## Tests (all green)

```bash
npm install    # ethers@6, ganache, solc 0.8.26 (pinned)
node compile.js
node test/diamond.test.js   # 127 contract assertions incl. fee split + cash boundaries
node test/engine.test.js    # 50 engine assertions incl. Options fee-stream interop
SEED=1337 node test/fuzz.js # mirror-lane property fuzz (150 ops; seeds 7/42/90210/555 green)
```

Fuzz invariants: G1 exact lane mirrors, G2 `lanesIntact()`, G3 no cut-in-line + pay splits,
G4 FIFO ordering (partial continuation legal), G5 sales never blocked by debt, G6 distribute only
when queue-clean, G7 founder/staker fee streams exactly mirror balances and pool debits.

Known test-env notes: after heavy ganache evm warp storms ethers' implicit `eth_estimateGas` can read
a stale pending state — pass explicit `gasLimit` on the affected call (documented inline).
solc `evmVersion: shanghai` (cancun emits MCOPY which ganache 7 rejects on constant string getters).

## Demo deploy (MetaMask-checkable)

```bash
npx ganache --chain.chainId 31337 --wallet.deterministic -h 0.0.0.0 -p 8545 &   # or the live preview
RPC=http://127.0.0.1:8545 node scripts/deploy.js                                # writes deploy.json
```

Seeds 10 accounts × 1M mock-USDC, 100k LP pool, the full 7-class menu, quoter/attester keys
(HD path indices 21/31-33 of the ganache mnemonic), plus 100k demo DIAMOND to the owner with 10k staked
so both fee lanes are immediately testable. House and Options share RevenueSplit; founder starts unset.
**Demo chain only — deterministic mnemonic, never send real funds.**

## Docs

`whitepaper/DiamondTrading_v0.3.pdf` (build: `python3 whitepaper/build.py` with reportlab+matplotlib).
