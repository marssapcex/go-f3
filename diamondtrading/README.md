# DiamondTrading v2 — queue-bounded turbo markets

Solvency-first rebuild of the papertrade-style casino (see `runway/` for the v0.1 full-reserve
prototype lineage and `papertrade/` for the Martin Galer ancestor + Guardian audit). v2 re-admits
deferred payout **as a bounded machine**: FIFO queue + side bucket + hard global brake (QMAX) +
sweep-on-clean, instead of v1's full reserves.

## Contracts (Solidity 0.8.26, all compiled + bytecode-capped)

| contract | role |
|---|---|
| `DiamondHouse.sol` | digital tickets 1.05x–1000x (per-class envelope), queue-bounded payout |
| `DiamondOptions.sol` | 25x capped-vanilla ramps, same queue lanes, premium-only house income |
| `Verifiers.sol` | MultiAttesterVerifier (2-of-3 EIP-712, floor-2) + MultiPriceVerifier (1bp tolerance) |
| `EdgeToken.sol` | EDGE: minter-only mint, CAP supply, bootstrap non-transferable (allowlist), one-way `enableTransfers()` |
| `EdgeDistributor.sol` | merkle claims; budget = min(r(e)·anchor/price, epochCap); r(e) = max(30bp→, 20000−17000·e/360) via integer division ceiling — 200% decaying to 30% over 360 6h-epochs; anchor EIP-191(keccak(abi.encode(epochId, anchorUsd, priceX1e8))) |
| `RevenueSplit.sol` | pull-only `notifyRevenue`, cumulative-index LP ≥60% floor, 7-day unbonding |
| `MockUSDC.sol` | test token (6 decimals) |

**Lanes** (invariant, asserted on-chain after every mutation): `B = pool + sideBucket + openStakes`,
`debt ≥ 0`, `(debt = 0) ⇒ (side = 0)` via the sweep. Queue debt is a liability — never part of B.

**Fee honesty:** ρ=2% is a *haircut on the claim*, recorded in `Settled` events for the mint anchor;
it never pretends to be in-contract cash. Options books premium income only.

## Engine (`engine/`)

GALE-style quoter (sigma pricer, κλω/ω̃ manipulation caps with **no treasury terms**, breaker,
routing across Binance + Hyperliquid), ledger (net-loss √ weights ×1e9 BigInt, fee+edge anchor,
r(e) schedule, PRICE01 = 1_000_000n = $0.01 bootstrap).

## Tests (all green)

```bash
npm install    # ethers@6, ganache, solc 0.8.26 (pinned)
node compile.js
node test/diamond.test.js   # 95 contract assertions
node test/engine.test.js    # 41 engine assertions incl. ganache interop
SEED=1337 node test/fuzz.js # mirror-lane property fuzz (150 ops; try seeds 7/42/90210/555)
```

Fuzz invariants: G1 exact lane mirrors, G2 `lanesIntact()`, G3 no cut-in-line + correct pay splits,
G4 FIFO ordering (partial continuation legal), G5 QMAX/pause sales gate, G6 distribute only when
queue-clean. Five seeds: 167–177 checks each, queues up to $148k debt exercised.

Known test-environment note: under heavy ganache evm time-warp storms, ethers' implicit
`eth_estimateGas` can read a stale pending state; pass explicit `gasLimit` on the affected call
(documented inline in `test/diamond.test.js`).

## Docs

`whitepaper/DiamondTrading_v0.2.pdf` (build: `python3 build.py` with reportlab+matplotlib).
