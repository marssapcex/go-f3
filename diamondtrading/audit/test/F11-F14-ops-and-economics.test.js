// F-11 — Head-of-line DoS: _payQueue() pushes USDC to queue owners inside every settlement and
//        `require`s the transfer. One queued payee that the token refuses (USDC blocklist /
//        pause-like behaviour) makes EVERY settlement and harvest revert, indefinitely, while
//        pool > 0 — the FIFO head can never be skipped.
// F-12 — Hygiene/low: (a) zero-amount queue entries are pushed when a winning ticket's net profit
//        rounds to 0 while queueDebt > 0; (b) DiamondDistributor accepts a sig when
//        budgetAttester is never configured (address(0) == ecrecover(invalid) == 0x0).
// F-13 — Revenue stranding: notifyRevenue() with totalStaked == 0 credits nothing and keeps the
//        USDC in RevenueSplit forever (no path ever distributes it).
// F-14 — Anti-farm invariant broken in the off-chain ledger: anchor = feeSum + edge, but
//        edge = stakeSum − paySum ALREADY includes the fees (they are withheld from the payout), so
//        fees are counted twice. Hedged self-funded pairs then earn ~2× their own spread at the
//        launch rate (200%): a farm that converts USDC into DIAMOND at a profit.
const { expect } = require("../lib/expect");
const { ethers } = require("hardhat");
const W_ = require("../lib/world");
const { makeWorld, buyTicket, settleHouse, revertOf, timeTravel, U, E18, X, SET, isFixed, signHouseQuote } = W_;

describe(`F-11 head-of-line DoS via blocklisted payee [set=${SET}]`, function () {
  this.timeout(600000);
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
});

describe(`F-12 zero-amount queue entries & unset budget attester [set=${SET}]`, function () {
  this.timeout(600000);
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
});

describe(`F-13 revenue stranded when no staker exists [set=${SET}]`, function () {
  this.timeout(600000);
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
});

describe(`F-14 anchor double-counts fees and the hedge farm is profitable [engine]`, function () {
  this.timeout(600000);
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
});

async function countTickets(W) {
  let n = 0;
  for (;;) { try { await W.house.tickets(n); n++; } catch (_) { break; } }
  return n;
}
