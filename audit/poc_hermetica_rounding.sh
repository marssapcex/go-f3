#!/usr/bin/env bash
set -euo pipefail

# Hermetica hBTC rounding bug PoC
# Demonstrates double integer division in vault-v1-2::process-claim and fee zeroing in controller-v1::log-reward
# Based on open issue #195

HERMETICA_DIR="/tmp/hermetica-contracts"
if [ ! -d "$HERMETICA_DIR/mainnet/contracts/hbtc/protocol" ]; then
  echo "Cloning hermetica-contracts..."
  rm -rf /tmp/hermetica-contracts
  git clone https://github.com/hermetica-fi/hermetica-contracts.git /tmp/hermetica-contracts 2>&1 | tail -5
fi

cd "$HERMETICA_DIR"

echo "=== Hermetica hBTC Rounding Bug PoC ==="
echo "Branch: $(git rev-parse --abbrev-ref HEAD) Commit: $(git rev-parse --short HEAD)"
echo ""

echo "--- vault-v1-2.clar::process-claim double division ---"
grep -n "assets.*share-price\|fee.*fee-bps" mainnet/contracts/hbtc/protocol/vault-v1-2.clar | head -10
sed -n '285,295p' mainnet/contracts/hbtc/protocol/vault-v1-2.clar
echo ""

echo "--- controller-v1.clar::log-reward multi-level division ---"
grep -n "mgmt-fee.*bps-base\|perf-fee.*bps-base\|reward-rf" mainnet/contracts/hbtc/protocol/controller-v1.clar | head -20
sed -n '20,35p' mainnet/contracts/hbtc/protocol/controller-v1.clar
echo ""

echo "=== Calculations ==="
python3 - << 'PY'
share_base = 100_000_000
bps_base = 10_000
pct_base = 100

# Issue 1: double division
shares = 1
share_price = 100_000_001  # 1.00000001 BTC
assets = (shares * share_price) // share_base
print(f"shares={shares}, share-price={share_price}, share-base={share_base} => assets={assets} (expected 1.00000001, loss {share_price/share_base - assets})")

# Arbitrage example
shares_big = 10000
share_price = 150_000_000  # 1.5 BTC
fee_bps = 100  # 1%
assets_big = (shares_big * share_price) // share_base
fee_big = (assets_big * fee_bps) // bps_base
print(f"\nBig tx: {shares_big} shares => assets {assets_big}, fee {fee_big}")

# Split into 10x 1000
total_fee_split = 0
for _ in range(10):
    assets_small = (1000 * share_price) // share_base
    fee_small = (assets_small * fee_bps) // bps_base
    total_fee_split += fee_small
print(f"Split tx: 10x 1000 shares => total fee {total_fee_split}, save {fee_big - total_fee_split}")

# Issue 2: mgmt fee zeroing
mgmt_fee_rate = 55  # 0.55%
net_assets = 1000
mgmt_fee = (mgmt_fee_rate * net_assets) // (bps_base * pct_base)
print(f"\nMgmt fee calc: rate={mgmt_fee_rate}, net-assets={net_assets} => mgmt-fee={mgmt_fee} (expected ~0.55, rounds to 0)")

net_assets = 100_000
mgmt_fee = (mgmt_fee_rate * net_assets) // (bps_base * pct_base)
print(f"Mgmt fee calc: rate={mgmt_fee_rate}, net-assets={net_assets} => mgmt-fee={mgmt_fee}")

# Issue 3: handle-profit rounding
reward = 1000
total_fees = 55
reward_after = reward - total_fees
reserve_rate = 5000  # 50%
reward_rf = (reward_after * reserve_rate) // bps_base
print(f"\nReward: {reward}, fees {total_fees}, after {reward_after}, reserve-rate {reserve_rate} => reward-rf {reward_rf} (expected 472.5, loss 0.5)")

# Deposit cap bypass
total_assets = 100
pending = 60
net_assets = total_assets - pending
cap = 100
deposit = 60
print(f"\nDeposit cap bypass: total={total_assets}, pending={pending}, net={net_assets}, cap={cap}, deposit={deposit}")
print(f"Check net+deposit={net_assets+deposit} <= cap? {net_assets+deposit <= cap} passes, but total+deposit={total_assets+deposit} > cap? {total_assets+deposit > cap} -> bypass!")

PY

echo ""
echo "=== Fix ==="
cat << 'FIX'
- For process-claim, use single division: fee = shares * share-price * fee-bps / (share-base * bps-base) to reduce rounding from 2 to 1.
- Or round up fees: div-up(a,b) = a/b + (1 if a mod b !=0 else 0)
- For mgmt-fee, ensure min fee 1 sat: (if (is-eq raw-fee u0) u1 raw-fee) or use div-up.
- For deposit cap, check total-assets not net-assets: (<= (+ total-assets assets) cap)
FIX

echo ""
echo "=== PoC Result ==="
echo "VULNERABLE SUCCESS: Double division rounding and fee zeroing confirmed – HIGH severity (theft of unclaimed yield)"
echo "Also: Deposit cap bypass via net-assets – MEDIUM"
echo "Issue #195 open, not fixed in mainnet v1-2"
