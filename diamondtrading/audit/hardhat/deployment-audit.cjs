// Run against the actual scripts/deploy.js deployment on a Hardhat node.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { Quoter } = require("../../engine/quoter.js");

const root = path.join(__dirname, "..", "..");
const rpc = process.env.RPC || "http://127.0.0.1:8545";
const deployment = JSON.parse(fs.readFileSync(path.join(root, "deploy.json"), "utf8"));
const menu = JSON.parse(fs.readFileSync(path.join(root, "config", "menu.json"), "utf8"));
const artifact = JSON.parse(fs.readFileSync(path.join(root, "build", "DiamondHouse.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(rpc);
const house = new ethers.Contract(deployment.contracts.House, artifact.abi, provider);
const U = (n) => BigInt(n) * 10n ** 6n, X = (n) => BigInt(Math.round(n * 1e4));
const hd = (i) => ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`).connect(provider);

(async () => {
  assert(Number((await provider.getNetwork()).chainId) === 31337 && deployment.chainId === 31337);
  const mismatches = [];
  for (const c of menu.classes) {
    const actual = await house.classCfg(c.classId);
    if (!actual.enabled || actual.maxMultX1e4 !== BigInt(c.maxMultX1e4) || actual.profitCap !== BigInt(c.profitCap)) {
      mismatches.push({ classId: c.classId, asset: c.asset });
    }
  }
  assert(mismatches.length === 0, `menu mismatches: ${JSON.stringify(mismatches)}`);
  assert(!(await house.classCfg(7)).enabled, "unknown class 7 must stay disabled");

  const owner = await provider.getSigner(0), quoter = hd(21);
  assert(quoter.address.toLowerCase() === deployment.keys.quoter.toLowerCase());
  const Q = new Quoter(quoter, { houseAddr: deployment.contracts.House, chainId: 31337 });
  const latest = await provider.getBlock("latest");
  const q0 = { classId: 0, dir: 0, stake: U(1_000), multX1e4: X(2), validUntil: latest.timestamp + 29,
    ttl: 60, salt: ethers.randomBytes(32), buyer: await owner.getAddress() };
  const s0 = await Q.signTicket(q0);
  const id = await house.connect(owner).buyTicket.staticCall(q0, s0.sig, X(2), 60);
  assert(id === 0n, "menu BTC class 0 must be buyable");

  const q1 = { ...q0, classId: 1, multX1e4: X(101), salt: ethers.randomBytes(32) };
  const s1 = await Q.signTicket(q1);
  let capError = null;
  try { await house.connect(owner).buyTicket.staticCall(q1, s1.sig, X(101), 60); }
  catch (e) { capError = e.reason || e.shortMessage || e.message; }
  assert(capError && capError.includes("profit over class cap"), `unexpected over-cap result: ${capError}`);

  const result = { rpc, chainId: 31337, deploymentHouse: deployment.contracts.House,
    menuClassesChecked: menu.classes.length, mismatches, class7Enabled: false,
    proof: { btcClass0StaticBuyId: id, ethOverCapError: capError, menuEthCap: BigInt(menu.classes[1].profitCap) } };
  const out = path.join(__dirname, "results", "deployment.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
  console.log(`PASS ${menu.classes.length}/${menu.classes.length} deployed classes match menu.json`);
  console.log("PASS BTC class 0 buys; class 1 rejects 100,000-USDC profit above the 25,000-USDC menu cap");
})().catch((e) => { console.error(e); process.exit(1); });
