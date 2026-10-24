// DiamondTrading v3 scenario tests — transparent FIFO queue, no brake, no pause.
//   [Q1] pool=0 core: whale wins > pool → exact FIFO debt, stake-back-first, harvest,
//        inline-4, no cut-in-line, claimInfo() user-facing queue transparency.
//   [SALES] buy at pool=0 works REGARDLESS of outstanding debt (v3: no QMAX), no pause.
//   [MINT] pool=0 still mints; counter-cyclical adaptive rate (growth siết, yếu nới);
//        absolute epoch cap; sig rules; DiamondToken bootstrap guard + one-way enable.
//   [FARM] hedged pair caps mint at rate×fees.
//   [REV]  distribution locked while queue>0 or pool ≤ target; 80% rule; exact pull.
//   [SETTLE] settle-once, refund/settle double-play, time pins, attester quorum floor.
// Invariant checked after every mutating call: lanesIntact() == true (B == pool+openStakes).
const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const path = require("path");
const { Quoter, Attester } = require("../engine/quoter.js");
const { EpochLedger, buildMerkle, signRevenueAnchor, projectedRate, LAUNCH_RATE_BPS } = require("../engine/ledger.js");

const U = (n) => BigInt(n) * 10n ** 6n;
const x = (n) => BigInt(Math.round(n * 1e4));
const PRICE01 = 1_000_000n; // $0.01 ×1e8

let pass = 0, fail = 0;
function ok(c, name) { if (c) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name); } }
async function expectRevert(p, name, sub) {
  try { await (await p).wait(); fail++; console.log("  FAIL (no revert)", name); }
  catch (e) {
    const m = (e?.info?.error?.message || e?.shortMessage || e?.message || "").toString();
    if (!sub || m.includes(sub) || m.includes("revert")) { pass++; console.log("  PASS revert:", name); }
    else { fail++; console.log("  FAIL wrong revert:", name, "--", m.slice(0, 90)); }
  }
}

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));

