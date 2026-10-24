const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers, provider, U, E18, X, PX, makeWorld, now, warp } = require("./runtime.cjs");
const { EpochLedger, buildMerkle, signRevenueAnchor, projectedRate, LAUNCH_RATE_BPS } = require("../../engine/ledger.js");

const DAY = 86_400;
const GENESIS = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
const seedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "fuzz-seeds.json"), "utf8"));
const scenario = process.env.FUZZ_SCENARIO || "house";
const OPERATIONS = Number(process.env.FUZZ_OPS || seedConfig.operations);
const SEEDS = (process.env.FUZZ_SEEDS || (seedConfig.seeds[scenario] || []).join(","))
  .split(",").filter(Boolean).map((x) => Number(x));
if (!SEEDS.length || !Number.isInteger(OPERATIONS) || OPERATIONS < 1) throw new Error("bad fuzz configuration");

function PRNG(seed) {
  let a = seed >>> 0;
  return {
    next() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; },
    int(n) { return Math.floor(this.next() * n); },
    pick(a) { return a[this.int(a.length)]; },
  };
}
const json = (x) => JSON.stringify(x, (_, v) => typeof v === "bigint" ? v.toString() : v);
const tx = async (p) => (await p).wait();
const events = (rc, name) => rc.logs.filter((l) => l.fragment?.name === name);
const event = (rc, name) => events(rc, name)[0];
const saltFor = (seed, i) => ethers.keccak256(ethers.toUtf8Bytes(`${scenario}:${seed}:${i}`));
function amount(r, maxUsd = 50_000) {
  const k = r.int(4);
  if (k === 0) return BigInt(1 + r.int(1_000));
  if (k === 1) return U(1 + r.int(100));
  if (k === 2) return U(1 + r.int(10_000));
  return U(1 + r.int(maxUsd));
}
async function expectRevert(fn, part) {
  let e;
  try { const t = await fn(); await t.wait(); } catch (err) { e = err; }
  assert(e, `expected revert containing ${part}`);
  assert(String(e.message).includes(part), `expected ${part}, got ${e.message}`);
}

let ACTIVE_RECORDER = null;
function recorder(seed) {
  const journal = [];
  let checks = 0;
  const out = {
    journal,
    get checks() { return checks; },
    record(i, op, args = {}) { journal.push({ i, op, args: JSON.parse(json(args)) }); },
    ok(v, msg) { checks++; assert(v, msg); },
  };
  ACTIVE_RECORDER = out;
  return out;
}

async function buyHouse(W, who, stake, mult, ttl, seed, i) {
  const { q, sig } = await W.quoteHouse(who, stake, mult, ttl, saltFor(seed, i));
  const rc = await tx(W.house.connect(who).buyTicket(q, sig, X(mult), ttl));
  return { id: event(rc, "Sold").args[0], rc };
}
async function buyOption(W, who, premium, mult, ttl, dir, seed, i) {
  const { q, sig } = await W.Q.signOption({ classId: 1, dir, premium, multX1e4: X(mult), bandBps: 50,
    strikeX1e8: PX(100), validUntil: (await now()) + 25, ttl, salt: saltFor(seed, i), buyer: who.address });
  const rc = await tx(W.options.connect(who).buyOption(q, sig, q.strikeX1e8, ttl));
  return { id: event(rc, "OSold").args[0], rc };
}

function fifoObserver(contract, R) {
  let lastDequeue = -1n, nextQueued = 0n;
  return async (rc) => {
    for (const name of ["Queued", "OQueued"]) for (const e of events(rc, name)) {
      R.ok(e.args[0] === nextQueued, `${name} entry IDs must be sequential`);
      nextQueued++;
    }
    for (const name of ["Dequeued", "ODequeued"]) for (const e of events(rc, name)) {
      R.ok(e.args[0] >= lastDequeue, `${name} cannot move backwards or skip around the FIFO head`);
      lastDequeue = e.args[0];
    }
  };
}

