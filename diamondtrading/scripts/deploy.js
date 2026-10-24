// Demo deployment for user testing: realistic menu + seeded state on local ganache.
// Run (demo, local chain only):  DEMO_KEYS=1 node scripts/deploy.js
// Run (any other chain):         QUOTER_KEY, ATTESTER_KEY_1..3, BUDGETER_KEY must be set (env only)
// Expects an EVM RPC at $RPC or http://127.0.0.1:8545.
//
// F-07 fix: the signing roles are derived from a PUBLIC mnemonic ("test test ... junk").
// Anyone can derive those keys, so they are only ever used when DEMO_KEYS=1 AND the chain is a
// local dev chain. Otherwise the script refuses to run (exit code 2) and never falls back to
// demo keys.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const DEMO_MNEMONIC = "test test test test test test test test test test test junk";
const LOCAL_CHAIN_IDS = new Set([31337, 1337]);   // hardhat/anvil, ganache
const ENV_KEYS = ["QUOTER_KEY", "ATTESTER_KEY_1", "ATTESTER_KEY_2", "ATTESTER_KEY_3", "BUDGETER_KEY"];

function refuse(msg) {
  console.error("deploy refused: " + msg);
  process.exit(2);
}

/** Resolve the signing roles or refuse. Returns { quoter, att1, att2, att3, budgeter } wallets (unconnected). */
function resolveKeys(chainId) {
  if (process.env.DEMO_KEYS === "1") {               // chainId===null ⇒ caller will re-check on-chain
    if (chainId === null || !LOCAL_CHAIN_IDS.has(chainId)) refuse(`DEMO_KEYS=1 is only allowed on local chains (got chainId ${chainId})`);
    const hd = (i) => ethers.HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    return { quoter: hd(21), att1: hd(31), att2: hd(32), att3: hd(33), budgeter: hd(41), demo: true };
  }
  const missing = ENV_KEYS.filter((k) => !process.env[k]);
  if (missing.length) refuse(`no signing keys (missing env: ${missing.join(", ")}); set them or use DEMO_KEYS=1 on a local chain`);
  const w = (k) => new ethers.Wallet(process.env[k]);
  return { quoter: w("QUOTER_KEY"), att1: w("ATTESTER_KEY_1"), att2: w("ATTESTER_KEY_2"),
           att3: w("ATTESTER_KEY_3"), budgeter: w("BUDGETER_KEY"), demo: false };
}

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));
const U = (n) => BigInt(n) * 10n ** 6n;
const E18 = (n) => BigInt(n) * 10n ** 18n;

