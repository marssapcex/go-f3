const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const art = JSON.parse(fs.readFileSync("build/EdgeToken.json"));
(async () => {
  const p = new ethers.BrowserProvider(ganache.provider({ chain: { chainId: 31337 }, logging: { quiet: true } }));
  const [o, a, b] = await p.listAccounts();
  const t = await (await new ethers.ContractFactory(art.abi, art.bytecode, o).deploy()).waitForDeployment();
  await (await t.enableTransfers()).wait();
  console.log("flag:", await t.transfersEnabled(), "allow a:", await t.transferAllowlist(a.address));
  // 1) staticcall (eth_call) as a
  try { const r = await t.transfer.staticCall(b.address, 1n, { from: a.address }); console.log("staticcall:", r); }
  catch (e) { console.log("staticcall REVERTED:", (e?.info?.error?.message || e.message).slice(-55)); }
  // 2) raw eth_sendTransaction with manual calldata (no estimate layer)
  const data = t.interface.encodeFunctionData("transfer", [b.address, 1n]);
  try {
    const txh = await p.send("eth_sendTransaction", [{ from: a.address, to: await t.getAddress(), data }]);
    console.log("raw tx hash:", txh);
    const rcpt = await p.send("eth_getTransactionReceipt", [txh]);
    console.log("raw tx status:", rcpt.status);
  } catch (e) { console.log("raw REVERTED:", (e?.error?.message || e.message).slice(-55)); }
})().catch(e => console.error("FATAL", e.message));