async function runHouse(seed, operations) {
  const R = recorder(seed), r = PRNG(seed);
  const W = await makeWorld({ withOptions: false, blocklist: true });
  const { house, usdc } = W, players = [W.p1, W.p2, W.p3];
  await tx(W.sink.connect(W.honest).stake(E18(1_000)));
  await tx(house.connect(W.lp).lpDeposit(U(1_000_000)));
  const cap = (await house.classCfg(1)).profitCap;
  const tickets = [], blocked = new Set(), observe = fifoObserver(house, R);

  async function invariants() {
    const [bal, pool, open, credits, shares] = await Promise.all([
      usdc.balanceOf(W.hA), house.pool(), house.openStakes(), house.totalCredits(), house.totalShares()]);
    R.ok(bal === pool + open + credits, `House exact token lanes: ${bal} != ${pool}+${open}+${credits}`);
    const localOpen = tickets.reduce((s, t) => s + (t.outcome === 0 ? t.stake : 0n), 0n);
    R.ok(open === localOpen, "House openStakes matches every local live ticket");
    let creditSum = 0n;
    for (const a of W.accounts) creditSum += await house.credits(a.address);
    R.ok(creditSum === credits, "House totalCredits equals all recipient credits");
    R.ok(shares === (await house.lpShares(W.lp.address)) + (await house.lpPendingExit(W.lp.address)),
      "LP real shares equal free plus pending-exit shares");
    const [head, live, debt] = await Promise.all([house.queueHead(), house.liveQueueEntries(), house.queueDebt()]);
    let sum = 0n;
    for (let i = head; i < head + live; i++) sum += (await house.payoutQueue(i)).amount;
    R.ok(sum === debt, "House queueDebt equals the exact sum of live FIFO entries");
  }

  for (let i = 0; i < operations; i++) {
    const choice = r.int(100), open = tickets.filter((t) => t.outcome === 0);
    if (choice < 27 || open.length === 0) {
      const who = r.pick(players.filter((p) => !blocked.has(p.address)));
      const stake = amount(r), ttl = r.pick([30, 60, 120, 300]);
      const legal = [1.05, 1.1, 2, 3, 10, 100, 1000].filter((m) => BigInt(Math.round((m - 1) * 10_000)) * stake / 10_000n <= cap);
      const mult = r.pick(legal);
      R.record(i, "buy", { who: who.address, stake, mult, ttl });
      const { id, rc } = await buyHouse(W, who, stake, mult, ttl, seed, i);
      const t = await house.tickets(id);
      tickets.push({ id, owner: who.address, stake: t.stake, outcome: 0 });
      await observe(rc);
    } else if (choice < 55) {
      const t = r.pick(open), outcome = r.pick([1, 1, 1, 2, 3]);
      const before = await house.tickets(t.id), openBefore = await house.openStakes();
      R.record(i, "settle", { id: t.id, outcome });
      if (outcome === 3 && (await now()) < Number(before.expiry)) await warp(Number(before.expiry) - (await now()));
      const rc = await W.settleHouse(t.id, outcome), e = event(rc, "Settled");
      if (outcome === 1) {
        const gross = (before.multX1e4 - 10_000n) * before.stake / 10_000n;
        const fee = gross * 399n / 10_000n;
        R.ok(e.args.stakeBack === before.stake && e.args.feeTaken === fee, "WON stake and 3.99% fee mirror the ticket");
        R.ok(e.args.profitPaid + e.args.profitQueued === gross - fee, "WON paid plus queued equals net profit");
      } else if (outcome === 2) {
        R.ok(e.args.stakeBack === 0n && e.args.profitPaid === 0n && e.args.profitQueued === 0n && e.args.feeTaken === 0n,
          "KNOCKED has no player payout or fee");
      } else {
        R.ok(e.args.stakeBack === before.stake * 1_500n / 10_000n && e.args.profitPaid === 0n && e.args.profitQueued === 0n,
          "EXPIRED rebates exactly 15%");
      }
      R.ok((await house.openStakes()) === openBefore - before.stake, "settlement removes exactly one open stake");
      t.outcome = outcome;
      await observe(rc);
    } else if (choice < 64) {
      const n = 1 + r.int(64); R.record(i, "harvest", { n });
      await observe(await tx(house.harvest(n)));
    } else if (choice < 72) {
      const seconds = r.pick([1, 30, 300, 3_600, DAY, 2 * DAY]); R.record(i, "warp", { seconds }); await warp(seconds);
    } else if (choice < 78) {
      const amt = amount(r, 100_000); R.record(i, "lpDeposit", { amt });
      await observe(await tx(house.connect(W.lp).lpDeposit(amt)));
    } else if (choice < 84) {
      const pending = await house.lpPendingExit(W.lp.address);
      if (pending > 0n) {
        if ((await house.pool()) === 0n) { R.record(i, "lpWithdrawSkippedAtZeroNAV"); }
        else {
          const available = Number(await house.lpExitAvailableAt(W.lp.address));
          R.record(i, "lpWithdraw", { shares: pending });
          if ((await now()) < available) await warp(available - (await now()));
          await observe(await tx(house.connect(W.lp).lpWithdraw()));
        }
      } else {
        const free = await house.lpShares(W.lp.address);
        const shares = free * BigInt(1 + r.int(100)) / 100n;
        R.record(i, "lpRequestExit", { shares });
        if (shares > 0n) await tx(house.connect(W.lp).lpRequestExit(shares));
      }
    } else if (choice < 89) {
      const t = r.pick(open), before = await house.tickets(t.id), openBefore = await house.openStakes();
      const target = Number(before.expiry) + DAY;
      R.record(i, "refundAfterStall", { id: t.id });
      if ((await now()) < target) await warp(target - (await now()));
      const rc = await tx(house.refundAfterStall(t.id));
      R.ok(event(rc, "Refunded").args.stake === before.stake && (await house.openStakes()) === openBefore - before.stake,
        "stall refund returns the exact original stake lane");
      t.outcome = 4; await observe(rc);
    } else if (choice < 94) {
      const candidates = [...players, W.lp];
      let who = null, credit = 0n;
      for (const p of candidates) { const c = await house.credits(p.address); if (c > 0n) { who = p; credit = c; break; } }
      if (!who) { R.record(i, "withdrawCreditSkipped"); await warp(1); }
      else if (blocked.has(who.address)) {
        R.record(i, "withdrawCreditBlocked", { who: who.address, credit });
        await expectRevert(() => house.connect(who).withdrawCredit(), "blocked");
        R.ok((await house.credits(who.address)) === credit, "failed blocked withdrawal preserves credit");
      } else {
        R.record(i, "withdrawCredit", { who: who.address, credit });
        const before = await usdc.balanceOf(who.address), rc = await tx(house.connect(who).withdrawCredit());
        R.ok((await usdc.balanceOf(who.address)) - before === credit, "credit withdrawal pays the full recorded amount");
        await observe(rc);
      }
    } else {
      const who = r.pick(players), on = !blocked.has(who.address);
      if (on && blocked.size === players.length - 1) { R.record(i, "setBlockedSkippedWouldBlockAll"); await warp(1); }
      else {
        R.record(i, "setBlocked", { who: who.address, on });
        await tx(usdc.connect(W.owner).setBlocked(who.address, on));
        if (on) blocked.add(who.address); else blocked.delete(who.address);
      }
    }
    await invariants();
  }
  return { checks: R.checks, journal: R.journal, final: { tickets: tickets.length, pool: await house.pool(), queueDebt: await house.queueDebt(), totalCredits: await house.totalCredits() } };
}