(async () => {
  // F-07: refuse BEFORE touching the network when no explicit keys and no demo opt-in exist.
  if (process.env.DEMO_KEYS !== "1") resolveKeys(null);   // env path: missing keys → exit 2
  const rpc = process.env.RPC || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  const keys = resolveKeys(chainId);                 // F-07: guard runs before anything is deployed
  const accs = await provider.listAccounts();
  const owner = await provider.getSigner(accs[0].address);
  const conn = (w) => w.connect(provider);
  const quoter = conn(keys.quoter), att1 = conn(keys.att1), att2 = conn(keys.att2), att3 = conn(keys.att3), budgeter = conn(keys.budgeter);
  if (keys.demo) console.warn("WARNING: DEMO_KEYS=1 — public test mnemonic signing keys on local chain " + chainId);

  const C = (n, s) => new ethers.ContractFactory(art(n).abi, art(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const diamond = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
  const dist = await (await C("DiamondDistributor", owner).deploy(await diamond.getAddress())).waitForDeployment();
  const house = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoter.address)).waitForDeployment();
  const options = await (await C("DiamondOptions", owner).deploy(await usdc.getAddress(), quoter.address)).waitForDeployment();

  const hAddr = await house.getAddress();
  const oAddr = await options.getAddress();
  // Demo-only genesis allocation so the staker fee lane can be exercised immediately.
  // The owner minter role is removed again before deployment finishes.
  await (await diamond.setMinter(owner.address)).wait();
  await (await diamond.mint(owner.address, E18(100_000))).wait();
  await (await diamond.setMinter(await dist.getAddress())).wait();
  await (await dist.setBudgetAttester(budgeter.address)).wait();

  const ov = await (await C("MultiAttesterVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, hAddr)).waitForDeployment();
  await (await house.setOutcomeVerifier(await ov.getAddress())).wait();
  const pv = await (await C("MultiPriceVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, oAddr)).waitForDeployment();
  await (await options.setPriceVerifier(await pv.getAddress())).wait();

  const sink = await (await C("RevenueSplit", owner).deploy(await usdc.getAddress(), await diamond.getAddress())).waitForDeployment();
  const sinkAddr = await sink.getAddress();
  await (await house.setRevenueSink(sinkAddr)).wait();
  await (await options.setRevenueSink(sinkAddr)).wait();
  await (await sink.setHouse(hAddr)).wait();
  await (await sink.setPusher(oAddr, true)).wait();
  await (await diamond.setTransferAllowlist(sinkAddr, true)).wait();
  await (await diamond.connect(owner).approve(sinkAddr, ethers.MaxUint256)).wait();
  await (await sink.connect(owner).stake(E18(10_000))).wait();
  // founderWallet deliberately remains address(0) on both engines; owner sets it later.

  // The checked-in menu is the only class-ID/cap source. Never maintain a second mapping here.
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "menu.json"), "utf8")).classes;
  const seenClasses = new Set();
  for (const c of menu) {
    const cid = c.classId, mult = c.maxMultX1e4, cap = BigInt(c.profitCap);
    if (!Number.isInteger(cid) || cid < 0 || cid > 255 || seenClasses.has(cid) ||
        !Number.isInteger(mult) || mult < 10_500 || mult > 10_000_000) {
      throw new Error(`invalid or duplicate menu class ${cid}`);
    }
    seenClasses.add(cid);
    await (await house.setClassCfg(cid, mult, cap, true)).wait();
    await (await options.connect(owner).setClassCfg(cid, Math.min(mult, 250_000), cap, true)).wait();
    const hc = await house.classCfg(cid), oc = await options.classCfg(cid);
    if (!hc.enabled || hc.maxMultX1e4 !== BigInt(mult) || hc.profitCap !== cap ||
        !oc.enabled || oc.maxMultX1e4 !== BigInt(Math.min(mult, 250_000)) || oc.payCap !== cap) {
      throw new Error(`deployed class ${cid} does not match config/menu.json`);
    }
  }

  // seed: fund 10 demo accounts with USDC + approvals, seed LP 100k so pool is playable
  for (const a of accs.slice(0, 10).map((x) => x.address)) {
    const signer = await provider.getSigner(a);
    await (await usdc.connect(owner).mint(a, U(1_000_000))).wait();
    await (await usdc.connect(signer).approve(hAddr, ethers.MaxUint256)).wait();
    await (await usdc.connect(signer).approve(oAddr, ethers.MaxUint256)).wait();
  }
  await (await house.connect(owner).lpDeposit(U(100_000))).wait();

  const out = {
    chainId, rpc,
    contracts: {
      USDC: await usdc.getAddress(), DIAMOND: await diamond.getAddress(),
      Distributor: await dist.getAddress(), House: hAddr, Options: oAddr,
      OutcomeVerifier: await ov.getAddress(), PriceVerifier: await pv.getAddress(),
      RevenueSplit: sinkAddr,
    },
    fee: {
      totalBps: 399, founderBps: 99, stakerBps: 300,
      founderWallet: ethers.ZeroAddress,
      note: "0.99% founder / 3.00% stakers; founder unset folds into active stakers",
    },
    demoStaking: { mintedToOwner: "100000 DIAMOND", stakedByOwner: "10000 DIAMOND" },
    keys: { quoter: quoter.address, attesters: [att1.address, att2.address, att3.address], budgeter: budgeter.address },
    note: keys.demo ? "demo only — public deterministic mnemonic, local chain, DO NOT send real funds" : "signing keys supplied via env",
  };
  fs.writeFileSync(path.join(__dirname, "..", "deploy.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
