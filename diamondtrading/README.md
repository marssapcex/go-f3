# DiamondTrading v3 — transparent-queue turbo markets

Solvency-transparent rebuild of the papertrade-style casino (see `runway/` for the v0.1 full-reserve
prototype lineage, `papertrade/` for the Martin Galer ancestor + Guardian audit). v3 doctrine:
**deferred payout exists, is public to the wei, and is never an excuse to stop the machine.**
No QMAX brake, no side bucket, no pause switch — a public FIFO queue plus claim-level transparency.

## Contracts (Solidity 0.8.26, viaIR, shanghai EVM)

| contract | role |
|---|---|
| `DiamondHouse.sol` | digital tickets 1.05x–1000x (per-class envelope); FIFO queue pays from pool; `claimInfo(ticketId)` → hasDebt / amountOwed / position / totalDebt |
| `DiamondOptions.sol` | 25x capped-vanilla ramps, same cash lanes, premium → pool directly |
| `Verifiers.sol` | MultiAttesterVerifier (2-of-3 EIP-712, floor-2) + MultiPriceVerifier (tolerance cross-check) |
| `DiamondToken.sol` | DIAMOND: minter-only mint, supply cap, bootstrap non-transferable allowlist, one-way `enableTransfers()` |
| `DiamondDistributor.sol` | merkle claims; counter-cyclical adaptive rate: 200% launch rate on signed realized net revenue, −250 bps/epoch while the anchor grows (floor 30%), +1000 bps/epoch while it shrinks (ceiling 200%); 2M-DIAMOND epoch cap (≤5M absolute cap) |
| `RevenueSplit.sol` | pull-only revenue notification, seven-day reward streaming, seven-day unbonding, multi-staker cumulative-index accounting |
| `MockUSDC.sol` | six-decimal test token; never a production USDC substitute |

### Cash, debt, LP shares, and payout credits

The solvency invariant is `B >= pool + openStakes + totalCredits` for House, and the corresponding
`openPremiums` lane for Options. Accidental donations are surplus: they cannot make accounting revert,
and there is deliberately **no `sweepSurplus` function**.

`queueDebt` is the public deferred-profit liability. It is not cash and, by explicit v3 product decision,
it is **not subtracted from LP NAV as a senior reserve**. LP exits remain pro-rata against pool cash after
the seven-day request lock; queued winners can therefore remain unpaid. `claimInfo` exposes this risk
rather than hiding it.

LP deposits use virtual asset/share offsets against donation-based share inflation. At the first LP
deposit, any pool that already existed is permanently represented by non-redeemable virtual shares, so
neither dust nor a whale deposit can capture those orphaned assets. A truly zero pool retains 1:1
recapitalization pricing. When both pool and real LP shares reach zero, the offset resets to its
minimum because no orphan asset remains to protect.

If USDC refuses a player/founder/staker transfer (for example, because of a blocklist), House, Options,
and RevenueSplit preserve the amount as a pull credit instead of letting one payee stall the FIFO or
other users. Credits are withdrawable after the token accepts the payee again.

### Quotes and epoch claims

House and Options quotes include the priced `ttl` in the EIP-712 payload and are consumed after their
first successful purchase. Reusing either the original or an ECDSA-malleable signature cannot mint a
second position.

Distributor budget attestations are EIP-191 signatures over
`keccak256(abi.encode(chainId, distributor, epochId, anchorUsd, priceX1e8))`. Each epoch also tracks
`epochClaimed`, so even a tree with individually valid leaves cannot mint more than its posted
`totalMint` budget. An unset budget attester rejects `postEpoch`.

### Winning-trade fee and revenue streaming

ρ = **3.99%**: 0.99% of House profit (or Options gross payout) goes to `founderWallet`; the remaining
3.00% goes to RevenueSplit for DIAMOND stakers. While the founder address is zero, its slice folds into
the active staker sink. Integer-rounding dust goes to stakers.

Fees stream only on a fully cash-paid win, never on a queued or partial claim. After paying net, the
pool must also cover the outgoing fee; otherwise the unstreamable amount stays pooled. If nobody is
staking, the staker slice stays pooled rather than becoming stranded in the sink. `Settled` / `OSettled`
record the full fee haircut; `FeeStreamed` records the committed founder/staker amounts.

RevenueSplit streams received revenue over seven days. A just-in-time staker earns only from its actual
stake/time share, not an instant retroactive payout. If the last staker exits, an unfinished stream
pauses and resumes when someone stakes again. House/Options approve only the exact notification amount
and require a zero allowance afterward; rotating a sink revokes the old allowance.

### Mint anchor — no double count, explicit launch subsidy

The epoch anchor is `max(0, sum(stake) - sum(payout))`. Payout is already fee-net, so adding `feePaid`
again would double-count revenue. The 200% launch rate remains an intentional incentive: it is not a
promise that hedged minting is always below cost. Net-loss epochs, square-root weights, per-user claim
tracking, the aggregate epoch budget, and the absolute cap still bound issuance.

## Engine (`engine/`)

GALE-style quoter (sigma pricer, κλω/ω̃ manipulation caps with no treasury terms, spike breaker,
Binance + Hyperliquid routing), epoch ledger (net-loss √-weights ×1e9 BigInt, realized-net-revenue
anchor, adaptive-rate mirror of the distributor), and domain-required budget-signature helper.

## Tests

```bash
npm install
npm test                    # compile + contract + engine + security + seed-1337 fuzz
node test/diamond.test.js   # 130 contract assertions
node test/engine.test.js    # 51 engine assertions
node test/security.test.js  # 43 audit/security regressions
SEED=1337 node test/fuzz.js # mirror-lane property fuzz, 150 operations
```

Fuzz invariants cover exact lane mirrors, solvency, FIFO ordering and partial continuation, sales under
debt, queue-clean distributions, and founder/staker fee mirrors. The security suite additionally covers
donations, quote TTL/replay/malleability, JIT and multi-staker streaming, sink allowances, epoch/domain
replay, orphan-pool and whale LP attacks, pool-zero recapitalization, blocklisted payees, zero-value
queue entries, exact anchor accounting, and deploy-key guards. See `SECURITY.md` for triage decisions
and residual risks.

Test-environment notes: after heavy ganache time warps, ethers' implicit gas estimation can observe a
stale pending state; the affected tests use explicit gas limits. solc targets `shanghai` because the
pinned ganache build rejects cancun/MCOPY bytecode.

## Demo deploy (local chain only)

```bash
npx ganache --chain.chainId 31337 --wallet.deterministic -h 0.0.0.0 -p 8545
DEMO_KEYS=1 RPC=http://127.0.0.1:8545 node scripts/deploy.js
```

The script seeds 10 accounts with mock USDC, a 100k LP pool, the seven-class menu, and demo DIAMOND
staking. `DEMO_KEYS=1` is required for the public deterministic mnemonic and is refused outside local
chain IDs 31337/1337. Any other deployment must supply `QUOTER_KEY`, `ATTESTER_KEY_1..3`, and
`BUDGETER_KEY` through the environment; there is no public-key fallback. Never send real funds to the
demo deployment or reuse demo signing keys.

## Docs

- `SECURITY.md` — audit finding-by-finding decisions, validation, and residual risks.
- `whitepaper/DiamondTrading_v0.3.pdf` — rebuild with `python3 whitepaper/build.py` (reportlab + matplotlib).