async function runOptions(seed, operations) {
  const R = recorder(seed), r = PRNG(seed);
  const W = await makeWorld({ withOptions: true, blocklist: true });
  const { options, usdc } = W, players = [W.p1, W.p2, W.p3];
  await tx(W.sink.connect(W.honest).stake(E18(1_000)));
  const cap = (await options.classCfg(1)).payCap;
  const rows = [], blocked = new Set(), observe = fifoObserver(options, R);

  async function invariants() {
    const [bal, pool, open, credits] = await Promise.all([usdc.balanceOf(W.oA), options.pool(), options.openPremiums(), options.totalCredits()]);
    R.ok(bal === pool + open + credits, "Options exact token lanes");
    R.ok(open === rows.reduce((s, o) => s + (o.state === 0 ? o.premium : 0n), 0n), "Options openPremiums matches local live rows");
    let cs = 0n; for (const a of W.accounts) cs += await options.credits(a.address);
    R.ok(cs === credits, "Options totalCredits equals all recipient credits");
    const [head, live, debt] = await Promise.all([options.queueHead(), options.liveQueueEntries(), options.queueDebt()]);
    let sum = 0n; for (let i = head; i < head + live; i++) sum += (await options.payoutQueue(i)).amount;
    R.ok(sum === debt, "Options queueDebt equals live FIFO sum");
  }

  // Seed pool with a premium whose attested close has zero payout.
  {
    const { id } = await buyOption(W, W.p1, U(100_000), 2, 30, 0, seed, -1);
    const o = await options.options(id); rows.push({ id, premium: o.premium, state: 0 });
    await warp(Number(o.expiry) - (await now())); await observe(await W.settleOption(id, o.strikeX1e8)); rows[0].state = 1;
  }

  for (let i = 0; i < operations; i++) {
    const choice = r.int(100), liveRows = rows.filter((o) => o.state === 0);
    if (choice < 32 || liveRows.length === 0) {
      const who = r.pick(players.filter((p) => !blocked.has(p.address)));
      const premium = amount(r), ttl = r.pick([30, 60, 120, 300]), dir = r.int(2);
      const legal = [1.05, 2, 5, 25].filter((m) => premium * BigInt(Math.round(m * 10_000)) / 10_000n <= cap);
      const mult = r.pick(legal); R.record(i, "buy", { who: who.address, premium, mult, ttl, dir });
      const { id, rc } = await buyOption(W, who, premium, mult, ttl, dir, seed, i);
      const o = await options.options(id); rows.push({ id, premium: o.premium, state: 0 }); await observe(rc);
    } else if (choice < 67) {
      const row = r.pick(liveRows), o = await options.options(row.id), openBefore = await options.openPremiums();
      const deltaBps = BigInt(r.pick([0, 10, 25, 50, 100, 200])), favorable = r.int(4) !== 0;
      let delta = o.strikeX1e8 * deltaBps / 10_000n;
      if (!favorable) delta = -delta;
      let close = o.dir === 0 ? o.strikeX1e8 + delta : o.strikeX1e8 - delta;
      if (close < 0n) close = 0n;
      R.record(i, "settle", { id: row.id, close });
      if ((await now()) < Number(o.expiry)) await warp(Number(o.expiry) - (await now()));
      const expected = await options.payoutOf(o.dir, o.strikeX1e8, o.bandBps, close, o.maxPay);
      const rc = await W.settleOption(row.id, close), e = event(rc, "OSettled"), fee = expected * 399n / 10_000n;
      R.ok(e.args.payout === expected && e.args.feeTaken === fee, "Options settlement matches payoutOf and 3.99% fee");
      R.ok(e.args.paidNow + e.args.queued === expected - fee, "Options paid plus queued equals net payout");
      R.ok((await options.openPremiums()) === openBefore - o.premium, "Options settlement removes exactly one premium lane");
      row.state = 1; await observe(rc);
    } else if (choice < 76) {
      const n = 1 + r.int(64); R.record(i, "harvest", { n }); await observe(await tx(options.harvest(n)));
    } else if (choice < 84) {
      const seconds = r.pick([1, 30, 300, 3_600, DAY]); R.record(i, "warp", { seconds }); await warp(seconds);
    } else if (choice < 89) {
      const row = r.pick(liveRows), o = await options.options(row.id), openBefore = await options.openPremiums();
      const target = Number(o.expiry) + DAY; R.record(i, "refundAfterStall", { id: row.id });
      if ((await now()) < target) await warp(target - (await now()));
      const rc = await tx(options.refundAfterStall(row.id));
      R.ok(event(rc, "ORefunded").args.premium === o.premium && (await options.openPremiums()) === openBefore - o.premium,
        "Options stall refund returns the exact premium"); row.state = 2; await observe(rc);
    } else if (choice < 95) {
      let who = null, credit = 0n;
      for (const p of players) { const c = await options.credits(p.address); if (c > 0n) { who = p; credit = c; break; } }
      if (!who) { R.record(i, "withdrawCreditSkipped"); await warp(1); }
      else if (blocked.has(who.address)) {
        R.record(i, "withdrawCreditBlocked", { who: who.address }); await expectRevert(() => options.connect(who).withdrawCredit(), "blocked");
        R.ok((await options.credits(who.address)) === credit, "Options blocked withdrawal preserves credit");
      } else {
        R.record(i, "withdrawCredit", { who: who.address, credit });
        const before = await usdc.balanceOf(who.address), rc = await tx(options.connect(who).withdrawCredit());
        R.ok((await usdc.balanceOf(who.address)) - before === credit, "Options credit pays in full after unblock"); await observe(rc);
      }
    } else {
      const who = r.pick(players), on = !blocked.has(who.address);
      if (on && blocked.size === players.length - 1) { R.record(i, "setBlockedSkippedWouldBlockAll"); await warp(1); }
      else {
        R.record(i, "setBlocked", { who: who.address, on });
        await tx(usdc.connect(W.owner).setBlocked(who.address, on));
        if (on) blocked.add(who.address); else blocked.delete(who.address);
      }
    }
    await invariants();
  }
  return { checks: R.checks, journal: R.journal, final: { options: rows.length, pool: await options.pool(), queueDebt: await options.queueDebt(), totalCredits: await options.totalCredits() } };
}

