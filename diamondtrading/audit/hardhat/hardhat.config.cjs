const os = require("os");
const path = require("path");

// The audit executes the exact solc-0.8.26 artifacts produced by ../../compile.js.
// No compiler download, Hardhat artifacts, or cache is written into the repository.
module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "shanghai",
      initialDate: "2026-01-01T00:00:00.000Z",
      blockGasLimit: 100_000_000,
      allowBlocksWithSameTimestamp: true,
      loggingEnabled: false,
    },
  },
  paths: {
    sources: "../../contracts",
    tests: ".",
    artifacts: path.join(os.tmpdir(), "diamondtrading-hardhat-artifacts"),
    cache: path.join(os.tmpdir(), "diamondtrading-hardhat-cache"),
  },
};
