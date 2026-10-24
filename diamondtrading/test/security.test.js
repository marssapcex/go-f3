// Security regression suite for the 2026-10-24 audit triage.
// Runs against the production artifacts on in-process Ganache by default, or Hardhat when
// AUDIT_EVM=hardhat. No vulnerable/fixed artifact mixing. Each finding is checked against the
// behavior selected for THIS repository: no sweep, no 100% mint-cap change, and queueDebt
// remains deferred debt rather than LP NAV.
const { ethers } = require("ethers");
const ganache = process.env.AUDIT_EVM === "hardhat" ? null : require("ganache");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");
const { Quoter } = require("../engine/quoter.js");
const { EpochLedger, leafOf, signRevenueAnchor, LAUNCH_RATE_BPS } = require("../engine/ledger.js");

const U = (n) => BigInt(n) * 10n ** 6n;
const E18 = (n) => BigInt(n) * 10n ** 18n;
const X = (n) => BigInt(Math.round(n * 1e4));
const PX = (n) => BigInt(Math.round(n * 1e8));
const PRICE01 = 1_000_000n;
const MNEMONIC = "test test test test test test test test test test test junk";
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));

let pass = 0, fail = 0;
function ok(condition, name) {
  if (condition) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name); }
}
async function revertOf(promise) {
  try { const tx = await promise; if (tx?.wait) await tx.wait(); return null; }
  catch (e) {
    return [e?.info?.error?.message, e?.shortMessage, e?.reason, e?.message]
      .filter(Boolean).join(" | ").slice(0, 800);
  }
}
async function expectRevert(promise, needle, name) {
  const reason = await revertOf(promise);
  if (reason !== null && reason.includes(needle)) { pass++; console.log("  PASS revert:", name, `[${needle}]`); }
  else { fail++; console.log("  FAIL", name, reason === null ? "[NO REVERT]" : `[wrong revert: ${reason}]`); }
}
function malleate(signature) {
  const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  const sig = ethers.Signature.from(signature);
  const s = N - BigInt(sig.s);
  const v = sig.yParity === 0 ? 28 : 27;
  return ethers.concat([sig.r, ethers.toBeHex(s, 32), ethers.toBeHex(v, 1)]);
}
const pairHash = (a, b) => a < b ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a]));