async function runRewards(seed, operations) {
  const R = recorder(seed), r = PRNG(seed), W = await makeWorld({ withOptions: false });
  const { sink, usdc, diamond } = W, stakers = [W.honest, W.attacker, W.p1, W.p2];
  await tx(sink.connect(W.owner).setPusher(W.owner.address, true));
  await tx(usdc.connect(W.owner).approve(W.sA, ethers.MaxUint256));
  await tx(sink.connect(W.honest).stake(E18(1_000), { gasLimit: 500_000 }));
  let notified = 0n, paid = 0n, notifications = 0, lastIndex = await sink.rewardIndex();
  function observe(rc) {
    for (const e of events(rc, "RevenueNotified")) { notified += e.args.amount; notifications++; }
    for (const name of ["RewardClaimed", "CreditWithdrawn"]) for (const e of events(rc, name)) paid += e.args.amount;
  }
  async function invariants() {
    let staked = 0n, unbonding = 0n, credits = 0n;
    for (const s of stakers) {
      staked += await sink.staked(s.address); unbonding += (await sink.unbonding(s.address)).amount; credits += await sink.credits(s.address);
      R.ok((await sink.claimable(s.address)) >= await sink.credits(s.address), "claimable includes at least all pull credits");
    }
    R.ok((await sink.totalStaked()) === staked, "totalStaked equals all stakers");
    R.ok((await diamond.balanceOf(W.sA)) === staked + unbonding, "sink DIAMOND equals staked plus unbonding balances");
    R.ok((await sink.totalCredits()) === credits, "reward credits equal all recipient credits");
    R.ok(notified - paid === await usdc.balanceOf(W.sA), "all notified USDC is either paid out or still in the sink");
    R.ok(paid <= notified, "reward claims can never exceed notified revenue");
    const idx = await sink.rewardIndex(); R.ok(idx >= lastIndex, "reward index never decreases"); lastIndex = idx;
  }

  for (let i = 0; i < operations; i++) {
    const choice = r.int(100), who = r.pick(stakers);
    if (choice < 24 || (await sink.totalStaked()) === 0n) {
      const amt = r.int(5) === 0 ? BigInt(1 + r.int(1_000_000)) : E18(1 + r.int(10_000));
      R.record(i, "stake", { who: who.address, amt }); observe(await tx(sink.connect(who).stake(amt, { gasLimit: 500_000 })));
    } else if (choice < 43) {
      const candidates = [];
      for (const s of stakers) if ((await sink.staked(s.address)) > 0n) candidates.push(s);
      const s = candidates.length ? r.pick(candidates) : who, balance = await sink.staked(s.address);
      if (balance === 0n) { R.record(i, "unbondSkipped"); await warp(1); }
      else {
        const amt = balance * BigInt(1 + r.int(100)) / 100n; R.record(i, "requestUnbond", { who: s.address, amt });
        observe(await tx(sink.connect(s).requestUnbond(amt, { gasLimit: 500_000 })));
      }
    } else if (choice < 53) {
      const u = await sink.unbonding(who.address);
      if (u.amount === 0n) { R.record(i, "withdrawUnbondSkipped"); await warp(1); }
      else {
        R.record(i, "withdrawUnbond", { who: who.address, amt: u.amount });
        if ((await now()) < Number(u.availableAt)) await warp(Number(u.availableAt) - (await now()));
        observe(await tx(sink.connect(who).withdrawUnbonded()));
      }
    } else if (choice < 73) {
      if ((await sink.totalStaked()) === 0n) { R.record(i, "notifySkippedWithoutStake"); await warp(1); }
      else {
        const amt = amount(r, 1_000); R.record(i, "notifyRevenue", { amt });
        observe(await tx(sink.connect(W.owner).notifyRevenue(amt, { gasLimit: 500_000 })));
      }
    } else if (choice < 88) {
      R.record(i, "claimReward", { who: who.address }); observe(await tx(sink.connect(who).claimReward({ gasLimit: 500_000 })));
    } else {
      const seconds = r.pick([1, 30, 300, 3_600, DAY, 2 * DAY]); R.record(i, "warp", { seconds }); await warp(seconds);
    }
    await invariants();
  }
  if ((await sink.totalStaked()) === 0n) observe(await tx(sink.connect(W.honest).stake(E18(1_000), { gasLimit: 500_000 })));
  const finish = Number(await sink.periodFinish()); if ((await now()) < finish + 2) await warp(finish + 2 - (await now()));
  for (const s of stakers) if ((await sink.staked(s.address)) > 0n) observe(await tx(sink.connect(s).claimReward({ gasLimit: 500_000 })));
  for (const s of stakers) R.ok((await sink.claimable(s.address)) === 0n, "finished stream leaves no claimable balance after final claims");
  await invariants();
  const dust = await usdc.balanceOf(W.sA);
  R.ok(dust <= BigInt(operations * stakers.length + notifications + stakers.length), "residual is bounded index/rate rounding dust, not unaccounted revenue");
  return { checks: R.checks, journal: R.journal, final: { notified, paid, dust, notifications } };
}

