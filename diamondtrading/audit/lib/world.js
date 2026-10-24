// Shared PoC fixture: deploys the full DiamondTrading stack on the Hardhat in-process network
// from the artifacts produced by audit/lib/build.js.
//   AUDIT_SET=vulnerable  → original code (3cb964b) — PoCs must SUCCEED (bug reproduced)
//   AUDIT_SET=fixed       → patched code (this branch) — the same attacks must FAIL
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const BUILD = path.join(__dirname, "..", "build");
const SET = process.env.AUDIT_SET || "fixed";
const isFixed = () => SET === "fixed";

const U = (n) => BigInt(n) * 10n ** 6n;          // USDC 6dp
const E18 = (n) => BigInt(n) * 10n ** 18n;       // DIAMOND 18dp
const X = (n) => BigInt(Math.round(n * 1e4));    // multiplier ×1e4
const PRICE = 1_000_000n;                        // $0.01 per DIAMOND (×1e8)

// Deterministic keys derived from the PUBLIC ganache/hardhat mnemonic — the very same
// derivation scripts/deploy.js uses for quoter / attesters / budgeter.
const MNEMONIC = "test test test test test test test test test test test junk";
const hd = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);

function artifact(set, name) {
  return JSON.parse(fs.readFileSync(path.join(BUILD, set, `${name}.json`), "utf8"));
}
async function deploy(set, name, args = [], signer) {
  const a = artifact(set, name);
  const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}
async function timeTravel(secs) {
  await ethers.provider.send("evm_increaseTime", [secs]);
  await ethers.provider.send("evm_mine", []);
}
async function fund(addr, eth = "1000") {
  await ethers.provider.send("hardhat_setBalance", [addr, "0x" + (BigInt(eth) * 10n ** 18n).toString(16)]);
}
async function now() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}
// Returns the revert reason string (or the raw message) for a failing promise, else null.
async function revertOf(p) {
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); return null; }
  catch (e) {
    const m = [e?.shortMessage, e?.reason, e?.message, e?.info?.error?.message, e?.data].filter(Boolean).join(" | ");
    const r = m.match(/reverted with reason string '([^']+)'/) || m.match(/revert(?:ed)? (?:with reason string )?"?([^"'|]+)"?/i);
    return r ? r[1].trim() : (m.slice(0, 160) || "reverted");
  }
}

/**
 * Full world. Owner = signer[0] (deployer, EOA, as in production scripts).
 * Roles: quoter=HD21, attesters=HD31..33 (2-of-3), budgeter=HD41, LP=signer[1], players=signer[2..].
 */
async function makeWorld({ withOptions = true, withDistributor = true, classCap = U(5_000), usdcName = "MockUSDC" } = {}) {
  const signers = await ethers.getSigners();
  const [owner, lp, relayer, p1, p2, p3, p4, p5] = signers;
  const quoter = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);
  for (const w of [quoter, att1, att2, att3, budgeter]) await fund(w.address);

  const usdc = usdcName === "MockUSDC" ? await deploy(SET, "MockUSDC", [], owner) : await deploy("helpers", usdcName, [], owner);
  const usdcA = await usdc.getAddress();
  const diamond = await deploy(SET, "DiamondToken", [], owner);
  const dist = withDistributor ? await deploy(SET, "DiamondDistributor", [await diamond.getAddress()], owner) : null;
  const house = await deploy(SET, "DiamondHouse", [usdcA, quoter.address], owner);
  const hA = await house.getAddress();
  const ov = await deploy(SET, "MultiAttesterVerifier", [[att1.address, att2.address, att3.address], 2, hA], owner);
  await (await house.setOutcomeVerifier(await ov.getAddress())).wait();
  await (await house.setClassCfg(1, 10_000_000, classCap, true)).wait();

  let options = null, pv = null, oA = null;
  if (withOptions) {
    options = await deploy(SET, "DiamondOptions", [usdcA, quoter.address], owner);
    oA = await options.getAddress();
    pv = await deploy(SET, "MultiPriceVerifier", [[att1.address, att2.address, att3.address], 2, oA], owner);
    await (await options.setPriceVerifier(await pv.getAddress())).wait();
    await (await options.setClassCfg(1, 250_000, classCap, true)).wait();
  }

  const sink = await deploy(SET, "RevenueSplit", [usdcA, await diamond.getAddress()], owner);
  const sA = await sink.getAddress();
  await (await house.setRevenueSink(sA)).wait();
  await (await sink.setHouse(hA)).wait();
  if (options) {
    await (await options.setRevenueSink(sA)).wait();
    await (await sink.setPusher(oA, true)).wait();
  }
  await (await diamond.setTransferAllowlist(sA, true)).wait();

  // players + LP funded and approved
  for (const s of [lp, relayer, p1, p2, p3, p4, p5]) {
    await (await usdc.connect(owner).mint(s.address, U(1_000_000))).wait();
    await (await usdc.connect(s).approve(hA, ethers.MaxUint256)).wait();
    if (options) await (await usdc.connect(s).approve(oA, ethers.MaxUint256)).wait();
  }

  const att = (w, addr, kind) => ({ w, addr, kind });
  return {
    signers: { owner, lp, relayer, p1, p2, p3, p4, p5 },
    keys: { quoter, att1, att2, att3, budgeter },
    usdc, diamond, dist, house, hA, ov, options, oA, pv, sink, sA,
    quoterFor: (addr) => ({ addr }),
    attesterSigners: [att1, att2],
    async signOutcome(verifierAddr, ticketId, outcome, signers2 = [att1, att2]) {
      const domain = { name: "DiamondOutcome", version: "1", chainId: 31337, verifyingContract: verifierAddr };
      const types = { Outcome: [{ name: "ticketId", type: "uint256" }, { name: "outcome", type: "uint8" }, { name: "house", type: "address" }] };
      const value = { ticketId, outcome, house: hA };
      const out = [];
      for (const w of signers2) out.push(await w.signTypedData(domain, types, value));
      return out;
    },
    async signPrice(verifierAddr, optionId, closePx, signers2 = [att1, att2]) {
      const domain = { name: "DiamondPrice", version: "1", chainId: 31337, verifyingContract: verifierAddr };
      const types = { OptPrice: [{ name: "optionId", type: "uint256" }, { name: "closePx", type: "uint64" }, { name: "house", type: "address" }] };
      const value = { optionId, closePx, house: oA };
      const out = [];
      for (const w of signers2) out.push(await w.signTypedData(domain, types, value));
      return out;
    },
  };
}

