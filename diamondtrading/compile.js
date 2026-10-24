// Compile runner: solc-js standard-json over production contracts and test-only helpers.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sources = {};
for (const dir of [path.join(__dirname, "contracts"), path.join(__dirname, "test", "helpers")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sol"))) {
    sources[f] = { content: fs.readFileSync(path.join(dir, f), "utf8") };
  }
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
if (out.errors) {
  for (const e of out.errors) {
    console.error(`${e.severity.toUpperCase()}: ${e.formattedMessage}`);
    if (e.severity === "error") failed = true;
  }
}
if (failed) process.exit(1);

fs.mkdirSync(path.join(__dirname, "build"), { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    console.log(`OK ${file}:${name}  bytecode=${c.evm.bytecode.object.length / 2} bytes`);
    fs.writeFileSync(
      path.join(__dirname, "build", `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: c.evm.bytecode.object }, null, 2)
    );
  }
}
console.log("compile: success");