async function runDistributor(seed, operations) {
  const R = recorder(seed), r = PRNG(seed), W = await makeWorld({ withOptions: false, seedDiamond: false });
  const { dist, diamond } = W, users = [W.p1, W.p2, W.p3, W.honest, W.attacker];
  await tx(diamond.setMinter(await dist.getAddress())); await tx(dist.setBudgetAttester(W.budgeter.address));
  const dA = await dist.getAddress(), epochMs = 6 * 3_600_000, L = new EpochLedger({ epochMs });
  let rate = LAUNCH_RATE_BPS, previous = null, cumulative = 0n;
  const epochs = operations;
  for (let epoch = 1; epoch <= epochs; epoch++) {
    // Two records guarantee one net loser who also paid a winning-ticket fee.
    const guaranteed = r.pick(users), ts = epoch * epochMs + r.int(epochMs - 1);
    L.add({ owner: guaranteed.address, ts, stake: U(1_000_000), payout: 0n, feePaid: 0n });
    L.add({ owner: guaranteed.address, ts: ts + 1, stake: U(1_000_000), payout: U(1_500_000), feePaid: U(500_000) * 399n / 10_000n });
    const otherUsers = users.filter((u) => u.address !== guaranteed.address);
    for (let j = 0; j < 5; j++) {
      const stake = amount(r, 10_000), payout = stake * BigInt(r.int(201)) / 100n;
      L.add({ owner: r.pick(otherUsers).address, ts: epoch * epochMs + r.int(epochMs), stake, payout,
        feePaid: payout > stake ? (payout - stake) * 399n / 10_000n : 0n });
    }
    const summary = L.summarize(epoch), nextRate = projectedRate(rate, previous, summary.anchor);
    const price = r.pick([1n, 1_000n, 1_000_000n, 100_000_000n]);
    const mm = L.mintAmounts(epoch, { priceX1e8: price, rateBps: nextRate });
    R.record(epoch - 1, "epoch", { anchor: summary.anchor, price, nextRate, total: mm.total, rows: mm.amounts.size });
    R.ok(summary.anchor > 0n && mm.amounts.size > 0, "generated epoch has a positive anchor and eligible recipient");
    R.ok((await dist.projectedRateBps(summary.anchor)) === BigInt(nextRate), "off-chain adaptive rate mirrors contract");
    R.ok((await dist.budgetFor(summary.anchor, price)) === mm.budget, "off-chain token budget mirrors contract including absolute cap");
    const mk = buildMerkle(epoch, mm.amounts);
    const sig = await signRevenueAnchor(W.budgeter, epoch, summary.anchor, price, { chainId: 31337, distributor: dA });
    await tx(dist.postEpoch(epoch, mk.root, mm.total, summary.anchor, price, sig));
    R.ok((await dist.rateBps()) === BigInt(nextRate), "posted epoch stores the projected adaptive rate");
    for (const [account, amt] of mm.amounts) {
      const signer = users.find((u) => u.address.toLowerCase() === account.toLowerCase());
      const before = await diamond.balanceOf(account);
      await tx(dist.connect(signer).claim(epoch, amt, mk.proofOf(account)));
      R.ok((await diamond.balanceOf(account)) - before === amt, "Merkle claim mints exactly the allocated amount");
      cumulative += amt;
      R.ok((await dist.epochClaimed(epoch)) <= mm.total, "epoch claims never exceed posted totalMint");
    }
    R.ok((await dist.totalMinted()) === cumulative && (await diamond.totalSupply()) === cumulative,
      "distributor and token supply exactly track all Merkle claims");
    rate = nextRate; previous = summary.anchor;
  }
  return { checks: R.checks, journal: R.journal, final: { epochs, totalMinted: cumulative, finalRateBps: rate } };
}

