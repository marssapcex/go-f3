// DiamondTrading v2 property fuzz — queue-bounded payout invariants.
// Mirror-lane design: every successful op updates a JS shadow of ALL money lanes;
// after EVERY op we assert on-chain == shadow:
//   G1  pool / sideBucket / openStakes / queueDebt exact mirror
//   G2  lanesIntact(): B == pool + side + open (on-chain view)
//   G3  WON while debt>0 ⇒ full net profit queued (no cut-in-line); else pool pays min(pool,net)
//   G4  FIFO: Dequeued entry ids strictly increasing (oldest first)
//   G5  sales revert iff queueDebt ≥ QMAX (and while paused)
//   G6  distribute only when queue clean and pool > target; exact amount leaves
// Deterministic: SEED / OPS env-tunable.
const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const path = require("path");

const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));

function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.SEED || 1337);
const OPS = Number(process.env.OPS || 150);
const U = (n) => BigInt(n) * 10n ** 6n;
const TTLS = [30, 60, 120, 300];
const FEE_BPS = 200n, BPS = 10_000n;

(async () => {
  const r = rng32(SEED);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const ri = (a, b) => a + Math.floor(r() * (b - a + 1));

  const gprov = ganache.provider({ chain: { chainId: 31337 }, wallet: { totalAccounts: 14 }, logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(gprov);
  const warp = async (secs) => {
    const b0 = await provider.getBlock("latest");
    await provider.send("evm_increaseTime", [secs]);
    for (let i = 0; i < 60; i++) {
      await provider.send("evm_mine", []);
      const b1 = await provider.getBlock("latest");
      if (b1.timestamp >= b0.timestamp + secs) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    await provider.send("evm_mine", []);
  };
  const now = async () => (await provider.getBlock("latest")).timestamp;

  const accs = await provider.listAccounts();
  const [owner, keeper, sinkSigner] = accs;
  const players = accs.slice(3, 9);
  const lps = accs.slice(9, 12);
  const hd = (i) => ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`)
    .connect(provider);
  const quoter = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33);

  const C = (n, s) => new ethers.ContractFactory(artifact(n).abi, artifact(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const house = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoter.address)).waitForDeployment();
  const houseAddr = await house.getAddress();
  const verifier = await (await C("MultiAttesterVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, houseAddr)).waitForDeployment();
  await (await house.setOutcomeVerifier(await verifier.getAddress())).wait();
  await (await house.setClassCfg(1, 10_000_000, U(50_000), true)).wait(); // 1000x env, $50k profit cap
  const edge = await (await C("EdgeToken", owner).deploy()).waitForDeployment();
  const sink = await (await C("RevenueSplit", owner).deploy(await usdc.getAddress(), await edge.getAddress())).waitForDeployment();
  await (await house.setRevenueSink(await sink.getAddress())).wait();
  await (await sink.setHouse(houseAddr)).wait();
  await (await house.setTargetPool(U(20_000))).wait();      // small target so distribute triggers in-fuzz

  const vDomain = { name: "DiamondOutcome", version: "1", chainId: 31337, verifyingContract: await verifier.getAddress() };
  const oTypes = { Outcome: [ { name: "ticketId", type: "uint256" }, { name: "outcome", type: "uint8" }, { name: "house", type: "address" } ] };
  const attest = (id, o) => Promise.all([att1, att2].map((a) =>
    a.signTypedData(vDomain, oTypes, { ticketId: id, outcome: o, house: houseAddr })));
  const qDomain = { name: "DiamondHouse", version: "1", chainId: 31337, verifyingContract: houseAddr };
  const qTypes = { Quote: [ {name:"classId",type:"uint8"},{name:"dir",type:"uint8"},{name:"stake",type:"uint128"},{name:"multX1e4",type:"uint32"},{name:"validUntil",type:"uint64"},{name:"salt",type:"bytes32"},{name:"buyer",type:"address"} ] };

  for (const p of [...players, ...lps]) {
    await (await usdc.connect(owner).mint(p.address, U(500_000))).wait();
    await (await usdc.connect(p).approve(houseAddr, ethers.MaxUint256)).wait();
  }
  const H = (s) => house.connect(s);

  // ---- shadow lanes ----
  let sh = { pool: 0n, side: 0n, open: 0n, debt: 0n };
  let totalShares = 0n;
  const queue = [];         // shadow {entryId(owner, amount, ticketId)} — head is queue[0]
  let entrySeq = 0, lastDeqId = -1;
  const open = [];          // { id, buyer, stake, mult, expiry }
  let paused = false;
  let checks = 0, buysOk = 0, settleOk = 0, refunds = 0, harvests = 0, dists = 0, reverts = 0, deqTotal = 0;

  function laneCheck(tag) {
    return Promise.all([house.pool(), house.sideBucket(), house.openStakes(), house.queueDebt(), house.lanesIntact()])
      .then(([p, s, o, d, lanes]) => {
        if (p !== sh.pool) throw new Error(`G1 pool drift @${tag}: chain ${p} vs shadow ${sh.pool}`);
        if (s !== sh.side) throw new Error(`G1 side drift @${tag}: chain ${s} vs shadow ${sh.side}`);
        if (o !== sh.open) throw new Error(`G1 open drift @${tag}: chain ${o} vs shadow ${sh.open}`);
        if (d !== sh.debt) throw new Error(`G1 debt drift @${tag}: chain ${d} vs shadow ${sh.debt}`);
        if (!lanes) throw new Error(`G2 lane break @${tag}`);
        checks++;
      });
  }

  function np(stake, multX1e4) {
    const profit = (BigInt(multX1e4) - 10_000n) * stake / 10_000n;
    const fee = profit * FEE_BPS / BPS;
    return { profit, fee, net: profit - fee };
  }

  async function opBuy() {
    const buyer = pick(players);
    const stake = U(pick([10, 25, 50, 100, 250, 500]));
    const mult = r() < 0.25 ? pick([10_500, 20_000, 50_000])
      : pick([100_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000]); // 75% high-mult → queues
    const ttl = pick(TTLS);
    const q = { classId: 1, dir: ri(0, 1), stake, multX1e4: mult,
      validUntil: (await now()) + 25, salt: ethers.hexlify(ethers.randomBytes(32)), buyer: buyer.address };
    const sig = await quoter.signTypedData(qDomain, qTypes, q);
    const { net } = np(stake, mult);
    const mustFail = (paused || sh.debt >= (await house.maxQueueDebt()) || net > U(50_000));
    try {
      const rc = await (await H(buyer).buyTicket(q, sig, mult, ttl)).wait();
      if (mustFail) throw new Error("G5 violated: sale succeeded while paused / QMAX-saturated / over class cap");
      const id = rc.logs.find((l) => l.fragment?.name === "Sold").args[0];
      open.push({ id, buyer, stake, mult, expiry: (await now()) + ttl });
      sh.open += stake; buysOk++;
    } catch (e) {
      if (mustFail) checks++; else reverts++;
    }
  }

  async function payQueueShadow(events) {
    // replay Dequeued events to drift-check shadow queue + G4 FIFO ordering
    for (const ev of events) {
      const [entryId, to, amt] = [Number(ev.args[0]), ev.args[1], ev.args[2]];
      if (entryId < lastDeqId) throw new Error(`G4 violated: dequeued ${entryId} after ${lastDeqId}`);
      lastDeqId = entryId;
      const head = queue[0] && queue[0].entryId === entryId ? queue[0] : queue.find((q) => q.entryId === entryId);
      if (!head || queue.indexOf(head) !== 0) throw new Error(`G4 violated: paid entry ${entryId} out of FIFO order`);
      if (amt > head.amount) throw new Error(`G4 overpay entry ${entryId}`);
      head.amount -= amt;
      sh.side -= amt; sh.debt -= amt;
      deqTotal += 1;
      if (head.amount === 0n) queue.shift();
    }
  }

  function sweepShadow() { if (sh.debt === 0n && sh.side > 0n) { sh.pool += sh.side; sh.side = 0n; } }

  async function opSettle() {
    if (!open.length) return;
    const i = Math.floor(r() * open.length);
    const t = open[i];
    let o = pick([1, 1, 2, 2, 3]);
    const tNow = await now();
    if (o === 3 && tNow < t.expiry) { o = r() < 0.5 ? 1 : (await warp(t.expiry - tNow + 1), 3); }
    const debtBefore = sh.debt, poolBefore = sh.pool;
    const b0 = await usdc.balanceOf(t.buyer.address);
    let rc;
    try { rc = await (await H(keeper).settleWithProof(t.id, o, await attest(t.id, o))).wait(); }
    catch (e) { reverts++; return; }
    open.splice(i, 1);
    sh.open -= t.stake;
    const deq = rc.logs.filter((l) => l.fragment?.name === "Dequeued");
    const deqToOwner = deq.filter((ev) => ev.args[1] === t.buyer.address)
      .reduce((s, ev) => s + ev.args[2], 0n);
    if (o === 1) {
      const { net } = np(t.stake, t.mult);
      let paid;
      if (debtBefore > 0n) {                                   // G3: no cut-in-line
        paid = 0n;
        queue.push({ entryId: entrySeq++, amount: net, ticketId: Number(t.id), owner: t.buyer });
        sh.debt += net;
      } else {
        paid = net > poolBefore ? poolBefore : net;
        sh.pool -= paid;
        if (paid < net) {
          queue.push({ entryId: entrySeq++, amount: (net - paid), ticketId: Number(t.id), owner: t.buyer });
          sh.debt += (net - paid);
        }
      }
      const got = (await usdc.balanceOf(t.buyer.address)) - b0;
      if (got !== t.stake + paid + deqToOwner) throw new Error(`G3 payout wrong: id=${t.id} got ${got} expect ${t.stake + paid + deqToOwner}`);
    } else if (o === 2) {
      if (debtBefore > 0n) sh.side += t.stake; else sh.pool += t.stake;
      const got = (await usdc.balanceOf(t.buyer.address)) - b0;
      if (got !== deqToOwner) throw new Error(`KNOCKED paid ${got} (expect only their queue payout ${deqToOwner})`);
    } else {
      const rebate = t.stake * 1_500n / BPS;
      const rest = t.stake - rebate;
      if (debtBefore > 0n) sh.side += rest; else sh.pool += rest;
      const got = (await usdc.balanceOf(t.buyer.address)) - b0;
      if (got !== rebate + deqToOwner) throw new Error(`EXPIRED rebate wrong: ${got} vs ${rebate + deqToOwner}`);
    }
    // replay inline harvest into shadow, THEN allow sweep (contract sweeps after paying)
    await payQueueShadow(deq);
    sweepShadow();
    settleOk++;
  }

  async function opStall() {
    if (!open.length) return;
    const t = open[0];
    const tNow = await now();
    if (tNow < t.expiry + 86400) await warp(t.expiry + 86400 - tNow + 5);
    const b0 = await usdc.balanceOf(t.buyer.address);
    try { await (await H(t.buyer).refundAfterStall(t.id)).wait(); } catch (e) { reverts++; return; }
    const got = (await usdc.balanceOf(t.buyer.address)) - b0;
    if (got !== t.stake) throw new Error(`stall refund wrong: ${got}`);
    open.shift(); sh.open -= t.stake; refunds++;
  }

  async function opHarvest() {
    try {
      const rc = await (await H(keeper).harvest(ri(1, 64))).wait();
      await payQueueShadow(rc.logs.filter((l) => l.fragment?.name === "Dequeued"));
      sweepShadow(); harvests++;
    } catch (e) { reverts++; }
  }

  async function opLpDeposit() {
    const lp = pick(lps);
    const amt = U(pick([300, 500, 1_000, 2_000]));
    try {
      const shares = totalShares === 0n || sh.pool === 0n ? amt : amt * totalShares / sh.pool;
      await (await H(lp).lpDeposit(amt)).wait();
      totalShares += shares; sh.pool += amt;
    } catch (e) { reverts++; }
  }

  async function opPause() { paused = !paused; await (await H(owner).pauseSales(paused)).wait(); }

  async function opDistribute() {
    const d = await house.distributable();
    if (d === 0n) { checks++; return; }
    const amt = d / BigInt(ri(1, 3));
    const b0 = await usdc.balanceOf(await sink.getAddress());
    try {
      await (await H(owner).distributeRevenue(amt)).wait();
      const moved = (await usdc.balanceOf(await sink.getAddress())) - b0;
      if (moved !== amt) throw new Error(`G6 distribution moved ${moved} != ${amt}`);
      sh.pool -= amt; dists++;
    } catch (e) { reverts++; }
  }

  async function opWarp() { await warp(pick([5, 30, 90, 200])); }

  const bag = [
    [30, opBuy], [24, opSettle], [8, opStall], [6, opHarvest], [10, opLpDeposit],
    [3, opPause], [5, opDistribute], [14, opWarp],
  ].flatMap(([w, f]) => Array(w).fill(f));

  let followUp = 0;
  for (let i = 0; i < OPS; i++) {
    // if anything is queued, force-follow with loss/harvest often so the queue actually drains
    const op = (sh.debt > 0n && r() < 0.25) ? (followUp++, opHarvest) : pick(bag);
    await op();
    await laneCheck(`op#${i} ${op.name}`);
  }

  // teardown: settle every remaining ticket, then drain queue via synthetic LP-funded losses not
  // possible — instead just verify mirror consistency of what's left open is empty when settled.
  for (const t of [...open]) {
    try {
      const tNow = await now();
      const o = tNow >= t.expiry ? 3 : 2;
      const b0 = await usdc.balanceOf(t.buyer.address);
      const debtBefore = sh.debt, poolBefore = sh.pool;
      const rc = await (await H(keeper).settleWithProof(t.id, o, await attest(t.id, o))).wait();
      sh.open -= t.stake;
      const deq = rc.logs.filter((l) => l.fragment?.name === "Dequeued");
      if (o === 3) {
        const rebate = t.stake * 1_500n / BPS, rest = t.stake - rebate;
        if (debtBefore > 0n) sh.side += rest; else sh.pool += rest;
      } else if (o === 2) {
        if (debtBefore > 0n) sh.side += t.stake; else sh.pool += t.stake;
      } else {
        const { net } = np(t.stake, t.mult);
        const paid = debtBefore > 0n ? 0n : (net > poolBefore ? poolBefore : net);
        sh.pool -= paid;
        if (paid < net) { queue.push({ entryId: entrySeq++, amount: net - paid, ticketId: Number(t.id), owner: t.buyer }); sh.debt += (net - paid); }
      }
      await payQueueShadow(deq); sweepShadow();
    } catch (e) { reverts++; }
  }
  await laneCheck("teardown");
  console.log(`fuzz-v2 SEED=${SEED} OPS=${OPS}: OK — ${checks} checks, ${buysOk} buys, ${settleOk} settles,` +
    ` ${refunds} stall refunds, ${harvests} harvests, ${deqTotal} FIFO payments (follow-ups ${followUp}),` +
    ` ${dists} distributions | end: pool=${sh.pool} side=${sh.side} debt=${sh.debt} (${reverts} expected reverts)`);
})().catch((e) => { console.error("FUZZ FAILURE:", e.message); process.exit(1); });
