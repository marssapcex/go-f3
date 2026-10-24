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
    const row = { classId: c.classId, asset: c.asset, expected: { enabled: true,
      maxMultX1e4: BigInt(c.maxMultX1e4), profitCap: BigInt(c.profitCap) },
      actual: { enabled: actual.enabled, maxMultX1e4: actual.maxMultX1e4, profitCap: actual.profitCap } };
    if (!actual.enabled || actual.maxMultX1e4 !== BigInt(c.maxMultX1e4) || actual.profitCap !== BigInt(c.profitCap)) mismatches.push(row);
  }
  const class7 = await house.classCfg(7);
  const owner = await provider.getSigner(0), quoter = hd(21);
  assert(quoter.address.toLowerCase() === deployment.keys.quoter.toLowerCase());
  const Q = new Quoter(quoter, { houseAddr: deployment.contracts.House, chainId: 31337 });
  const latest = await provider.getBlock("latest");

  // menu.json says class 0 is BTC. The deployed class table leaves it disabled.
  const q0 = { classId: 0, dir: 0, stake: U(1_000), multX1e4: X(2), validUntil: latest.timestamp + 29,
    ttl: 60, salt: ethers.randomBytes(32), buyer: await owner.getAddress() };
  const s0 = await Q.signTicket(q0);
  let class0Error = null;
  try { await house.connect(owner).buyTicket.staticCall(q0, s0.sig, X(2), 60); } catch (e) { class0Error = e.reason || e.shortMessage || e.message; }
  assert(class0Error && class0Error.includes("class disabled"), `unexpected class-0 result: ${class0Error}`);

  // menu.json says class 1 is ETH with a 25k profit cap. deploy.js instead gives it a
  // 250k cap, so a 100k-profit ticket that the menu would reject is accepted on-chain.
  const targetTimestamp = (await provider.getBlock("latest")).timestamp + 100;
  await provider.send("evm_setNextBlockTimestamp", [targetTimestamp]);
  const q1 = { ...q0, classId: 1, multX1e4: X(101), validUntil: targetTimestamp, salt: ethers.randomBytes(32) };
  const s1 = await Q.signTicket(q1);
  const rc = await (await house.connect(owner).buyTicket(q1, s1.sig, X(101), 60)).wait();
  const sold = rc.logs.find((l) => l.fragment?.name === "Sold");
  const id = sold.args[0], ticket = await house.tickets(id);
  const profit = (ticket.multX1e4 - 10_000n) * ticket.stake / 10_000n;
  assert(profit === U(100_000) && profit > BigInt(menu.classes[1].profitCap));

  const result = { rpc, chainId: 31337, deploymentHouse: deployment.contracts.House,
    menuClassesChecked: menu.classes.length, mismatches,
    unexpectedClass7: { enabled: class7.enabled, maxMultX1e4: class7.maxMultX1e4, profitCap: class7.profitCap },
    proof: { menuBtcClass0Error: class0Error, acceptedTicketId: id, acceptedClassId: ticket.classId,
      acceptedProfit: profit, menuEthCap: BigInt(menu.classes[1].profitCap) } };
  const out = path.join(__dirname, "results", "deployment.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
  console.log(`PASS actual deployment executed; ${mismatches.length}/${menu.classes.length} menu class IDs differ on-chain`);
  console.log(`PASS menu BTC class 0 rejected: ${class0Error}`);
  console.log(`PASS class 1 accepted ${ethers.formatUnits(profit, 6)} USDC profit > menu ETH cap ${ethers.formatUnits(menu.classes[1].profitCap, 6)}`);
  console.log(`results=${path.relative(root, out)}`);
})().catch((e) => { console.error(e); process.exit(1); });
