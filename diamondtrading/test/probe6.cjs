const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const art = JSON.parse(fs.readFileSync("build/EdgeToken.json"));
const artD = JSON.parse(fs.readFileSync("build/EdgeDistributor.json"));
(async () => {
  const p = new ethers.BrowserProvider(ganache.provider({ chain: { chainId: 31337 }, logging: { quiet: true } }));
  const [o, a, b] = await p.listAccounts();
  const t = await (await new ethers.ContractFactory(art.abi, art.bytecode, o).deploy()).waitForDeployment();
  const d = await (await new ethers.ContractFactory(artD.abi, artD.bytecode, o).deploy(await t.getAddress())).waitForDeployment();
  await (await t.setMinter(await d.getAddress())).wait();
  // give a real balance via owner-as-minter shortcut? minter is distributor; simulate: set minter=o temporarily
  await (await t.setMinter(o.address)).wait();
  await (await t.mint(a.address, 1000n)).wait();
  const ok = (c, n) => console.log(c ? "PASS" : "FAIL", n);
  // case 1: flag=0, no allowlist → must revert "transfers locked"
  try { await (await t.connect(a).transfer(b.address, 1n)).wait(); ok(false, "case1 locked revert"); }
  catch (e) { ok((e?.info?.error?.message||"").includes("transfers locked"), "case1 locked revert"); }
  // case 2: allowlist a → pass
  await (await t.setTransferAllowlist(a.address, true)).wait();
  try { await (await t.connect(a).transfer(b.address, 5n)).wait(); ok((await t.balanceOf(b.address)) === 5n, "case2 allowlisted moves"); }
  catch (e) { ok(false, "case2 allowlisted: " + (e?.info?.error?.message||"").slice(-40)); }
  await (await t.setTransferAllowlist(a.address, false)).wait();
  // case 3: enable → p2p pass
  await (await t.enableTransfers()).wait();
  try { await (await t.connect(a).transfer(b.address, 5n)).wait(); ok((await t.balanceOf(b.address)) === 10n, "case3 open transfer"); }
  catch (e) { ok(false, "case3 open: " + (e?.info?.error?.message||"").slice(-40)); }
  // case 4: one-way (document-only): flag stays 1
  ok((await t.transfersEnabled()) === 1n, "case4 flag stays enabled");
})().catch(e => console.error("FATAL", e.message));
