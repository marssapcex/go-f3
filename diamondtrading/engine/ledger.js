// Epoch ledger + anti-farm smart mint v2 (time-decayed budget — NO solvency/SRI throttle).
// Feeds: per-position settled records { owner, stake, payout, feePaid, ts }.
// Per epoch: net loss per address, weight w = √(netLoss × feesPaid) × loyalty,
// budget = r(e) × signed anchor (fees + realized edge — NEVER gross losses),
// converted USDC→EDGE at the signed reference price, absolute token cap on top.
// Merkle root/proofs in the EXACT EdgeDistributor format (OZ sorted-pair,
// leaf = keccak256(concat(keccak256(abi.encode(epochId, account, amount))))).
import { ethers } from "ethers";

export const MINT_SCHEDULE = { R0_BPS: 20000, R_FLOOR_BPS: 3000, N_DECAY: 360 };

/** r(e) in bps of anchor: 20000 → 3000 linearly over N_DECAY epochs, floor forever after.
 *  Mirrors EdgeDistributor.rateBps exactly. */
export function rateBps(epochId) {
  if (epochId >= MINT_SCHEDULE.N_DECAY) return MINT_SCHEDULE.R_FLOOR_BPS;
  return Math.floor(MINT_SCHEDULE.R0_BPS -
    (MINT_SCHEDULE.R0_BPS - MINT_SCHEDULE.R_FLOOR_BPS) * epochId / MINT_SCHEDULE.N_DECAY);
}

export class EpochLedger {
  constructor({ epochMs = 6 * 3600 * 1000, epochCapToken = 2_000_000n * 10n ** 18n } = {}) {
    this.epochMs = epochMs;
    this.epochCapToken = BigInt(epochCapToken); // absolute per-epoch mint cap (mirror of contract)
    this.records = [];
  }
  add(r) { this.records.push(r); }
  epochOf(ts) { return Math.floor(ts / this.epochMs); }

  /** totals for one epoch: per-address netLoss & feesPaid, plus realized fees and edge.
   *  payout counts EVERYTHING the player is entitled to (paid + queued + stake back),
   *  so queued-but-unpaid profits never inflate the house revenue figure. */
  summarize(epochId) {
    const t0 = epochId * this.epochMs, t1 = t0 + this.epochMs;
    const acc = new Map();   // owner -> { stake, paid, fees }
    let stakeSum = 0n, paySum = 0n, feeSum = 0n;
    for (const r of this.records) {
      if (r.ts < t0 || r.ts >= t1) continue;
      const a = acc.get(r.owner) || { stake: 0n, paid: 0n, fees: 0n };
      a.stake += r.stake;
      a.paid += r.payout;
      a.fees += r.feePaid; acc.set(r.owner, a);
      stakeSum += r.stake; paySum += r.payout; feeSum += r.feePaid;
    }
    const edge = stakeSum > paySum ? stakeSum - paySum : 0n;   // realized house edge (incl. fees)
    const anchor = feeSum + edge;                              // phí thực thu + edge thực hiện
    return { acc, revenue: edge, fees: feeSum, anchor };
  }

  /** smart-mint weights. loyaltySet: addresses staking EDGE through the epoch. */
  weights(epochId, { loyaltySet = new Set() } = {}) {
    const { acc, ...sums } = this.summarize(epochId);
    const rows = [];
    for (const [owner, a] of acc) {
      const netLoss = a.stake > a.paid ? a.stake - a.paid : 0n;   // NET of the whole epoch
      if (netLoss === 0n || a.fees === 0n) continue;              // must lose AND pay rake
      const w = Math.sqrt(Number(netLoss) * Number(a.fees)) * (loyaltySet.has(owner) ? 1.25 : 1);
      rows.push({ owner, netLoss, w });
    }
    return { rows, ...sums };
  }

  /** Budget-capped pro-rata mint (EDGE 18dp BigInt).
   *  anchor: USDC(6dp) realized fees+edge, signed by budgetAttester WITH the price.
   *  priceX1e8: USDC-per-EDGE reference (x1e8). tokenBudget = anchor × r(e)/1e4 × 1e20/price,
   *  then clamped by the absolute epoch cap. */
  mintAmounts(epochId, { priceX1e8 = 1_000_000n /* $0.01 */, ...wopts } = {}) {
    const { rows, anchor } = this.weights(epochId, wopts);
    const rate = rateBps(epochId);
    const usdBudget = anchor * BigInt(Math.floor(rate)) / 10_000n;             // 6d USDC
    let budget = usdBudget * 10n ** 20n / BigInt(priceX1e8);                  // 18d EDGE
    if (budget > this.epochCapToken) budget = this.epochCapToken;            // absolute cap
    // pure-BigInt allocation: scale float weights to 1e9 fixed-point first (budgets in
    // 18-dec EDGE routinely exceed 2^53, so Number() would corrupt the split)
    const rows9 = rows.map((r) => ({ ...r, w9: BigInt(Math.round(r.w * 1e9)) }));
    const wSum = rows9.reduce((s, r) => s + r.w9, 0n);
    const out = new Map();
    let total = 0n;
    for (const r of rows9) {
      const amt = wSum ? budget * r.w9 / wSum : 0n;
      if (amt > 0n) { out.set(r.owner, amt); total += amt; }
    }
    return { amounts: out, total, anchor, rateBps: BigInt(Math.floor(rate)),
             priceX1e8: BigInt(priceX1e8), budget };
  }
}

// ---------- merkle (EdgeDistributor-compatible) ----------
export const leafOf = (epochId, account, amount) => ethers.keccak256(ethers.concat([
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
    .encode(["uint256", "address", "uint256"], [epochId, account, amount]))]));

export function buildMerkle(epochId, entries /* Map<address, amount> | [[address, amount]] */) {
  const arr = [...entries.entries ? entries.entries() : entries]
    .map(([account, amount]) => ({ account, amount, leaf: leafOf(epochId, account, amount) }));
  arr.sort((a, b) => (a.leaf < b.leaf ? -1 : 1));
  const layers = [arr.map((e) => e.leaf)];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1], nxt = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 === cur.length) { nxt.push(cur[i]); continue; }   // odd promote, OZ-compatible
      const [a, b] = cur[i] < cur[i + 1] ? [cur[i], cur[i + 1]] : [cur[i + 1], cur[i]];
      nxt.push(ethers.keccak256(ethers.concat([a, b])));
    }
    layers.push(nxt);
  }
  const root = layers[layers.length - 1][0] ?? ethers.ZeroHash;
  const proofOf = (account) => {
    const i = arr.findIndex((e) => e.account.toLowerCase() === account.toLowerCase());
    if (i < 0) return null;
    const proof = []; let idx = i;
    for (let d = 0; d < layers.length - 1; d++) {
      const layer = layers[d];
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < layer.length) proof.push(layer[sib]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  };
  return { root, proofOf, leaves: arr.map((e) => ({ account: e.account, amount: e.amount })) };
}

/** budgetAttester signs the revenue anchor + reference price: EIP-191 personal_sign over
 *  keccak256(abi.encode(epochId, anchorUsd, priceX1e8)) — mirror of EdgeDistributor.postEpoch v2. */
export function signRevenueAnchor(wallet, epochId, anchorUsd, priceX1e8) {
  const h = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
    .encode(["uint256", "uint256", "uint256"], [epochId, anchorUsd, priceX1e8]));
  return wallet.signMessage(ethers.getBytes(h));
}