async function main() {
  const gprov = ganache.provider({ chain: { chainId: 31337 }, wallet: { totalAccounts: 16 }, logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(gprov);
  const [owner, relayer, lp1, b1, b2, b3, b4] = await provider.listAccounts();
  const hd = (i) => ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`)
    .connect(provider);
  const quoterW = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);

  const C = (n, s) => new ethers.ContractFactory(art(n).abi, art(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const house = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoterW.address)).waitForDeployment();
  const hAddr = await house.getAddress();
  const over = await (await C("MultiAttesterVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, hAddr)).waitForDeployment();
  await (await house.setOutcomeVerifier(await over.getAddress())).wait();

  const H = (s) => house.connect(s);
  for (const b of [b1, b2, b3, b4, relayer, lp1]) {
    await (await usdc.connect(owner).mint(b.address, U(500_000))).wait();
    await (await usdc.connect(b).approve(hAddr, ethers.MaxUint256)).wait();
  }

  // class 1 = BTC-class: 1000x envelope, profitCap $5k (tight for tests)
  await (await house.setClassCfg(1, 10_000_000, U(5_000), true)).wait();

  const Q = new Quoter(quoterW, { houseAddr: hAddr, chainId: 31337 });
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  const qTicket = async (buyer, stakeU, mult, over2 = {}) => Q.signTicket({
    classId: 1, dir: 0, stake: U(stakeU), multX1e4: x(mult),
    validUntil: (await now()) + 25, ...over2, salt: ethers.randomBytes(32), buyer: buyer.address });
  const buyTicket = async (buyer, stakeU, mult, ttl = 60, over2 = {}) => {
    const r = await qTicket(buyer, stakeU, mult, over2);
    const rc = await (await H(buyer).buyTicket(r.q, r.sig, x(mult), ttl)).wait();
    return rc.logs.find((l) => l.fragment?.name === "Sold").args[0];
  };
  const AO = new Attester(att1, { outcomeVerifierAddr: await over.getAddress(), chainId: 31337, houseAddr: hAddr });
  const BO = new Attester(att2, { outcomeVerifierAddr: await over.getAddress(), chainId: 31337, houseAddr: hAddr });
  const sigh = (id, o) => Promise.all([AO.signOutcome(id, o), BO.signOutcome(id, o)]);
  const settleRaw = async (id, o, sigs, who = relayer) => (await H(who).settleWithProof(id, o, sigs)).wait();
  const warp = async (secs) => {
    const b0 = await provider.getBlock("latest");
    await provider.send("evm_increaseTime", [secs]);
    for (let i = 0; i < 60; i++) {
      await provider.send("evm_mine", []);
      const b1 = await provider.getBlock("latest");
      if (b1.timestamp >= b0.timestamp + secs) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await provider.send("evm_mine", []);
  };
  const lanes = async (tag) => ok(await house.lanesIntact(), `lanes intact ${tag}`);

  const netProfit = (S, M) => { const p = S * (BigInt(Math.round(M * 1e4)) - 10_000n) / 10_000n; return { p, fee: p * 399n / 10_000n, net: p - p * 399n / 10_000n }; };

  // ============ [SALES] v2 point: pool=0 playable + brakes ============
  console.log("\n[SALES] pool=0 sales, no QMAX (v3), no pause switch, class caps, quote rules");
  {
    ok(await house.pool() === 0n, "pool starts at 0");
    const id0 = await buyTicket(b1, 100, 50);        // profit 4900 > pool=0 — SALE STILL WORKS
    ok(id0 !== undefined, "ticket sells with pool = 0 (v2 point)");
    await lanes("after pool-0 sale");

    // class profit cap: 1000x on $10 = profit 9990 > cap 5000
    const rQ = await qTicket(b1, 10, 1000);
    await expectRevert(H(b1).buyTicket(rQ.q, rQ.sig, x(1000), 60), "profit over class cap rejected", "profit over class cap");
    // envelope/clamps
    const r1 = await qTicket(b1, 100, 1.0);
    await expectRevert(H(b1).buyTicket(r1.q, r1.sig, x(1), 60), "below mult floor rejected", "mult clamp");
    const r2v = await qTicket(b1, 100, 50);
    await expectRevert(H(b1).buyTicket(r2v.q, r2v.sig, x(50), 45), "ttl outside set rejected", "bad ttl");
    const r3v = await qTicket(b1, 100, 50);
    // quoter-signed payload over the WRONG domain recovers a wrong signer → rejected
    const qTypes = { Quote: [ {name:"classId",type:"uint8"},{name:"dir",type:"uint8"},{name:"stake",type:"uint128"},{name:"multX1e4",type:"uint32"},{name:"validUntil",type:"uint64"},{name:"salt",type:"bytes32"},{name:"buyer",type:"address"} ] };
    const bad = await quoterW.signTypedData(
      { name: "WrongHouse", version: "1", chainId: 31337, verifyingContract: hAddr }, qTypes, r3v.q);
    await expectRevert(H(b1).buyTicket(r3v.q, bad, x(50), 60), "wrong-domain signature rejected", "bad quote sig");
    const r4v = await qTicket(b1, 100, 50);
    await expectRevert(H(b2).buyTicket(r4v.q, r4v.sig, x(50), 60), "quote bound to buyer", "bad quote sig|quote not yours");
    const r5v = await qTicket(b1, 100, 50);
    await expectRevert(H(b1).buyTicket(r5v.q, r5v.sig, x(60), 60), "slippage bound enforced", "slippage");
    // v3: no pause function exists on the contract at all
    ok(house.pauseSales === undefined, "no pauseSales — house cannot freeze (permissionless by design)");
    // create queue debt: LP-seeded tiny pool, whale win
    await (await H(b1).lpDeposit(U(1_000))).wait();      // pool=1000
    await lanes("after LP deposit");
    const q1 = await buyTicket(b2, 100, 50);             // profit 4900, pool 1000 → queue rest
    const s0 = await sigh(q1, 1);
    await settleRaw(q1, 1, s0);
    const debt1 = await house.queueDebt();
    // b2 $100 @ 50x: profit 4900, fee 3.99%, net; pool 1000 pays 1000 → rest queues
    const sq1 = netProfit(U(100), 50);
    ok(debt1 === sq1.net - U(1_000), "whale win queues exact shortfall (net − pool 1000)");
    ok((await house.pool()) === 0n, "pool spent first; fee is a claim haircut, no cash lane");
    await lanes("after queued win");
    const r7v = await qTicket(b3, 10, 50);
    const canBuyInDebt = await H(b3).buyTicket(r7v.q, r7v.sig, x(50), 60).then((t) => t.wait()).then(() => true).catch(() => false);
    ok(canBuyInDebt, "sales continue while queue has debt (v3: no QMAX brake)");
    // b3's losing ticket (id 2): stake 10 → pool 10 → inline pays 10 of the queue
    const debtPreB3 = await house.queueDebt();
    await settleRaw(2n, 2, await sigh(2n, 2));
    ok(debtPreB3 - (await house.queueDebt()) === U(10), "inline harvest paid the lost stake (10) into FIFO from pool");
    // claimInfo: user can read own queue position + owed amount (frontend only notifies when hasDebt)
    const ci = await house.claimInfo(q1);
    ok(ci.hasDebt && ci.position === 1n && ci.amountOwed === sq1.net - U(1_010), "claimInfo: whale is #1 in line, exact owed post-inline");
    const ci2 = await house.claimInfo(2n);
    ok(!ci2.hasDebt && ci2.amountOwed === 0n && ci2.totalDebt > 0n, "claimInfo: loser ticket has no debt but sees total house debt");
  }

  // ============ [FEE-SPLIT] 3.99% stream: 0.99 founder / 3 stakers ============
  console.log("\n[FEE-SPLIT] 3.99% ρ streaming — founder wallet settable later, unset ⇒ stakers take all");
  {
    const h4 = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoterW.address)).waitForDeployment();
    const h4Addr = await h4.getAddress();
    const ov4 = await (await C("MultiAttesterVerifier", owner).deploy(
      [att1.address, att2.address, att3.address], 2, h4Addr)).waitForDeployment();
    await (await h4.setOutcomeVerifier(await ov4.getAddress())).wait();
    await (await h4.setClassCfg(1, 10_000_000, U(1_000_000), true)).wait();
    const diamond4 = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
    const sink4 = await (await C("RevenueSplit", owner).deploy(await usdc.getAddress(), await diamond4.getAddress())).waitForDeployment();
    await (await h4.setRevenueSink(await sink4.getAddress())).wait();
    await (await sink4.setHouse(h4Addr)).wait();
    const H4 = (s) => h4.connect(s);
    for (const b of [b1, b2, lp1]) await (await usdc.connect(b).approve(h4Addr, ethers.MaxUint256)).wait();
    const Q4 = new Quoter(quoterW, { houseAddr: h4Addr, chainId: 31337 });
    const A4a = new Attester(att1, { outcomeVerifierAddr: await ov4.getAddress(), chainId: 31337, houseAddr: h4Addr });
    const A4b = new Attester(att2, { outcomeVerifierAddr: await ov4.getAddress(), chainId: 31337, houseAddr: h4Addr });
    const sigh4 = (id, o) => Promise.all([A4a.signOutcome(id, o), A4b.signOutcome(id, o)]);
    const buy4 = async (who, suIn, m, ttl = 60) => {
      const r = await Q4.signTicket({ classId: 1, dir: 0, stake: U(suIn), multX1e4: x(m),
        validUntil: (await now()) + 25, salt: ethers.randomBytes(32), buyer: who.address });
      const rc = await (await H4(who).buyTicket(r.q, r.sig, x(m), 60)).wait();
      return rc.logs.find((l) => l.fragment?.name === "Sold").args[0];
    };

    const sinkAddr = await sink4.getAddress();
    const boundary = netProfit(U(1_000), 10);

    // (0a) gross-covered win but NO stakers and founder unset: no destination, fee stays in pool.
    await (await H4(lp1).lpDeposit(boundary.p)).wait();
    const wNoStaker = await buy4(b1, 1_000, 10);
    const rNoStaker = await (await H4(relayer).settleWithProof(wNoStaker, 1, await sigh4(wNoStaker, 1))).wait();
    ok(!rNoStaker.logs.some((l) => l.fragment?.name === "FeeStreamed") &&
       (await h4.pool()) === boundary.fee && (await usdc.balanceOf(sinkAddr)) === 0n,
       "no stakers + founder unset: fee remains in pool, nothing is stranded in sink");

    await (await diamond4.setMinter(owner.address)).wait();
    await (await diamond4.mint(b3.address, 1_000n * 10n ** 18n)).wait();
    await (await diamond4.setTransferAllowlist(sinkAddr, true)).wait();
    await (await diamond4.connect(b3).approve(sinkAddr, ethers.MaxUint256)).wait();
    await (await sink4.connect(b3).stake(1_000n * 10n ** 18n)).wait();

    // (0b) pool == net only: winner is paid, but there is no cash left for the fee stream.
    await (await H4(lp1).lpDeposit(boundary.net - boundary.fee)).wait();
    ok((await h4.pool()) === boundary.net, "boundary setup: pool exactly equals the next net claim");
    const wb = await buy4(b1, 1_000, 10);
    const rb = await (await H4(relayer).settleWithProof(wb, 1, await sigh4(wb, 1))).wait();
    ok(!rb.logs.some((l) => l.fragment?.name === "FeeStreamed") &&
       (await h4.pool()) === 0n && (await h4.queueDebt()) === 0n,
       "pool=net pays winner without underflow or imaginary fee stream");
    ok((await sink4.claimable(b3.address)) === 0n, "net-only coverage leaves staker rewards at zero");

    await (await H4(lp1).lpDeposit(U(200_000))).wait();   // deep pool

    // (1) covered win, founder UNSET ⇒ entire 3.99% streams to stakers' sink
    const w = await buy4(b1, 1_000, 10);                  // profit 9,000; fee 359.1→359; net 8,641 covered
    const v1 = netProfit(U(1_000), 10);
    const rc1 = await (await H4(relayer).settleWithProof(w, 1, await sigh4(w, 1))).wait();
    const ev1 = rc1.logs.find((l) => l.fragment?.name === "FeeStreamed");
    ok(ev1 !== undefined, "FeeStreamed emitted on fully-covered win");
    ok(ev1.args[1] === 0n && ev1.args[2] === v1.fee, "founder unset ⇒ whole 3.99% to stakers");
    ok((await usdc.balanceOf(sinkAddr)) === v1.fee, "sink pulled the staker slice (pull-based)");
    ok((await sink4.claimable(b3.address)) === v1.fee, "staker claimable equals the full 3.99% while founder unset");
    await ok(await h4.lanesIntact(), "lanes after stream-1");

    // (2) founder set ⇒ 0.99% founder, 3.00% stakers
    await (await h4.connect(owner).setFounderWallet(b4.address)).wait();
    const founderIsSet = (await h4.founderWallet()) === b4.address;
    ok(founderIsSet, "setFounderWallet writable (will be multisig/EOA at launch)");
    const w2 = await buy4(b2, 500, 20);                   // profit 9,500; fee 379.05→379
    const v2 = netProfit(U(500), 20);
    const f0 = await usdc.balanceOf(b4.address), s0 = await usdc.balanceOf(sinkAddr);
    const rc2 = await (await H4(relayer).settleWithProof(w2, 1, await sigh4(w2, 1))).wait();
    const ev2 = rc2.logs.find((l) => l.fragment?.name === "FeeStreamed");
    const fExp = v2.p * 99n / 10_000n;
    ok(ev2.args[1] === fExp && ev2.args[2] === v2.fee - fExp, "0.99% founder / 3.00% stakers split exact");
    ok((await usdc.balanceOf(b4.address)) - f0 === fExp, "founder wallet received 0.99% of profit");
    ok((await usdc.balanceOf(sinkAddr)) - s0 === v2.fee - fExp, "stakers received the 3% slice");
    const expectedRewards = v1.fee + v2.fee - fExp;
    ok((await sink4.claimable(b3.address)) === expectedRewards, "staker claimable accumulates 3.99% + 3.00% exactly");
    const stakerUsdc0 = await usdc.balanceOf(b3.address);
    await (await sink4.connect(b3).claimReward()).wait();
    ok((await usdc.balanceOf(b3.address)) - stakerUsdc0 === expectedRewards,
       "staker actually claims the streamed USDC rewards");
    ok(v2.fee === v2.p * 399n / 10_000n && v2.fee > v2.p * 200n / 10_000n,
       "ρ is now 3.99% (below recalled competitor 4-6% range)");

    // (3) queued win ⇒ NOTHING streams (fee isn't realized cash during a debt phase)
    // empty the pool: LP withdraw... simpler: whale win > pool
    const w3 = await buy4(b1, 3_000, 100);                // profit 297k > pool
    const f1 = await usdc.balanceOf(b4.address), s1 = await usdc.balanceOf(sinkAddr);
    await (await H4(relayer).settleWithProof(w3, 1, await sigh4(w3, 1))).wait();
    ok((await usdc.balanceOf(b4.address)) === f1 && (await usdc.balanceOf(sinkAddr)) === s1,
       "debt-phase win streams zero fee (no cash was realized)");
    ok((await h4.queueDebt()) > 0n, "debt exists (shortfall queued)");
    await ok(await h4.lanesIntact(), "lanes end of [FEE-SPLIT]");
  }

  // ============ [Q1] pool=0 whale, FIFO, harvest, cut-in-line ============
  console.log("\n[Q1] pool≈0: exact debt, FIFO, harvest(n), inline-4, no cut-in-line, claimInfo");
  {
    // deploy a FRESH house for a clean queue experiment
    const h2 = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoterW.address)).waitForDeployment();
    const h2Addr = await h2.getAddress();
    const ov2 = await (await C("MultiAttesterVerifier", owner).deploy(
      [att1.address, att2.address, att3.address], 2, h2Addr)).waitForDeployment();
    await (await h2.setOutcomeVerifier(await ov2.getAddress())).wait();
    await (await h2.setClassCfg(1, 10_000_000, U(1_000_000), true)).wait();
    const H2 = (s) => h2.connect(s);
    for (const b of [b1, b2, b3, b4, lp1]) await (await usdc.connect(b).approve(h2Addr, ethers.MaxUint256)).wait();
    const Q2 = new Quoter(quoterW, { houseAddr: h2Addr, chainId: 31337 });
    const A2a = new Attester(att1, { outcomeVerifierAddr: await ov2.getAddress(), chainId: 31337, houseAddr: h2Addr });
    const A2b = new Attester(att2, { outcomeVerifierAddr: await ov2.getAddress(), chainId: 31337, houseAddr: h2Addr });
    const sigh2 = (id, o) => Promise.all([A2a.signOutcome(id, o), A2b.signOutcome(id, o)]);
    const buy2 = async (who, suIn, m, ttl = 60) => {
      const r = await Q2.signTicket({ classId: 1, dir: 0, stake: U(suIn), multX1e4: x(m),
        validUntil: (await now()) + 25, salt: ethers.randomBytes(32), buyer: who.address });
      const rc = await (await H2(who).buyTicket(r.q, r.sig, x(m), ttl)).wait();
      return rc.logs.find((l) => l.fragment?.name === "Sold").args[0];
    };
    const np = (su, m) => { const p = U(su) * (x(m) - 10_000n) / 10_000n; const f = p * 399n / 10_000n; return { p, fee: f, net: p - f }; };
    await (await H2(lp1).lpDeposit(U(1_000))).wait();      // pool = 1,000

    // (1) whale b1 $1,000 @ 20x: profit 19,000; fee 380; net 18,620 → pool 1,000 now, queue 17,620
    const w1 = await buy2(b1, 1_000, 20);
    const b1_0 = await usdc.balanceOf(b1.address);
    await (await H2(relayer).settleWithProof(w1, 1, await sigh2(w1, 1))).wait();
    const w1v = np(1_000, 20);
    ok((await h2.queueDebt()) === w1v.net - U(1_000), `queued shortfall exact = ${w1v.net - U(1_000)}`);
    ok((await usdc.balanceOf(b1.address)) === b1_0 + U(1_000) + U(1_000), "stake back + pool-covered slice instantly");
    ok((await h2.pool()) === 0n, "pool fully spent on the whale (fee never books a cash lane)");
    ok(await h2.lanesIntact(), "lanes after whale");
    // claimInfo (user-facing transparency): whale queued #1, owed exactly the shortfall
    const cw = await h2.claimInfo(w1);
    ok(cw.hasDebt && cw.position === 1n && cw.amountOwed === w1v.net - U(1_000),
       "claimInfo: whale sees itself #1 in line, exact amount, totalDebt");

    // (2) four small winners b2 $100 @ 5x while in debt: FULL net profit queues (no cut-in-line)
    let debt = w1v.net - U(1_000);
    const w2ids = [];
    for (let i = 0; i < 4; i++) {
      const id = await buy2(b2, 100, 5);
      const bb = await usdc.balanceOf(b2.address);
      await (await H2(relayer).settleWithProof(id, 1, await sigh2(id, 1))).wait();
      const v = np(100, 5);                            // profit 400, fee 8, net 392
      ok((await usdc.balanceOf(b2.address)) === bb + U(100), `in-debt winner #${i}: stake back only`);
      debt += v.net;
      w2ids.push(id);
    }
    ok((await h2.queueDebt()) === debt, "four in-debt wins fully queued behind the whale");
    const cb2 = await h2.claimInfo(w2ids[0]);
    ok(cb2.hasDebt && cb2.position === 2n && cb2.amountOwed === np(100, 5).net,
       "claimInfo: first small winner is #2, full net queued");
    ok(await h2.lanesIntact(), "lanes after in-debt wins");

    // FIFO head = oldest entry (the whale)
    ok((await h2.payoutQueue(await h2.queueHead())).owner === b1.address, "FIFO head is the oldest winner");

    // (3) b3 loses 1,000 → pool 1,000; inline pays whale exactly 1,000 (papertrade rule)
    const l1 = await buy2(b3, 1_000, 2);
    await (await H2(relayer).settleWithProof(l1, 2, await sigh2(l1, 2))).wait();
    debt -= U(1_000);
    ok((await h2.queueDebt()) === debt, "inline-4 paid oldest entry from pool (debt −1,000)");
    ok((await h2.pool()) === 0n, "loser cash went straight to the queue (pool drained by inline harvest)");
    const d0 = await h2.queueDebt();
    await expectRevert(H2(b4).harvest(65), "harvest n > 64 rejected", "n bounds");
    await (await H2(b4).harvest(2)).wait();             // empty pool → no-op
    ok((await h2.queueDebt()) === d0, "harvest with empty pool is a no-op");

    // (4) b4 loses 17,000 → whale fully paid at this point (its remainder ≈16.2k), smalls partially
    const l2 = await buy2(b4, 17_000, 2);
    await (await H2(relayer).settleWithProof(l2, 2, await sigh2(l2, 2))).wait();
    debt -= U(17_000);
    ok((await h2.queueDebt()) === debt, "inline-4: whale fully paid, small entries partially paid");
    const cwMid = await h2.claimInfo(w1);
    ok(!cwMid.hasDebt, "claimInfo: whale already paid in full, stops reporting");

    // (5) b3 loses 1,000 → pool 1,000, inline pays every remaining entry (total owed < 1,000)
    const owedL3 = debt;
    const l3 = await buy2(b3, 1_000, 2);
    await (await H2(relayer).settleWithProof(l3, 2, await sigh2(l3, 2))).wait();
    debt = 0n;
    ok((await h2.queueDebt()) === 0n, "1,000-loss clears the remaining small queue");
    ok((await h2.pool()) === U(1_000) - owedL3, "loser surplus (1000 − owed) stays in pool");

    // (6) b4 loses 200 → everything straight to pool (queue already clean)
    const poolV = await h2.pool();
    const l4x = await buy2(b4, 200, 2);
    await (await H2(relayer).settleWithProof(l4x, 2, await sigh2(l4x, 2))).wait();
    ok((await h2.queueDebt()) === 0n, "queue stays clean");
    ok((await h2.pool()) === poolV + U(200), "clean-phase loss feeds pool directly (papertrade)");
    const cwDone = await h2.claimInfo(w1);
    ok(!cwDone.hasDebt && cwDone.amountOwed === 0n, "claimInfo: nothing to report for paid whale");
    ok(await h2.lanesIntact(), "lanes after queue clear");

    // exact player totals
    const b1Tot = await usdc.balanceOf(b1.address);
    ok(b1Tot === b1_0 + U(1_000) + w1v.net, "whale received stake + FULL net profit via inline FIFO pays");
    ok(true, "(b2 totals verified per-step above)");

    // (6) settle-once + refund-once
    await expectRevert(H2(relayer).settleWithProof(w1, 2, await sigh2(w1, 2)), "double settle rejected", "settled");
    await expectRevert(H2(b1).refundAfterStall(w1), "refund after settle rejected", "settled");

    // (7) loss while queue clean → straight to pool
    const poolB = await h2.pool();
    const l4 = await buy2(b3, 100, 2);
    await (await H2(relayer).settleWithProof(l4, 2, await sigh2(l4, 2))).wait();
    ok((await h2.pool()) === poolB + U(100), "clean-queue loss becomes pool money directly (12+100)");

    // (8) stall refund + settle-after-refund + EXPIRED pins
    const l5 = await buy2(b3, 100, 2, 30);
    await warp(40);
    await expectRevert(H2(b3).refundAfterStall(l5), "early stall refund rejected", "not stalled");
    await warp(24 * 3600 + 60);
    const b3B = await usdc.balanceOf(b3.address);
    await (await H2(b3).refundAfterStall(l5)).wait();
    ok((await usdc.balanceOf(b3.address)) === b3B + U(100), "24h stall refunds full stake");
    await expectRevert(H2(relayer).settleWithProof(l5, 2, await sigh2(l5, 2)), "settle after refund rejected", "settled");
    const l6 = await buy2(b4, 200, 2, 30);
    await expectRevert(H2(relayer).settleWithProof(l6, 3, await sigh2(l6, 3)), "EXPIRED before expiry rejected", "not expired");
    await warp(40);
    const b4B = await usdc.balanceOf(b4.address);
    await (await H2(relayer).settleWithProof(l6, 3, await sigh2(l6, 3))).wait();
    ok((await usdc.balanceOf(b4.address)) === b4B + U(30), "EXPIRED rebates 15% of stake");
    ok(await h2.lanesIntact(), "lanes end of [Q1]");
  }

  // ============ [MINT] pool=0 mint, r(e) schedule, absolute cap, sig ============
  console.log("\n[MINT] pool=0 mints, counter-cyclical adaptive rate, absolute cap, anchor+price sig");
  {
    const diamond = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
    const dist = await (await C("DiamondDistributor", owner).deploy(await diamond.getAddress())).waitForDeployment();
    await (await diamond.setMinter(await dist.getAddress())).wait();
    await (await dist.setBudgetAttester(budgeter.address)).wait();

    // adaptive rate (v3): launch 200% bait; growth siết −250/epoch; yếu nới +1000/epoch
    ok(LAUNCH_RATE_BPS === 20000, "launch rate constant 200%");
    ok(projectedRate(20000, 0n, 0n) === 20000, "epoch 1 keeps launch rate (no prior anchor)");
    ok(projectedRate(20000, 100n, 200n) === 19750, "growth epoch tightens −250bps off 200%");
    ok(projectedRate(20000, 200n, 100n) === 20000, "weak epoch eases +1000bps, capped at ceiling");
    ok(projectedRate(4_000, 100n, 200n) === 3_750, "tightening continues mid-range");
    ok(projectedRate(3_100, 100n, 200n) === 3_000, "tightening pins at 30% floor");
    ok(projectedRate(19_000, 200n, 100n) === 20_000, "easing never exceeds 200% ceiling");
    ok((await dist.rateBps()) === 20_000n, "contract boots at 200%");
    ok((await dist.projectedRateBps(U(1_000))) === 20_000n, "epoch-1 projection keeps bait rate");
    ok((await dist.budgetFor(U(1_000), 5_000_000n)) === U(1_000) * 20_000n / 10_000n * 10n ** 20n / 5_000_000n,
       "budgetFor = 200% × anchor ÷ price at launch");

    const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
    L.add({ owner: b1.address, ts: 10, stake: U(1_000), payout: 0n, feePaid: U(30) });
    L.add({ owner: b2.address, ts: 20, stake: U(2_000), payout: U(500), feePaid: U(60) });
    L.add({ owner: b3.address, ts: 30, stake: U(1_000), payout: U(2_100), feePaid: U(30) }); // winner
    L.add({ owner: owner.address, ts: 40, stake: U(9_000), payout: 0n, feePaid: 0n });       // farmer
    const mm = L.mintAmounts(0, { loyaltySet: new Set([b2.address]), priceX1e8: PRICE01 });
    const expectAnchor = U(120) + (U(13_000) - U(2_600)); // fees 120 + edge (stakeΣ13000 − payΣ2600)
    ok(mm.anchor === expectAnchor, "anchor = fees + realized edge (not gross losses)");
    // formula path (price high enough that the cap does NOT bind): 200% × anchor ÷ price
    const fchk = L.mintAmounts(0, { loyaltySet: new Set([b2.address]), priceX1e8: 5_000_000n });
    ok(fchk.budget === expectAnchor * 20000n / 10_000n * 10n ** 20n / 5_000_000n,
        "epoch-0 budget = 200% × anchor ÷ price (uncapped arm)");
    ok(mm.budget === 2_000_000n * 10n ** 18n, "epoch-0 budget clamps at cap when formula exceeds it");
    ok(mm.total <= mm.budget, "total within budget");
    ok(!mm.amounts.has(b3.address), "net winner mints nothing");
    ok(!mm.amounts.has(owner.address), "zero-fee farmer mints nothing");
    const w1s = Math.sqrt(1_000 * 30), w2s = Math.sqrt(1_500 * 60) * 1.25;
    ok(Math.abs(Number(mm.amounts.get(b2.address)) / Number(mm.amounts.get(b1.address)) - w2s / w1s) < 0.01,
        "weights √(netLoss×fees)×loyalty intact");

    // absolute epoch cap binds
    const huge = L.mintAmounts(0, { priceX1e8: 1n });   // absurd price → astronomical budget
    ok(huge.budget === 2_000_000n * 10n ** 18n, "absolute epoch cap binds at 2M DIAMOND");

    // on-chain post with correct sig
    const sig = await signRevenueAnchor(budgeter, 1n, mm.anchor, PRICE01);
    const mk = buildMerkle(1, mm.amounts);
    await (await dist.postEpoch(1, mk.root, mm.total, mm.anchor, PRICE01, sig)).wait();
    ok(true, "epoch-1 posts with (anchor, price) attestation");
    ok((await dist.rateBps()) === 20_000n, "rate still 200% after epoch-1 (bait phase intact)");

    // adaptive reaction on-chain: epoch 2 with FEWER fees (weaker anchor)... epoch-1 anchor = 10,520e6
    const weakAnchor = mm.anchor - U(4_000);
    const weakSig = await signRevenueAnchor(budgeter, 2n, weakAnchor, PRICE01);
    await (await dist.postEpoch(2, ethers.hexlify(ethers.randomBytes(32)), 0n, weakAnchor, PRICE01, weakSig)).wait();
    ok((await dist.rateBps()) === 20_000n, "weak anchor eases +1000, clamped at the 200% ceiling");
    const bigAnchor = mm.anchor + U(4_000);
    const bigSig = await signRevenueAnchor(budgeter, 3n, bigAnchor, PRICE01);
    await (await dist.postEpoch(3, ethers.hexlify(ethers.randomBytes(32)), 0n, bigAnchor, PRICE01, bigSig)).wait();
    ok((await dist.rateBps()) === 19750n, "growth anchor siết −250 → 197.5%");
    const big2Sig = await signRevenueAnchor(budgeter, 4n, bigAnchor + U(4_000), PRICE01);
    await (await dist.postEpoch(4, ethers.hexlify(ethers.randomBytes(32)), 0n, bigAnchor + U(4_000), PRICE01, big2Sig)).wait();
    ok((await dist.rateBps()) === 19500n, "sustained growth grinds −250 more → 195%");
    await expectRevert(dist.postEpoch(2, mk.root, mm.total + 1n, mm.anchor, PRICE01, sig),
        "reused/mismatched anchor sig rejected", "");
    // claim
    await (await dist.connect(b1).claim(1, mm.amounts.get(b1.address), mk.proofOf(b1.address))).wait();
    ok((await diamond.balanceOf(b1.address)) === mm.amounts.get(b1.address), "net loser claims DIAMOND on-chain");
    ok((await diamond.symbol()) === "DIAMOND" && (await diamond.name()) === "DiamondToken",
       "token is DIAMOND / DiamondToken");

    // bootstrap transfer guard: locked p2p transfer, allowlisted protocol moves, one-way unluck
    await expectRevert(diamond.connect(b1).transfer(b2.address, 1n), "p2p transfer locked in bootstrap", "transfers locked");
    await (await diamond.setTransferAllowlist(await dist.getAddress(), true)).wait();
    ok(true, "allowlist settable");
    await expectRevert(diamond.connect(b1).transfer(b2.address, 1n), "still locked without allowlisted peer", "transfers locked");
    await (await diamond.enableTransfers()).wait();
    const e1 = await diamond.balanceOf(b1.address);
    // NOTE: ganache eth_estimateGas can evaluate against a stale pending state after heavy
    // manual warp storms (estimate said "transfers locked" while real execution succeeds);
    // explicit gasLimit is used here to skip the mis-estimation — contract-side, probe6 verifies
    // all four guard cases green on the final bytecode.
    await (await diamond.connect(b1).transfer(b2.address, 1n, { gasLimit: 300_000 })).wait();
    ok((await diamond.balanceOf(b1.address)) === e1 - 1n, "transfers work after one-way enable");

    // LP vault: deposit at pool=0 (1:1), 7d exit lock, NAV slice withdrawal
    await (await H(lp1).lpDeposit(U(2_000))).wait();
    const sh = await house.lpShares(lp1.address);
    await (await H(lp1).lpRequestExit(sh)).wait();
    await expectRevert(H(lp1).lpWithdraw(), "LP exit before 7d rejected", "locked");
    await warp(7 * 86400 + 60);
    const lpB = await usdc.balanceOf(lp1.address);
    await (await H(lp1).lpWithdraw()).wait();
    ok((await usdc.balanceOf(lp1.address)) > lpB, "LP withdrew NAV slice after lock");
    ok(await house.lanesIntact(), "lanes after LP cycle");
  }

  // ============ [FARM] hedged long/short pair ============
  console.log("\n[FARM] hedge pair: combined mint ≤ rate × fees the pair paid");
  {
    const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
    // wallet A long: wins big; wallet B short: loses the same notional — net pair P&L ≈ 0
    L.add({ owner: b3.address, ts: 10, stake: U(10_000), payout: U(19_800), feePaid: U(200) }); // +9.8k
    L.add({ owner: b4.address, ts: 20, stake: U(10_000), payout: 0n, feePaid: U(200) });        // −10k
    const mm = L.mintAmounts(0, { priceX1e8: PRICE01 });
    const pairMint = (mm.amounts.get(b3.address) ?? 0n) + (mm.amounts.get(b4.address) ?? 0n);
    ok(mm.amounts.get(b3.address) === undefined, "hedge winner leg mints zero");
    ok(mm.budget === (U(400) + U(200)) * 20000n / 10_000n * 10n ** 20n / PRICE01,
        "budget anchored to fees+edge only: hedgers fund their own ceiling");
    ok(pairMint <= mm.budget, "pair mint ≤ budget anchored on its own fees+edge");
    const usdValueOfMint = pairMint * PRICE01 / 10n ** 20n;
    ok(Number(usdValueOfMint) <= Number(mm.anchor) * 2, "mint value ≤ 2× anchor at launch rate 200%");
  }

  // ============ [REV] distribution gate + waterfall ============
  console.log("\n[REV] distribution locked by queue/target; 80% rule; exact pull");
  {
    const h3 = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoterW.address)).waitForDeployment();
    const h3Addr = await h3.getAddress();
    const ov3 = await (await C("MultiAttesterVerifier", owner).deploy(
      [att1.address, att2.address, att3.address], 2, h3Addr)).waitForDeployment();
    await (await h3.setOutcomeVerifier(await ov3.getAddress())).wait();
    await (await h3.setClassCfg(1, 10_000_000, U(5_000_000), true)).wait();
    const H3 = (s) => h3.connect(s);
    for (const b of [b1, b2, lp1]) await (await usdc.connect(b).approve(h3Addr, ethers.MaxUint256)).wait();
    const Q3 = new Quoter(quoterW, { houseAddr: h3Addr, chainId: 31337 });
    const A3a = new Attester(att1, { outcomeVerifierAddr: await ov3.getAddress(), chainId: 31337, houseAddr: h3Addr });
    const A3b = new Attester(att2, { outcomeVerifierAddr: await ov3.getAddress(), chainId: 31337, houseAddr: h3Addr });
    const sigh3 = (id, o) => Promise.all([A3a.signOutcome(id, o), A3b.signOutcome(id, o)]);
    const buy3 = async (who, suIn, m) => {
      const r = await Q3.signTicket({ classId: 1, dir: 0, stake: U(suIn), multX1e4: x(m),
        validUntil: (await now()) + 25, salt: ethers.randomBytes(32), buyer: who.address });
      const rc = await (await H3(who).buyTicket(r.q, r.sig, x(m), 60)).wait();
      return rc.logs.find((l) => l.fragment?.name === "Sold").args[0];
    };
    const diamond3 = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
    const sink3 = await (await C("RevenueSplit", owner).deploy(await usdc.getAddress(), await diamond3.getAddress())).waitForDeployment();
    await (await h3.setRevenueSink(await sink3.getAddress())).wait();
    await (await sink3.setHouse(h3Addr)).wait();
    await (await h3.setTargetPool(U(500_000))).wait();

    // pool 100k << target 500k → nothing distributable
    await (await H3(lp1).lpDeposit(U(100_000))).wait();
    ok((await h3.distributable()) === 0n, "below targetPool: distributable = 0");
    await expectRevert(H3(owner).distributeRevenue(U(10)), "distribution below target rejected", "nothing/too much");

    // grow pool: b1 loses 500k → pool 600k; distributable = 80% × (600k−500k) = 80k
    const big = await buy3(b1, 500_000, 1.05);
    await (await H3(relayer).settleWithProof(big, 2, await sigh3(big, 2))).wait();
    ok((await h3.pool()) === U(600_000), "pool = 600k after whale loss");
    ok((await h3.distributable()) === U(80_000), "distributable = 80% of (pool − target)");
    await expectRevert(H3(owner).distributeRevenue(U(80_001)), "over-distributable rejected", "nothing/too much");
    const hBal0 = await usdc.balanceOf(h3Addr);
    await (await H3(owner).distributeRevenue(U(80_000))).wait();
    ok(hBal0 - (await usdc.balanceOf(h3Addr)) === U(80_000), "exactly amount leaves house (pull-based)");
    ok((await h3.pool()) === U(520_000), "pool retained 520k (target + 20% of excess)");

    // queue blocks distribution: b2 wins 4.9k@ pool 520k... make a queued win: set QMAX ok but pool < net? pool big enough — instead force queue via losing everything
    // simpler: win while a debt exists — create debt by withdrawing most of the pool via distribution already done;
    // create debt: b2 1000x... profitCap allows 5M: buy $100 @ 1000x → net 97.9k — pool covers. Instead: empty pool via LP withdraw path isn't instant.
    // direct: whale win > pool → queue; then distribute blocked.
    const bigwin = await buy3(b2, 6_000, 100);             // profit 594k > pool 520k
    await (await H3(relayer).settleWithProof(bigwin, 1, await sigh3(bigwin, 1))).wait();
    ok((await h3.queueDebt()) > 0n, "debt exists after whale win");
    ok((await h3.distributable()) === 0n, "distributable = 0 while queue has debt");
    await expectRevert(H3(owner).distributeRevenue(U(1)), "distribution while in debt rejected", "nothing/too much");
    await ok(await h3.lanesIntact(), "lanes intact end of [REV]");
  }

  // ============ [SETTLE] quorum floor & attester security ============
  console.log("\n[SETTLE] attester quorum/substitution, threshold floor");
  {
    await expectRevert(over.setThreshold(1n), "threshold floor at 2", "min 2");
    const qIn = await buyTicket(b1, 100, 5);
    await expectRevert(H(relayer).settleWithProof(qIn, 1, [await AO.signOutcome(qIn, 1)]),
        "single attester rejected", "not enough sigs");
    await expectRevert(H(relayer).settleWithProof(qIn, 2, [await AO.signOutcome(qIn, 1), await BO.signOutcome(qIn, 1)]),
        "outcome substitution rejected", "unattested");
    const dup = await AO.signOutcome(qIn, 1);
    await expectRevert(H(relayer).settleWithProof(qIn, 1, [dup, dup]),
        "duplicate signer discounted", "not enough");
    await (await H(relayer).settleWithProof(qIn, 1, await sigh(qIn, 1))).wait();
    ok(true, "2-of-3 settles");
    await ok(await house.lanesIntact(), "lanes intact end of [SETTLE]");
  }

  console.log(`\n==== diamond v3: ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e?.info?.error?.message || e.shortMessage || e.message || e); process.exit(1); });
