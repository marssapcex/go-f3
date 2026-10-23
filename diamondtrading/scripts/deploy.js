// Demo deployment for user testing: realistic menu + seeded state on local ganache.
// Run: node scripts/deploy.js  (expects an EVM RPC at $RPC or http://127.0.0.1:8545)
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));
const U = (n) => BigInt(n) * 10n ** 6n;

(async () => {
  const rpc = process.env.RPC || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  const accs = await provider.listAccounts();
  const owner = await provider.getSigner(accs[0].address);
  const hd = (i) => ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`)
    .connect(provider);
  const quoter = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);

  const C = (n, s) => new ethers.ContractFactory(art(n).abi, art(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const diamond = await (await C("DiamondToken", owner).deploy()).waitForDeployment();
  const dist = await (await C("DiamondDistributor", owner).deploy(await diamond.getAddress())).waitForDeployment();
  const house = await (await C("DiamondHouse", owner).deploy(await usdc.getAddress(), quoter.address)).waitForDeployment();
  const options = await (await C("DiamondOptions", owner).deploy(await usdc.getAddress(), quoter.address)).waitForDeployment();

  const hAddr = await house.getAddress();
  const oAddr = await options.getAddress();
  await (await diamond.setMinter(await dist.getAddress())).wait();
  await (await dist.setBudgetAttester(budgeter.address)).wait();

  const ov = await (await C("MultiAttesterVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, hAddr)).waitForDeployment();
  await (await house.setOutcomeVerifier(await ov.getAddress())).wait();
  const pv = await (await C("MultiPriceVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, oAddr)).waitForDeployment();
  await (await options.setPriceVerifier(await pv.getAddress())).wait();

  const sink = await (await C("RevenueSplit", owner).deploy(await usdc.getAddress(), await diamond.getAddress())).waitForDeployment();
  await (await house.setRevenueSink(await sink.getAddress())).wait();
  await (await sink.setHouse(hAddr)).wait();

  // menu: 1 BTC 1000x, 2 ETH 1000x, 3 SOL 500x, 4 HYPE 500x, 5 BNB 200x, 6 SP500 100x, 7 XYZ100 100x
  const menu = [
    [1, 10_000_000, U(250_000)], [2, 10_000_000, U(250_000)], [3, 5_000_000, U(100_000)],
    [4, 5_000_000, U(50_000)],   [5, 2_000_000, U(50_000)],   [6, 1_000_000, U(25_000)], [7, 1_000_000, U(25_000)],
  ];
  for (const [cid, mult, cap] of menu) {
    await (await house.setClassCfg(cid, mult, cap, true)).wait();
    await (await options.connect(owner).setClassCfg(cid, Math.min(mult, 250_000), cap, true)).wait();
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
      RevenueSplit: await sink.getAddress(),
    },
    keys: { quoter: quoter.address, attesters: [att1.address, att2.address, att3.address], budgeter: budgeter.address },
    note: "demo only — ganache deterministic mnemonic, DO NOT send real funds",
  };
  fs.writeFileSync(path.join(__dirname, "..", "deploy.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
