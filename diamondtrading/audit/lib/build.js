// Audit build: compiles three source sets with solc-js 0.8.26 (same settings as ../compile.js)
//   fixed      → ../contracts/*.sol              (patched production code, this branch)
//   vulnerable → ./vulnerable/contracts/*.sol    (byte-identical snapshot of commit 3cb964b)
//   helpers    → ./helpers/*.sol                 (PoC-only contracts, e.g. blocklisting USDC)
// Output: audit/build/<set>/<Contract>.json  { abi, bytecode, sourceSha256 }
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const solc = require("solc");

const AUDIT = path.join(__dirname, "..");
const SETS = {
  fixed: path.join(AUDIT, "..", "contracts"),
  vulnerable: path.join(AUDIT, "vulnerable", "contracts"),
  helpers: path.join(AUDIT, "helpers"),
};

function compileSet(name, dir) {
  const sources = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sol")).sort()) {
    sources[f] = { content: fs.readFileSync(path.join(dir, f), "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  let failed = false;
  for (const e of out.errors || []) {
    if (e.severity === "error") { failed = true; console.error(e.formattedMessage); }
  }
  if (failed) throw new Error(`compile failed for set ${name}`);

  const outDir = path.join(AUDIT, "build", name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const [file, contracts] of Object.entries(out.contracts || {})) {
    const srcHash = crypto.createHash("sha256").update(sources[file].content).digest("hex");
    for (const [cname, c] of Object.entries(contracts)) {
      if (!c.evm.bytecode.object) continue; // interfaces
      fs.writeFileSync(path.join(outDir, `${cname}.json`), JSON.stringify({
        source: file, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, sourceSha256: srcHash,
      }, null, 2));
      n++;
    }
  }
  console.log(`build[${name}]: ${n} contracts from ${Object.keys(sources).length} files`);
}

if (require.main === module) {
  for (const [name, dir] of Object.entries(SETS)) compileSet(name, dir);
  console.log("audit build: success");
}

module.exports = { SETS };