// Quote helper: signs a DiamondHouse quote with the quoter key. Vulnerable typehash has no ttl;
// the fixed typehash binds ttl (F-09). Mirrors engine/quoter.js (HOUSE_TYPES) for each set.
async function signHouseQuote(W, q, buyer, ttl = 60) {
  const domain = { name: "DiamondHouse", version: "1", chainId: 31337, verifyingContract: W.hA };
  const fields = [
    { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" }, { name: "stake", type: "uint128" },
    { name: "multX1e4", type: "uint32" }, { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
    { name: "buyer", type: "address" } ];
  const value = { classId: q.classId ?? 1, dir: q.dir ?? 0, stake: q.stake, multX1e4: q.multX1e4,
    validUntil: q.validUntil ?? (await now()) + 25, salt: q.salt ?? ethers.randomBytes(32), buyer: buyer.address };
  if (isFixed()) { fields.push({ name: "ttl", type: "uint64" }); value.ttl = q.ttl ?? ttl; }
  const sig = await W.keys.quoter.signTypedData(domain, { Quote: fields }, value);
  return { q: value, sig };
}
async function signOptionQuote(W, q, buyer) {
  const domain = { name: "DiamondOptions", version: "1", chainId: 31337, verifyingContract: W.oA };
  const base = [
    { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" }, { name: "premium", type: "uint128" },
    { name: "multX1e4", type: "uint32" }, { name: "bandBps", type: "uint32" }, { name: "strikeX1e8", type: "uint64" },
    { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" }, { name: "buyer", type: "address" } ];
  // fixed set: ttl is a signed field (F-09). Default 60s, matching buyOption(..., 60).
  const types = { OQuote: isFixed() ? [...base, { name: "ttl", type: "uint64" }] : base };
  const value = { classId: q.classId ?? 1, dir: q.dir ?? 0, premium: q.premium, multX1e4: q.multX1e4,
    bandBps: q.bandBps ?? 500, strikeX1e8: q.strikeX1e8 ?? 8_475_000_000_000n / 100n, validUntil: q.validUntil ?? (await now()) + 25,
    salt: q.salt ?? ethers.randomBytes(32), buyer: buyer.address };
  if (isFixed()) value.ttl = q.ttl ?? 60;
  const sig = await W.keys.quoter.signTypedData(domain, types, value);
  return { q: value, sig };
}

// Ticket helpers
async function buyTicket(W, buyer, stake, mult, ttl = 60) {
  const { q, sig } = await signHouseQuote(W, { stake: U(stake), multX1e4: X(mult) }, buyer, ttl);
  const rc = await (await W.house.connect(buyer).buyTicket(q, sig, X(mult), ttl)).wait();
  const ev = rc.logs.map((l) => { try { return W.house.interface.parseLog(l); } catch (_) { return null; } })
    .find((e) => e && e.name === "Sold");
  return ev.args[0];
}
async function settleHouse(W, id, outcome, who = W.signers.relayer, sigs = null) {
  const s = sigs ?? (await W.signOutcome(W.ov.target ?? (await W.ov.getAddress()), id, outcome));
  return W.house.connect(who).settleWithProof(id, outcome, s);
}

module.exports = {
  SET, isFixed, U, E18, X, PRICE, hd, MNEMONIC, artifact, deploy, timeTravel, fund, now,
  revertOf, makeWorld, signHouseQuote, signOptionQuote, buyTicket, settleHouse,
};
