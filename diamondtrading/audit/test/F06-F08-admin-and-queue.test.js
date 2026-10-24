// F-06 — LP exit ignores senior queue claims. lpWithdraw() pays NAV = pool, never subtracting
//        queueDebt (winners' owed profits). An LP can take its money out of a pool whose
//        cash is already promised to FIFO winners; the winners are left unpaid.
// F-07 — Deployment keys derived from the PUBLIC test mnemonic (scripts/deploy.js). The quoter
//        key (HD21) and the 2-of-3 attester keys (HD31-33) are known to everyone. Anyone can
//        sign a quote for any ticket and then attest their own ticket as WON ⇒ pool drain.
// F-08 — Owner can approve ANY address to pull all of House's USDC (setRevenueSink does
//        usdc.approve(sink, MAX) with no validation and never revokes the previous sink).
//        Contradicts the doctrine "owner can only tune menu config, never gate user funds".
const { expect } = require("../lib/expect");
const { ethers } = require("hardhat");
const W_ = require("../lib/world");
const { makeWorld, buyTicket, settleHouse, signHouseQuote, timeTravel, revertOf, hd, U, X, SET, isFixed, deploy } = W_;

describe(`F-06 LP exit subordinates the queue [set=${SET}]`, function () {
  this.timeout(600000);
  it("LP withdraws its 100 USDC while winners' profit is still owed", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p1, p2 } = W.signers;
    // pool is empty: five winning 100-stake 2x tickets are fully queued (no LP yet)
    for (let i = 0; i < 5; i++) {
      const id = await buyTicket(W, i % 2 ? p1 : p2, 100, 2);
      await (await settleHouse(W, id, 1)).wait();
    }
    console.log(`  [EVIDENCE] queueDebt after 5 wins with empty pool = ${await W.house.queueDebt()} (6dp), pool = ${await W.house.pool()}`);
    await (await W.house.connect(lp).lpDeposit(U(100))).wait();   // LP enters the indebted pool
    console.log(`  [EVIDENCE] after LP deposit 100: pool=${await W.house.pool()}, queueDebt=${await W.house.queueDebt()}`);
    await (await W.house.connect(lp).lpRequestExit(await W.house.lpShares(lp.address))).wait();
    await timeTravel(7 * 86400 + 60);
    const b0 = await W.usdc.balanceOf(lp.address);
    const rW = await revertOf(W.house.connect(lp).lpWithdraw());
    const got = (await W.usdc.balanceOf(lp.address)) - b0;
    console.log(`  [EVIDENCE] lpWithdraw → ${rW ?? "OK"}, LP received ${Number(got) / 1e6} USDC`);
    console.log(`  [EVIDENCE] remaining queueDebt owed to winners = ${await W.house.queueDebt()} (6dp), pool = ${await W.house.pool()}`);
    if (!isFixed()) {
      expect(got).gte(U(100));                    // LP takes its full 100 USDC...
      expect(await W.house.queueDebt()).gt(0n);   // ...while winners remain unpaid
    } else {
      // F-06 fix: queued winners are senior. NAV = pool − queueDebt = 0, so the exit is refused
      // and the shares are NOT burned; the 100 USDC stays in the pool for the winners.
      expect(rW).to.equal("nav empty");
      expect(got).equal(0n);
      expect(await W.house.pool()).equal(U(100));
    }
  });
});