const runners = { house: runHouse, options: runOptions, rewards: runRewards, distributor: runDistributor };
if (!runners[scenario]) throw new Error(`unknown scenario ${scenario}`);

(async () => {
  let root = await provider.send("evm_snapshot", []);
  const summaries = [];
  for (let n = 0; n < SEEDS.length; n++) {
    const seed = SEEDS[n];
    if (n > 0) { await provider.send("evm_revert", [root]); root = await provider.send("evm_snapshot", []); }
    await provider.send("evm_setNextBlockTimestamp", [GENESIS]);
    console.log(`\n[fuzz] scenario=${scenario} seed=${seed} operations=${OPERATIONS}`);
    try {
      const out = await runners[scenario](seed, OPERATIONS);
      summaries.push({ seed, operations: OPERATIONS, checks: out.checks, final: out.final });
      console.log(`  PASS checks=${out.checks} final=${json(out.final)}`);
    } catch (e) {
      const dir = path.join(__dirname, "counterexamples"); fs.mkdirSync(dir, { recursive: true });
      // Re-run is deterministic from genesis; the journal ends at the failing operation.
      const file = path.join(dir, `${scenario}-${seed}.json`);
      const payload = { scenario, seed, operations: OPERATIONS, error: e.message, stack: e.stack,
        journal: ACTIVE_RECORDER?.journal || [],
        replay: `FUZZ_SCENARIO=${scenario} FUZZ_SEEDS=${seed} FUZZ_OPS=${OPERATIONS} npx hardhat --config audit/hardhat/hardhat.config.cjs run --no-compile audit/hardhat/deep-fuzz.cjs` };
      fs.writeFileSync(file, json(payload) + "\n");
      console.error(`  FAIL seed=${seed}; counterexample=${file}`); throw e;
    }
  }
  const dir = path.join(__dirname, "results"); fs.mkdirSync(dir, { recursive: true });
  const result = { scenario, hardhat: "2.29.1", genesis: GENESIS, operationsPerSeed: OPERATIONS, seeds: summaries };
  fs.writeFileSync(path.join(dir, `${scenario}.json`), json(result) + "\n");
  console.log(`\n==== ${scenario}: ${summaries.length} seeds passed; results=audit/hardhat/results/${scenario}.json ====`);
})().catch((e) => { console.error(e); process.exit(1); });
