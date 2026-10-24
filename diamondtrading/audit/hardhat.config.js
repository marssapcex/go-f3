// DiamondTrading audit harness (Hardhat 2 test runner + in-process EVM).
// Contracts are compiled by lib/build.js with solc-js 0.8.26 (viaIR, shanghai) because the
// sandbox cannot download solc binaries; Hardhat provides the chain, time travel and signers.
//   npm run audit:build        → compile fixed / vulnerable / helper sets
//   npm run audit:poc          → PoCs against the VULNERABLE snapshot (bugs must reproduce)
//   npm run audit:regress      → same PoCs against the FIXED code (exploits must be blocked)
require("@nomicfoundation/hardhat-ethers");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { version: "0.8.26" }, // declarative only; compilation is done by lib/build.js
  paths: { root: __dirname, sources: "./.no-sources", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "shanghai",
      allowUnlimitedContractSize: false,
      accounts: { count: 30, accountsBalance: "1000000000000000000000000" },
    },
  },
  mocha: { timeout: 600000 },
};
