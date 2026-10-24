const hre = require("hardhat");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { Quoter } = require("../../engine/quoter.js");

const provider = new ethers.BrowserProvider(hre.network.provider);
const U = (n) => BigInt(n) * 10n ** 6n;
const E18 = (n) => BigInt(n) * 10n ** 18n;
const X = (n) => BigInt(Math.round(n * 1e4));
const PX = (n) => BigInt(Math.round(n * 1e8));
const MNEMONIC = "test test test test test test test test test test test junk";
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "build", `${n}.json`), "utf8"));
const C = (name, signer) => new ethers.ContractFactory(art(name).abi, art(name).bytecode, signer);
// Bypass BrowserProvider's block cache: fuzzing warps and reverts snapshots directly.
const now = async () => Number((await provider.send("eth_getBlockByNumber", ["latest", false])).timestamp);
const warp = async (seconds) => {
  await provider.send("evm_increaseTime", [Math.floor(seconds)]);
  await provider.send("evm_mine", []);
};
const hd = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);

async function makeWorld({ withOptions = true, blocklist = false, classCap = U(250_000), targetPool = 0n, seedDiamond = true } = {}) {
  const accounts = await provider.listAccounts();
  const [owner, lp, relayer, p1, p2, p3, p4, p5, honest, attacker] = accounts;
  const quoter = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);
  const usdc = await (await C(blocklist ? "BlocklistUSDC" : "MockUSDC", owner).deploy()).waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  const diamond = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
  const dist = await (await C("DiamondDistributor", owner).deploy(await diamond.getAddress())).waitForDeployment();
  const house = await (await C("DiamondHouse", owner).deploy(usdcAddr, quoter.address)).waitForDeployment();
  const hA = await house.getAddress();
  const ov = await (await C("MultiAttesterVerifier", owner).deploy([att1.address, att2.address, att3.address], 2, hA)).waitForDeployment();
  await (await house.setOutcomeVerifier(await ov.getAddress())).wait();
  await (await house.setClassCfg(1, 10_000_000, classCap, true)).wait();
  await (await house.setTargetPool(targetPool)).wait();

  let options = null, oA = null, pv = null;
  if (withOptions) {
    options = await (await C("DiamondOptions", owner).deploy(usdcAddr, quoter.address)).waitForDeployment();
    oA = await options.getAddress();
    pv = await (await C("MultiPriceVerifier", owner).deploy([att1.address, att2.address, att3.address], 2, oA)).waitForDeployment();
    await (await options.setPriceVerifier(await pv.getAddress())).wait();
    await (await options.setClassCfg(1, 250_000, classCap, true)).wait();
  }
  const sink = await (await C("RevenueSplit", owner).deploy(usdcAddr, await diamond.getAddress())).waitForDeployment();
  const sA = await sink.getAddress();
  await (await house.setRevenueSink(sA)).wait();
  await (await sink.setHouse(hA)).wait();
  if (options) {
    await (await options.setRevenueSink(sA)).wait();
    await (await sink.setPusher(oA, true)).wait();
  }
  await (await diamond.setTransferAllowlist(sA, true)).wait();

  const users = [owner, lp, relayer, p1, p2, p3, p4, p5, honest, attacker];
  for (const signer of users) {
    await (await usdc.connect(owner).mint(signer.address, U(10_000_000))).wait();
    await (await usdc.connect(signer).approve(hA, ethers.MaxUint256)).wait();
    if (options) await (await usdc.connect(signer).approve(oA, ethers.MaxUint256)).wait();
    if (seedDiamond) {
      if (signer === users[0]) await (await diamond.setMinter(owner.address)).wait();
      await (await diamond.connect(owner).mint(signer.address, E18(1_000_000))).wait();
      await (await diamond.connect(signer).approve(sA, ethers.MaxUint256)).wait();
    }
  }

  const Q = new Quoter(quoter, { houseAddr: hA, optionsAddr: oA, chainId: 31337 });
  const W = { provider, accounts, owner, lp, relayer, p1, p2, p3, p4, p5, honest, attacker,
    quoter, att1, att2, att3, budgeter, usdc, diamond, dist, house, hA, ov, options, oA, pv, sink, sA, Q };
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
  W.quoteHouse = async (who, stake, mult, ttl = 60, salt = ethers.randomBytes(32)) => Q.signTicket({
    classId: 1, dir: 0, stake, multX1e4: X(mult), validUntil: (await now()) + 25, ttl, salt, buyer: who.address,
  });
  W.buyHouse = async (who, stake, mult, ttl = 60) => {
    const { q, sig } = await W.quoteHouse(who, stake, mult, ttl);
    const rc = await (await house.connect(who).buyTicket(q, sig, X(mult), ttl)).wait();
    return rc.logs.find((log) => log.fragment?.name === "Sold").args[0];
  };
  W.settleHouse = async (id, outcome) => (await house.connect(relayer).settleWithProof(
    id, outcome, await W.signOutcome(id, outcome), { gasLimit: 2_000_000 })).wait();
  W.quoteOption = async (who, premium, mult = 3, ttl = 60, dir = 0) => Q.signOption({
    classId: 1, dir, premium, multX1e4: X(mult), bandBps: 50, strikeX1e8: PX(100),
    validUntil: (await now()) + 25, ttl, salt: ethers.randomBytes(32), buyer: who.address,
  });
  W.buyOption = async (who, premium, mult = 3, ttl = 60, dir = 0) => {
    const { q, sig } = await W.quoteOption(who, premium, mult, ttl, dir);
    const rc = await (await options.connect(who).buyOption(q, sig, q.strikeX1e8, ttl)).wait();
    return rc.logs.find((log) => log.fragment?.name === "OSold").args[0];
  };
  W.settleOption = async (id, closePx) => (await options.connect(relayer).settleWithPrice(
    id, closePx, await W.signPrice(id, closePx), { gasLimit: 2_000_000 })).wait();
  return W;
}

module.exports = { hre, ethers, provider, U, E18, X, PX, MNEMONIC, art, C, now, warp, hd, makeWorld };