describe(`F-07 public deployment keys [set=${SET}]`, function () {
  this.timeout(600000);
  const path = require("path");
  const { spawn } = require("child_process");
  const http = require("http");
  const ROOT = path.join(__dirname, "..", "..");

  it("PoC (vulnerable): anyone holding the public mnemonic can quote a 50x ticket and attest it WON", async function () {
    if (isFixed()) return this.skip();   // fixed set: the keys are no longer public; see guard tests below
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p5: attacker } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();

    // The attacker re-derives every privileged key from the phrase printed in scripts/deploy.js
    const quoterKey = hd(21), att1Key = hd(31), att2Key = hd(32);
    console.log(`  [EVIDENCE] quoter  (HD21) = ${quoterKey.address}`);
    console.log(`  [EVIDENCE] attester(HD31) = ${att1Key.address}, attester(HD32) = ${att2Key.address}  (2-of-3 quorum)`);
    console.log(`  [EVIDENCE] derivation phrase = "test test ... test junk" (public ganache/hardhat mnemonic)`);

    const quoterIsOwn = (await W.house.quoterSigner()) === quoterKey.address;
    const id = await buyTicket(W, attacker, 1000, 50);          // same signing path, world uses HD21
    const pool0 = await W.house.pool();
    const sigs = await W.signOutcome(await W.ov.getAddress(), id, 1, [att1Key, att2Key]);
    const b0 = await W.usdc.balanceOf(attacker.address);
    const rc = await revertOf(W.house.connect(attacker).settleWithProof(id, 1, sigs));
    const profit = (await W.usdc.balanceOf(attacker.address)) - b0;
    console.log(`  [EVIDENCE] house.quoterSigner == derived HD21? ${quoterIsOwn}`);
    console.log(`  [EVIDENCE] WON attested with derived attester keys → ${rc ?? "OK"}; attacker received ${Number(profit) / 1e6} USDC from pool (pool before=${pool0})`);
    expect(rc).to.equal(null);
    expect(profit).gt(U(40_000));
  });

  // Run scripts/deploy.js as a child process. The guard must fire before any RPC call.
  // async spawn: the RPC stub lives in THIS process, so the event loop must keep running
  function runDeploy(env, rpc) {
    return new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [path.join(ROOT, "scripts", "deploy.js")], {
        cwd: ROOT, env: { PATH: process.env.PATH, RPC: rpc, ...env } });
      let out = "";
      c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
      const t = setTimeout(() => { c.kill("SIGKILL"); reject(new Error("deploy.js timeout")); }, 60000);
      c.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    });
  }

  it("fixed: deploy.js refuses to run without explicit keys (exit 2, no demo fallback)", async function () {
    if (!isFixed()) return this.skip();
    const r = await runDeploy({}, "http://127.0.0.1:9");        // unreachable RPC: a refusal must not need it
    console.log(`  [EVIDENCE] deploy.js (no keys, no DEMO_KEYS) → exit ${r.code}: ${r.out.trim().split("\n").pop()}`);
    expect(r.code).to.equal(2);
    expect(r.out.includes("deploy refused")).to.equal(true);
    expect(r.out.includes("ECONNREFUSED")).to.equal(false);
  });

  it("fixed: DEMO_KEYS=1 is refused on a non-local chain (public mnemonic never signs on a real network)", async function () {
    if (!isFixed()) return this.skip();
    // minimal JSON-RPC stub that reports chainId 1 (Ethereum mainnet)
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        const result = msg.method === "eth_chainId" ? "0x1" : msg.method === "net_version" ? "1" : null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const rpc = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await runDeploy({ DEMO_KEYS: "1" }, rpc);
      console.log(`  [EVIDENCE] deploy.js (DEMO_KEYS=1, chainId 1) → exit ${r.code}: ${r.out.trim().split("\n").pop()}`);
      expect(r.code).to.equal(2);
      expect(r.out.includes("only allowed on local chains")).to.equal(true);
    } finally { srv.close(); }
  });
});

describe(`F-08 owner-controlled drain via approvals [set=${SET}]`, function () {
  this.timeout(600000);
  it("owner points revenueSink at an EOA: the EOA drains House, including open player stakes", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { owner, lp, p1, p5: rugger } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    await buyTicket(W, p1, 2_000, 2);                           // 2,000 USDC of player stake is OPEN
    const before = await W.usdc.balanceOf(W.hA);
    console.log(`  [EVIDENCE] House holds ${Number(before) / 1e6} USDC (pool 100,000 + open player stake 2,000)`);
    const rSet = await revertOf(W.house.connect(owner).setRevenueSink(rugger.address));
    console.log(`  [EVIDENCE] owner.setRevenueSink(EOA) → ${rSet ?? "OK"}`);
    const eoa0 = await W.usdc.balanceOf(rugger.address);
    const rDrain = await revertOf(W.usdc.connect(rugger).transferFrom(W.hA, rugger.address, before));
    console.log(`  [EVIDENCE] EOA.transferFrom(House → EOA, all) → ${rDrain ?? "OK"}; EOA gained ${Number((await W.usdc.balanceOf(rugger.address)) - eoa0) / 1e6} USDC`);

    // stale approval: rotate the sink away from the attacker — its allowance must be revoked
    const W2 = await makeWorld({ withOptions: false, classCap: U(50_000) });
    await (await W2.house.connect(W2.signers.lp).lpDeposit(U(1000))).wait();
    let rStale = null, staleLeft = 0n;
    if (!isFixed()) {
      // vulnerable: an EOA may become sink, and the approval outlives the rotation
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.signers.p4.address)).wait();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.sA)).wait();   // rotate back to RevenueSplit
      rStale = await revertOf(W2.usdc.connect(W2.signers.p4).transferFrom(W2.hA, W2.signers.p4.address, U(1)));
      console.log(`  [EVIDENCE] previous sink after rotation: transferFrom(House, 1 USDC) → ${rStale ?? "OK (allowance never revoked)"}`);
    } else {
      // fixed: sinks must be contracts; rotation revokes the old sink's allowance
      const oldSink = await deploy("fixed", "RevenueSplit", [await W2.usdc.getAddress(), await W2.diamond.getAddress()], W2.signers.owner);
      const oldAddr = await oldSink.getAddress();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(oldAddr)).wait();
      await (await W2.house.connect(W2.signers.owner).setRevenueSink(W2.sA)).wait();   // rotate back
      staleLeft = await W2.usdc.allowance(W2.hA, oldAddr);
      console.log(`  [EVIDENCE] fixed: allowance House→previous sink after rotation = ${staleLeft}`);
    }

    if (!isFixed()) {
      expect(rDrain).to.equal(null);
      expect(await W.usdc.balanceOf(W.hA)).to.equal(0n);
      expect(rStale).to.equal(null);
    } else {
      expect(rSet).to.equal("sink must be a contract");   // EOA sink refused outright
      expect(rDrain).to.equal("allowance");               // no standing approval to any EOA
      expect(staleLeft).to.equal(0n);                     // rotation revoked the old sink
    }
  });
});