async function main() {
  const useHardhat = process.env.AUDIT_EVM === "hardhat";
  const gprov = useHardhat ? null : ganache.provider({ chain: { chainId: 31337 }, wallet: { totalAccounts: 20 }, logging: { quiet: true } });
  const eip1193 = useHardhat ? require("hardhat").network.provider : gprov;
  const provider = new ethers.BrowserProvider(eip1193);
  const accounts = await provider.listAccounts();
  const [owner, lp, relayer, p1, p2, p3, p4, p5, honest, attacker] = accounts;
  const hd = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
  const quoter = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);
  const C = (name, signer) => new ethers.ContractFactory(art(name).abi, art(name).bytecode, signer);
  const now = async () => Number((await provider.getBlock("latest")).timestamp);
  const warp = async (seconds) => {
    const before = await provider.getBlock("latest");
    await provider.send("evm_increaseTime", [seconds]);
    for (let i = 0; i < 60; i++) {
      await provider.send("evm_mine", []);
      const after = await provider.getBlock("latest");
      if (after.timestamp >= before.timestamp + seconds) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  async function makeWorld({ withOptions = false, blocklist = false, classCap = U(50_000) } = {}) {
    const usdc = await (await C(blocklist ? "BlocklistUSDC" : "MockUSDC", owner).deploy()).waitForDeployment();
    const usdcAddr = await usdc.getAddress();
    const diamond = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
    const dist = await (await C("DiamondDistributor", owner).deploy(await diamond.getAddress())).waitForDeployment();
    const house = await (await C("DiamondHouse", owner).deploy(usdcAddr, quoter.address)).waitForDeployment();
    const hA = await house.getAddress();
    const ov = await (await C("MultiAttesterVerifier", owner).deploy(
      [att1.address, att2.address, att3.address], 2, hA)).waitForDeployment();
    await (await house.setOutcomeVerifier(await ov.getAddress())).wait();
    await (await house.setClassCfg(1, 10_000_000, classCap, true)).wait();

    let options = null, oA = null, pv = null;
    if (withOptions) {
      options = await (await C("DiamondOptions", owner).deploy(usdcAddr, quoter.address)).waitForDeployment();
      oA = await options.getAddress();
      pv = await (await C("MultiPriceVerifier", owner).deploy(
        [att1.address, att2.address, att3.address], 2, oA)).waitForDeployment();
      await (await options.setPriceVerifier(await pv.getAddress())).wait();
      await (await options.setClassCfg(1, 250_000, classCap, true)).wait();
    }
    const sink = await (await C("RevenueSplit", owner).deploy(usdcAddr, await diamond.getAddress())).waitForDeployment();
    const sA = await sink.getAddress();
    await (await house.setRevenueSink(sA)).wait();
    await (await sink.setHouse(hA)).wait();
    if (options) { await (await options.setRevenueSink(sA)).wait(); await (await sink.setPusher(oA, true)).wait(); }
    await (await diamond.setTransferAllowlist(sA, true)).wait();

    for (const signer of [lp, relayer, p1, p2, p3, p4, p5, honest, attacker]) {
      await (await usdc.connect(owner).mint(signer.address, U(1_000_000))).wait();
      await (await usdc.connect(signer).approve(hA, ethers.MaxUint256)).wait();
      if (options) await (await usdc.connect(signer).approve(oA, ethers.MaxUint256)).wait();
    }
    const Q = new Quoter(quoter, { houseAddr: hA, optionsAddr: oA, chainId: 31337 });
    const W = { usdc, diamond, dist, house, hA, ov, options, oA, pv, sink, sA, Q };
    W.signOutcome = async (id, outcome) => {
      const domain = { name: "DiamondOutcome", version: "1", chainId: 31337, verifyingContract: await ov.getAddress() };
      const types = { Outcome: [{ name: "ticketId", type: "uint256" }, { name: "outcome", type: "uint8" }, { name: "house", type: "address" }] };
      const value = { ticketId: id, outcome, house: hA };
      return [await att1.signTypedData(domain, types, value), await att2.signTypedData(domain, types, value)];
    };
    W.signPrice = async (id, closePx) => {
      const domain = { name: "DiamondPrice", version: "1", chainId: 31337, verifyingContract: await pv.getAddress() };
      const types = { OptPrice: [{ name: "optionId", type: "uint256" }, { name: "closePx", type: "uint64" }, { name: "house", type: "address" }] };
      const value = { optionId: id, closePx, house: oA };
      return [await att1.signTypedData(domain, types, value), await att2.signTypedData(domain, types, value)];
    };
    W.quoteHouse = async (who, stake, mult, ttl = 60) => Q.signTicket({
      classId: 1, dir: 0, stake, multX1e4: X(mult), validUntil: (await now()) + 25, ttl,
      salt: ethers.randomBytes(32), buyer: who.address,
    });
    W.buyHouse = async (who, stake, mult, ttl = 60) => {
      const { q, sig } = await W.quoteHouse(who, stake, mult, ttl);
      const rc = await (await house.connect(who).buyTicket(q, sig, X(mult), ttl)).wait();
      return rc.logs.find((log) => log.fragment?.name === "Sold").args[0];
    };
    W.settleHouse = async (id, outcome) => (await house.connect(relayer).settleWithProof(
      id, outcome, await W.signOutcome(id, outcome), { gasLimit: 1_500_000 })).wait();
    W.quoteOption = async (who, premium, mult = 3, ttl = 60) => Q.signOption({
      classId: 1, dir: 0, premium, multX1e4: X(mult), bandBps: 50, strikeX1e8: PX(78),
      validUntil: (await now()) + 25, ttl, salt: ethers.randomBytes(32), buyer: who.address,
    });
    W.buyOption = async (who, premium, mult = 3, ttl = 60) => {
      const { q, sig } = await W.quoteOption(who, premium, mult, ttl);
      const rc = await (await options.connect(who).buyOption(q, sig, q.strikeX1e8, ttl)).wait();
      return rc.logs.find((log) => log.fragment?.name === "OSold").args[0];
    };
    W.settleOption = async (id, closePx) => (await options.connect(relayer).settleWithPrice(
      id, closePx, await W.signPrice(id, closePx), { gasLimit: 1_500_000 })).wait();
    return W;
  }

  console.log("\n[SEC-01] donation solvency + signed/single-use House and Options quotes");
  {
    const W = await makeWorld({ withOptions: true });
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const liveId = await W.buyHouse(p1, U(100), 2);
    const stallId = await W.buyHouse(p1, U(50), 2);
    await (await W.house.connect(lp).lpRequestExit(await W.house.lpShares(lp.address))).wait();
    await (await W.usdc.connect(p5).transfer(W.hA, 1n)).wait();
    ok(await W.house.lanesIntact(), "1-wei donation leaves House solvent and usable");

    const quote = await W.quoteHouse(p2, U(10), 2, 60);
    await expectRevert(W.house.connect(p2).buyTicket(quote.q, quote.sig, X(2), 30), "ttl mismatch", "House rejects buyer-selected TTL");
    await (await W.house.connect(p2).buyTicket(quote.q, quote.sig, X(2), 60)).wait();
    ok(true, "signed House TTL buys successfully after a donation");
    await expectRevert(W.house.connect(p2).buyTicket.staticCall(quote.q, quote.sig, X(2), 60), "quote used", "House quote cannot be replayed");
    await expectRevert(W.house.connect(p2).buyTicket.staticCall(quote.q, malleate(quote.sig), X(2), 60), "quote used", "malleable signature cannot bypass quote consumption");

    await W.settleHouse(liveId, 2);
    await (await W.house.connect(p2).harvest(1)).wait();
    await warp(7 * 86400 + 60);
    await (await W.house.connect(lp).lpWithdraw()).wait();
    await warp(2 * 86400);
    await (await W.house.connect(p1).refundAfterStall(stallId)).wait();
    ok(true, "settle, harvest, LP exit and stall refund all survive donation");
    ok(W.house.sweepSurplus === undefined, "no sweepSurplus backdoor was added");

    await (await W.usdc.connect(p5).transfer(W.oA, 1n)).wait();
    const oq = await W.quoteOption(p1, U(100), 3, 60);
    await expectRevert(W.options.connect(p1).buyOption(oq.q, oq.sig, oq.q.strikeX1e8, 30), "ttl mismatch", "Options rejects unsigned TTL substitution");
    await (await W.options.connect(p1).buyOption(oq.q, oq.sig, oq.q.strikeX1e8, 60)).wait();
    ok(await W.options.lanesIntact(), "Options donation cannot freeze purchases");
    await expectRevert(W.options.connect(p1).buyOption.staticCall(oq.q, oq.sig, oq.q.strikeX1e8, 60), "quote used", "Options quote is single-use");
    await warp(75);
    await W.settleOption(0n, PX(78));
    ok(await W.options.lanesIntact(), "Options settlement survives donation");
  }

  console.log("\n[SEC-02] JIT stake + multi-staker streaming + exact sink allowance");
  {
    const W = await makeWorld();
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    await (await W.diamond.setMinter(owner.address)).wait();
    for (const [who, amount] of [[honest, 10_000], [p4, 30_000], [attacker, 90_000]]) {
      await (await W.diamond.mint(who.address, E18(amount))).wait();
      await (await W.diamond.connect(who).approve(W.sA, ethers.MaxUint256)).wait();
    }
    await (await W.sink.connect(honest).stake(E18(10_000), { gasLimit: 500_000 })).wait();
    await (await W.sink.connect(p4).stake(E18(30_000), { gasLimit: 500_000 })).wait();
    const id = await W.buyHouse(p1, U(10_000), 2);
    await (await W.sink.connect(attacker).stake(E18(90_000), { gasLimit: 500_000 })).wait(); // front-run settle
    await W.settleHouse(id, 1); // 399 USDC to stakers
    ok(await W.usdc.allowance(W.hA, W.sA) === 0n, "fee pull leaves zero standing House allowance");

    const attacker0 = await W.usdc.balanceOf(attacker.address);
    await (await W.sink.connect(attacker).claimReward({ gasLimit: 500_000 })).wait();
    await (await W.sink.connect(attacker).requestUnbond(E18(90_000), { gasLimit: 500_000 })).wait();
    const attackerGot = (await W.usdc.balanceOf(attacker.address)) - attacker0;
    ok(attackerGot < U(1), "JIT attacker cannot instantly capture the fee");

    await warp(7 * 86400 + 60);
    const honest0 = await W.usdc.balanceOf(honest.address), p40 = await W.usdc.balanceOf(p4.address);
    await (await W.sink.connect(honest).claimReward({ gasLimit: 500_000 })).wait();
    await (await W.sink.connect(p4).claimReward({ gasLimit: 500_000 })).wait();
    const honestGot = (await W.usdc.balanceOf(honest.address)) - honest0;
    const p4Got = (await W.usdc.balanceOf(p4.address)) - p40;
    ok(honestGot + p4Got > U(398), "long-term stakers receive almost all of the 399 USDC stream");
    const ratio = Number(p4Got) / Number(honestGot);
    ok(Math.abs(ratio - 3) < 0.001, "two persistent stakers accrue pro-rata (30k / 10k = 3)");

    await expectRevert(W.house.connect(owner).setRevenueSink(attacker.address), "sink must be contract", "EOA revenue sink is rejected");
    const sink2 = await (await C("RevenueSplit", owner).deploy(await W.usdc.getAddress(), await W.diamond.getAddress())).waitForDeployment();
    const sink2Addr = await sink2.getAddress();
    await (await W.house.connect(owner).setRevenueSink(sink2Addr)).wait();
    await (await W.house.connect(owner).setRevenueSink(W.sA)).wait();
    ok(await W.usdc.allowance(W.hA, sink2Addr) === 0n && await W.usdc.allowance(W.hA, W.sA) === 0n,
      "sink rotation leaves no stale or replacement standing allowance");
    const nonPull = await (await C("NonPullSink", owner).deploy()).waitForDeployment();
    await (await W.house.connect(owner).setTargetPool(0)).wait();
    await (await W.house.connect(owner).setRevenueSink(await nonPull.getAddress())).wait();
    await expectRevert(W.house.connect(owner).distributeRevenue(U(1)), "allowance left",
      "a sink that does not pull cannot leave a standing allowance");
  }

  console.log("\n[SEC-03] epoch claim budget, unset attester and domain replay");
  {
    const W = await makeWorld();
    const dist = W.dist, dA = await dist.getAddress();
    await (await W.diamond.setMinter(dA)).wait();
    await (await dist.setBudgetAttester(budgeter.address)).wait();
    const anchor = U(100), attackerAmount = E18(1_000_000), honestAmount = E18(10_000);
    const attackerLeaf = leafOf(1, attacker.address, attackerAmount), honestLeaf = leafOf(1, honest.address, honestAmount);
    const root = pairHash(attackerLeaf, honestLeaf);
    const budget = await dist.budgetFor(anchor, PRICE01);
    const domain = { chainId: 31337, distributor: dA };
    const sig = await signRevenueAnchor(budgeter, 1n, anchor, PRICE01, domain);
    await (await dist.postEpoch(1, root, budget, anchor, PRICE01, sig)).wait();
    await expectRevert(dist.connect(attacker).claim(1, attackerAmount, [honestLeaf]), "epoch budget exhausted", "Merkle leaf cannot exceed posted epoch totalMint");
    ok(await W.diamond.balanceOf(attacker.address) === 0n, "over-budget attacker received zero DIAMOND");
    await (await dist.connect(honest).claim(1, honestAmount, [attackerLeaf])).wait();
    ok(await dist.epochClaimed(1) === honestAmount, "valid claim is tracked inside epoch budget");

    const dist2 = await (await C("DiamondDistributor", owner).deploy(await W.diamond.getAddress())).waitForDeployment();
    await (await dist2.setBudgetAttester(budgeter.address)).wait();
    await expectRevert(dist2.postEpoch(1, root, budget, anchor, PRICE01, sig), "bad budget sig", "budget signature cannot replay on another distributor");
    await (await dist.setBudgetAttester(ethers.ZeroAddress)).wait();
    await expectRevert(dist.postEpoch(2, ethers.randomBytes(32), 0n, anchor, PRICE01, "0x" + "00".repeat(65)),
      "no budget attester", "unset attester rejects an all-zero signature");
  }

  console.log("\n[SEC-04] orphan pool, inflation defence and pool-zero recapitalization");
  {
    const W = await makeWorld();
    const id = await W.buyHouse(p1, U(1_000), 2);
    await W.settleHouse(id, 2);
    await (await W.house.connect(p5).lpDeposit(1n)).wait();
    ok(await W.house.lpShareOffset() === U(1_000) * 1_000_000n,
      "1-wei deposit is priced against 1,000 USDC of protected orphan assets");
    const smallDeposit = U(1), whaleDeposit = U(100_000);
    await (await W.house.connect(p5).lpDeposit(smallDeposit)).wait();
    await (await W.house.connect(p4).lpDeposit(whaleDeposit)).wait();
    await (await W.house.connect(p5).lpRequestExit(await W.house.lpShares(p5.address))).wait();
    await (await W.house.connect(p4).lpRequestExit(await W.house.lpShares(p4.address))).wait();
    await warp(7 * 86400 + 60);
    const small0 = await W.usdc.balanceOf(p5.address), whale0 = await W.usdc.balanceOf(p4.address);
    await (await W.house.connect(p5).lpWithdraw()).wait();
    await (await W.house.connect(p4).lpWithdraw()).wait();
    const smallGot = (await W.usdc.balanceOf(p5.address)) - small0;
    const whaleGot = (await W.usdc.balanceOf(p4.address)) - whale0;
    ok(smallGot > 0n && smallGot <= smallDeposit + 1n, "1 wei + 1 USDC cannot capture the orphaned pool");
    ok(whaleGot > 0n && whaleGot <= whaleDeposit, "100x whale deposit cannot capture orphaned assets either");
    ok(await W.house.pool() >= U(1_000), "orphaned house assets remain in non-redeemable virtual shares");

    const drain1 = await W.buyHouse(p1, U(1_000), 2);
    await W.settleHouse(drain1, 1);
    const drain2 = await W.buyHouse(p1, U(1_000), 2);
    await W.settleHouse(drain2, 1); // consumes the remaining pool; deferred debt stays public
    const recapDeposit = U(100);
    await (await W.house.connect(p5).lpDeposit(recapDeposit)).wait();
    await (await W.house.connect(p5).lpRequestExit(await W.house.lpShares(p5.address))).wait();
    await warp(7 * 86400 + 60);
    const recap0 = await W.usdc.balanceOf(p5.address);
    await (await W.house.connect(p5).lpWithdraw()).wait();
    const recapGot = (await W.usdc.balanceOf(p5.address)) - recap0;
    ok(recapGot <= recapDeposit && recapGot + 1n >= recapDeposit,
      "consumed orphan offset does not dilute a true-empty 100-USDC recapitalization");
  }
  {
    const W = await makeWorld();
    await (await W.house.connect(attacker).lpDeposit(1n)).wait();
    const id = await W.buyHouse(attacker, U(2_000), 2);
    await W.settleHouse(id, 2); // self-funded NAV inflation
    const victimDeposit = U(2_999);
    await (await W.house.connect(p4).lpDeposit(victimDeposit)).wait();
    await (await W.house.connect(attacker).lpRequestExit(await W.house.lpShares(attacker.address))).wait();
    await (await W.house.connect(p4).lpRequestExit(await W.house.lpShares(p4.address))).wait();
    await warp(7 * 86400 + 60);
    const a0 = await W.usdc.balanceOf(attacker.address), v0 = await W.usdc.balanceOf(p4.address);
    await (await W.house.connect(attacker).lpWithdraw()).wait();
    await (await W.house.connect(p4).lpWithdraw()).wait();
    const attackerGot = (await W.usdc.balanceOf(attacker.address)) - a0;
    const victimGot = (await W.usdc.balanceOf(p4.address)) - v0;
    ok(attackerGot < U(2_000), "share-inflation attacker cannot recover its self-donation");
    ok(victimGot + U(1) >= victimDeposit, "virtual offsets protect the later LP from rounding theft");
  }
  {
    const W = await makeWorld();
    await (await W.house.connect(lp).lpDeposit(U(100))).wait();
    const oldShares = await W.house.lpShares(lp.address);
    await (await W.house.connect(lp).lpRequestExit(oldShares)).wait();
    const id = await W.buyHouse(p1, U(100), 500);
    await W.settleHouse(id, 1); // drains pool to zero, leaves deferred queue debt
    await warp(7 * 86400 + 60);
    await expectRevert(W.house.connect(lp).lpWithdraw(), "nav empty", "zero-pool LP exit does not burn shares");
    ok(await W.house.lpPendingExit(lp.address) === oldShares, "failed zero-pool exit preserves the request");
    await (await W.house.connect(p5).lpDeposit(1n)).wait();
    const dustShares = await W.house.lpShares(p5.address);
    ok(dustShares * 1_000_000n < oldShares, "pool-zero dust recap cannot dilute existing LP shares");
  }

  console.log("\n[SEC-05] blocklisted queue payees become credits (House and Options)");
  {
    const W = await makeWorld({ blocklist: true });
    for (const who of [p1, p2]) { const id = await W.buyHouse(who, U(100), 2); await W.settleHouse(id, 1); }
    await (await W.usdc.connect(owner).setBlocked(p1.address, true)).wait();
    await (await W.house.connect(lp).lpDeposit(U(1_000))).wait();
    const loser = await W.buyHouse(p3, U(10), 2);
    await W.settleHouse(loser, 2);
    await (await W.house.connect(p3).harvest(4)).wait();
    const credit = await W.house.credits(p1.address);
    ok(credit > 0n && await W.house.lanesIntact(), "blocked House head no longer stalls settlement or harvest");
    await (await W.usdc.connect(owner).setBlocked(p1.address, false)).wait();
    const before = await W.usdc.balanceOf(p1.address);
    await (await W.house.connect(p1).withdrawCredit({ gasLimit: 500_000 })).wait();
    ok((await W.usdc.balanceOf(p1.address)) - before === credit && await W.house.totalCredits() === 0n,
      "House credit is fully withdrawable after unblocking");
  }
  {
    const W = await makeWorld({ withOptions: true, blocklist: true });
    const id = await W.buyOption(p1, U(100), 3);
    await warp(75);
    await W.settleOption(id, PX(78.39));
    ok(await W.options.queueDebt() > 0n, "Options setup creates a queued payout");
    await (await W.usdc.connect(owner).setBlocked(p1.address, true)).wait();
    const other = await W.buyOption(p3, U(1_000), 3);
    await warp(75);
    await W.settleOption(other, PX(78));
    const credit = await W.options.credits(p1.address);
    ok(credit > 0n && await W.options.lanesIntact(), "blocked Options payee does not stall the FIFO");
    await (await W.usdc.connect(owner).setBlocked(p1.address, false)).wait();
    const before = await W.usdc.balanceOf(p1.address);
    await (await W.options.connect(p1).withdrawCredit({ gasLimit: 500_000 })).wait();
    ok((await W.usdc.balanceOf(p1.address)) - before === credit && await W.options.totalCredits() === 0n,
      "Options credit is fully withdrawable after unblocking");
  }

  console.log("\n[SEC-06] zero queue entries and exact anchor accounting at the retained 200% rate");
  {
    const W = await makeWorld();
    const id = await W.buyHouse(p2, U(100), 2);
    await W.settleHouse(id, 1);
    const entries = await W.house.liveQueueEntries();
    const dust = await W.buyHouse(p1, 1n, 1.05);
    await W.settleHouse(dust, 1);
    ok(await W.house.liveQueueEntries() === entries, "zero-profit win creates no zero-value queue entry");

    const L = new EpochLedger({ epochMs: 6 * 3600 * 1000 });
    L.add({ owner: "0xA", ts: 10, stake: U(10_000), payout: U(19_800), feePaid: U(200) });
    L.add({ owner: "0xB", ts: 20, stake: U(10_000), payout: 0n, feePaid: U(200) });
    const summary = L.summarize(0);
    ok(summary.anchor === U(200) && summary.fees === U(400), "anchor is 200 USDC, not double-counted 600 USDC");
    ok(LAUNCH_RATE_BPS === 20_000, "adaptive launch ceiling remains 200% by explicit product decision");
  }

  console.log("\n[SEC-07] deploy refuses missing/public production signing keys");
  {
    const root = path.join(__dirname, "..");
    const runDeploy = (env, rpc) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "scripts", "deploy.js")], {
        cwd: root, env: { PATH: process.env.PATH, RPC: rpc, ...env },
      });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("deploy.js timeout")); }, 30_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    const missing = await runDeploy({}, "http://127.0.0.1:9");
    ok(missing.code === 2 && missing.output.includes("deploy refused") && !missing.output.includes("ECONNREFUSED"),
      "deploy with no explicit keys exits 2 before touching RPC");

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        const result = msg.method === "eth_chainId" ? "0x1" : msg.method === "net_version" ? "1" : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const rpc = `http://127.0.0.1:${server.address().port}`;
      const refused = await runDeploy({ DEMO_KEYS: "1" }, rpc);
      ok(refused.code === 2 && refused.output.includes("only allowed on local chains"),
        "DEMO_KEYS=1 is refused on chainId 1");
    } finally { server.close(); }
  }

  console.log(`\n==== security regression: ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error?.info?.error?.message || error.shortMessage || error.message || error); process.exit(1); });
