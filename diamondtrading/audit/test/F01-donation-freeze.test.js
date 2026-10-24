// F-01 — Permanent fund freeze by a 1-wei donation (lanesIntact is an EQUALITY check).
// Attack: anyone transfers 1 wei of USDC straight to DiamondHouse / DiamondOptions.
//   balance() becomes pool+openStakes+1 ⇒ lanesIntact() == false ⇒ every state-changing path
//   that does `require(lanesIntact())` reverts: buyTicket, settleWithProof, refundAfterStall,
//   harvest, lpDeposit, lpWithdraw. No owner sweep exists, so the freeze is permanent.
const { expect } = require("../lib/expect");
const W_ = require("../lib/world");
const { makeWorld, buyTicket, settleHouse, signHouseQuote, signOptionQuote, timeTravel, revertOf, U, X, isFixed, SET } = W_;

describe(`F-01 donation freeze [set=${SET}]`, function () {
  this.timeout(600000);

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
});
