// F-09 — Duration arbitrage: the quote is priced for τ = 60 s (engine/pricer.js:
//        offerMultiplier(L, σ, τ=60)), but the BUYER chooses ttl ∈ {30,60,120,300} at purchase
//        time and ttl is NOT part of the signed Quote (QUOTE_TYPEHASH). A buyer receives one
//        quote and can purchase the same multiplier with the shortest ttl (more likely to survive)
//        → positive expected value at the house's expense.
// F-10 — Quote replay: a signed quote is never consumed (no nonce / salt registry). The same
//        quote can be bought N times within its 30 s validity. Each ticket is individually
//        capped, but the aggregate exposure to a stale price is unbounded in count.
const { expect } = require("../lib/expect");
const W_ = require("../lib/world");
const { makeWorld, buyTicket, signHouseQuote, revertOf, U, X, SET, isFixed } = W_;

describe(`F-09 ttl is unsigned (duration arbitrage) [set=${SET}]`, function () {
  this.timeout(600000);

  it("the same quote is accepted with ttl=30 and ttl=300 (vulnerable) — expiry is buyer's choice", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p1 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const { q, sig } = await signHouseQuote(W, { stake: U(100), multX1e4: X(3) }, p1, 60);
    const rShort = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 30));
    const rLong = await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 300));
    const exp = async (id) => (await W.house.tickets(id)).expiry;
    const n = Number(await countTickets(W));
    console.log(`  [EVIDENCE] same signed quote: buy(ttl=30) → ${rShort ?? "OK"}, buy(ttl=300) → ${rLong ?? "OK"}`);
    if (!isFixed()) {
      expect(rShort).to.equal(null);
      expect(rLong).to.equal(null);
      const e1 = await exp(n - 2), e2 = await exp(n - 1);
      console.log(`  [EVIDENCE] resulting tickets ${n - 2},${n - 1} expiry delta = ${Number(e2 - e1)} s for an identical quote`);
      expect(e2 - e1 >= 270n && e2 - e1 <= 275n).to.equal(true); // 270 s + block-time jitter
    } else {
      // quote was signed with ttl=60: any other ttl is rejected, honest buyer uses 60
      expect(rShort).to.equal("ttl mismatch");
      expect(rLong).to.equal("ttl mismatch");
      expect(await revertOf(W.house.connect(p1).buyTicket(q, sig, X(3), 60))).to.equal(null);
    }
  });

  it("economic impact at τ=60 pricing (engine/pricer.js, same σ fallback as engine/index.js)", async () => {
    const { bustProb, offerMultiplier } = require("../../engine/pricer.js");
    const L = 1000, rho = 0.0399;
    const rows = [];
    for (const sigma of [0.0002, 0.0004, 0.0008]) {
      const { mOffer } = offerMultiplier(L, sigma, 60, rho);       // price quoted to the buyer
      for (const tau of [30, 60, 120, 300]) {
        const pWin = 1 - bustProb(L, sigma, tau);                  // survive τ with the real ttl
        const ev = pWin * mOffer - 1;                              // buyer expected value / stake
        rows.push({ sigma, tau, mOffer: mOffer.toFixed(3), pWin: pWin.toFixed(3), ev: (ev * 100).toFixed(1) + "%" });
      }
    }
    console.log("  [EVIDENCE] buyer EV per unit stake when quote = τ60 price and ttl is chosen by buyer:");
    console.log("  σ/s      ttl   M_offer   P(win)   buyerEV");
    for (const r of rows) console.log(`  ${String(r.sigma).padEnd(8)} ${String(r.tau).padEnd(5)} ${r.mOffer.padEnd(9)} ${r.pWin.padEnd(8)} ${r.ev}`);
    const evShort = rows.find((r) => r.sigma === 0.0004 && r.tau === 30);
    const evFair = rows.find((r) => r.sigma === 0.0004 && r.tau === 60);
    console.log(`  [EVIDENCE] at σ=0.0004: ttl=60 → EV ${evFair.ev}; ttl=30 → EV ${evShort.ev} (house pays the difference)`);
    expect(parseFloat(evShort.ev)).gt(parseFloat(evFair.ev));
  });
});

describe(`F-10 quote replay [set=${SET}]`, function () {
  this.timeout(600000);
  it("one signed quote buys N tickets inside its validity window", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { lp, p2 } = W.signers;
    await (await W.house.connect(lp).lpDeposit(U(100_000))).wait();
    const { q, sig } = await signHouseQuote(W, { stake: U(10), multX1e4: X(2) }, p2, 60);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await revertOf(W.house.connect(p2).buyTicket(q, sig, X(2), 60)));
    console.log(`  [EVIDENCE] 5 purchases with one quote → ${results.map((r) => r ?? "OK").join(", ")}`);
    const accepted = results.filter((r) => r === null).length;
    console.log(`  [EVIDENCE] accepted ${accepted}/5 tickets (aggregate exposure 5 × 10 stake at one stale price)`);
    if (!isFixed()) expect(accepted).to.equal(5);
    else expect(accepted).to.equal(1);
  });
});

async function countTickets(W) {
  let n = 0;
  for (;;) { try { await W.house.tickets(n); n++; } catch (_) { break; } }
  return n;
}
