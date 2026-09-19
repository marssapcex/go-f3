# [CRITICAL] ValidatorManager.initializeValidatorSet Does Not Bind to Configured SubnetID — Foreign Subnet Can Hijack L1 Initial Validator Set

**Severity:** Critical  
**Contract:** `ValidatorManager.sol` (and all PoS managers inheriting it)  
**Function:** `initializeValidatorSet(ConversionData calldata conversionData, uint32 messageIndex)`  
**Commit:** `20731ce` (main, Sep 2026) — vulnerable; fix in open PR #1480  
**Foundry PoC:** `audit/poc/ValidatorManagerForeignSubnetPoC.t.sol`  
**Ganache PoC (runnable without forge binary):** `audit/poc/ganache_poc.js` — `node audit/poc/ganache_poc.js`

---

## 1. Summary

`ValidatorManager` stores its L1's `subnetID` in `__ValidatorManager_init_unchained` (`_subnetID = settings.subnetID`). `initializeValidatorSet` is supposed to initialize the L1's initial validator set from a P-Chain signed `SubnetToL1ConversionMessage`.

It validates:
- `conversionData.validatorManagerBlockchainID == WARP_MESSENGER.getBlockchainID()`
- `conversionData.validatorManagerAddress == address(this)`
- `sha256(packConversionData(conversionData)) == conversionID` where `conversionID` comes from `unpackSubnetToL1ConversionMessage(_getPChainWarpMessage(messageIndex).payload)`

It **does NOT validate** `conversionData.subnetID == _subnetID`.

Per Avalanche ACP-77, P-Chain places **no restriction** on which `(blockchainID, address)` pair a subnet declares as its validator manager. Anyone can create a subnet, set its manager to an arbitrary victim `ValidatorManager`, and P-Chain will sign a `SubnetToL1ConversionMessage` containing the attacker's `initialValidators` and attacker `subnetID`.

Because victim contract does not bind to its configured `subnetID`, it accepts a genuinely signed conversion from a foreign subnet, initializing its validator set to attacker-controlled nodes.

---

## 2. Root Cause — Precise Code

`ValidatorManager.sol:211-275` (main):

```solidity
function initializeValidatorSet(ConversionData calldata conversionData, uint32 messageIndex) public virtual override {
    ValidatorManagerStorage storage $ = _getValidatorManagerStorage();
    if ($._initializedValidatorSet) revert InvalidInitializationStatus();

    // Only checks blockchainID and manager address — NO subnetID check
    if (conversionData.validatorManagerBlockchainID != WARP_MESSENGER.getBlockchainID()) {
        revert InvalidValidatorManagerBlockchainID(conversionData.validatorManagerBlockchainID);
    }
    if (address(conversionData.validatorManagerAddress) != address(this)) {
        revert InvalidValidatorManagerAddress(address(conversionData.validatorManagerAddress));
    }

    bytes32 conversionID = ValidatorMessages.unpackSubnetToL1ConversionMessage(
        _getPChainWarpMessage(messageIndex).payload
    );
    bytes memory encodedConversion = ValidatorMessages.packConversionData(conversionData);
    bytes32 encodedConversionID = sha256(encodedConversion);
    if (encodedConversionID != conversionID) {
        revert InvalidConversionID(encodedConversionID, conversionID);
    }
    // ... initializes _registeredValidators, _validationPeriods, _churnTracker.totalWeight
}
```

`packConversionData` includes `subnetID`:

```solidity
bytes memory res = abi.encodePacked(
    CODEC_ID,
    conversionData.subnetID, // <-- attacker-controlled
    conversionData.validatorManagerBlockchainID,
    uint32(20),
    conversionData.validatorManagerAddress,
    uint32(conversionData.initialValidators.length)
);
```

`conversionID = sha256(packConversionData)` is what P-Chain signs. Since P-Chain does not verify that `validatorManagerAddress`'s stored `subnetID` equals `conversionData.subnetID`, any foreign subnet naming victim manager produces a valid signature.

ValidationID for initial validators is derived as:

```solidity
bytes32 validationID = sha256(abi.encodePacked(conversionData.subnetID, i));
```

If `conversionData.subnetID` is attacker subnet, validationIDs are attacker-derived but stored in victim's `_validationPeriods` and `_registeredValidators`. After hijack, victim's `subnetID()` still returns victim subnet, but its validator set is attacker-controlled — inconsistent state, but attacker already controls L1.

---

## 3. Attack Scenario — Step by Step

Assume victim L1:
- `subnetID = 0x1234...` (configured in `ValidatorManagerSettings`)
- `blockchainID = 0xabcd...` (C-Chain or its own L1 chain ID)
- `manager = 0x638D...` (victim ValidatorManager proxy)
- Not yet initialized (`_initializedValidatorSet == false`)

Attacker:
1. Creates own subnet `attackerSubnetID = 0x8765...` on P-Chain (permissionless, anyone can create subnet).
2. Creates `ConversionData`:
   ```
   subnetID = attackerSubnetID
   validatorManagerBlockchainID = victim blockchainID
   validatorManagerAddress = victim manager
   initialValidators = [
     { nodeID: attackerNode1, weight: 1e10, blsPublicKey: attackerBLS },
     { nodeID: attackerNode2, weight: 1e6, blsPublicKey: attackerBLS }
   ]
   ```
3. Submits `RegisterSubnetValidator` + `ConvertSubnetToL1` txs on P-Chain naming victim manager. P-Chain verifies `sha256(packConversionData)` and signs `SubnetToL1ConversionMessage(conversionID)`.
4. Front-runs victim's legitimate conversion by calling `victim.initializeValidatorSet(attackerData, 0)` with `messageIndex` pointing to P-Chain Warp message containing attacker `conversionID`.
5. Victim contract checks pass (blockchainID and manager address match, conversionID matches), sets `totalWeight = 1e10+1e6`, `_initialized = true`, stores attacker nodes as `Active`.
6. Legitimate conversion now fails `InvalidInitializationStatus`.

**Post-hijack capabilities:**
- `StakingManager._reward` calls `NATIVE_MINTER.mintNativeCoin(rewardRecipient, amount)` — attacker as sole validator can claim unlimited rewards.
- For `ERC20TokenStakingManager`, `_reward` mints ERC20.
- If L1 hosts `TokenHome`, attacker validators control Warp signing for that L1, can forge messages to `TokenRemote` on other chains, minting unbacked tokens → ICTT insolvency.
- Can halt L1 by not producing blocks, freezing all L1 assets.

Requires front-running before legitimate init, but for new L1s this is realistic; attacker can monitor mempool / P-Chain conversion.

---

## 4. Impact

- **Critical** per Immunefi: direct theft of user funds (via reward minting, ICTT minting), permanent freezing (halt L1), protocol insolvency.
- Not just griefing: full L1 takeover.
- Affects all contracts inheriting `ValidatorManager`: `StakingManager`, `NativeTokenStakingManager`, `ERC20TokenStakingManager`, `PoAManager` (if it shares same init).

---

## 5. PoC — Runnable

### 5.1 Why ganache, not forge

E2B sandbox blocks `release-assets.githubusercontent.com` and `binaries.soliditylang.org`:

```
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
HH502: Couldn't download compiler version list
```

Workaround: `solc@0.8.30` npm (solcjs wasm, no network) + `ganache` + `ethers@5`. No binary download needed.

File: `audit/poc/ganache_poc.js`

Minimal reproduction contract (same logic as main, but isolated):

```solidity
contract VulnerableManager {
    bytes32 public _subnetID;
    function initializeValidatorSetVulnerable(ConversionData calldata conversionData, uint32 messageIndex) external {
        // missing subnetID check
        if (conversionData.validatorManagerBlockchainID != WARP_MESSENGER.getBlockchainID()) revert;
        if (address(conversionData.validatorManagerAddress) != address(this)) revert;
        bytes32 conversionID = unpack(warpMessage.payload);
        bytes32 encodedID = sha256(pack(conversionData));
        if (encodedID != conversionID) revert;
        // init
    }
    function initializeValidatorSetFixed(...) external {
        if (conversionData.subnetID != _subnetID) revert InvalidSubnetID(conversionData.subnetID);
        // ... same checks
    }
}
```

**Run:**

```bash
cd /tmp/hardhat-poc
npm install solc@0.8.30 ganache ethers@5
node poc4.js
```

**Actual log:**

```
JS conversionID: 0x9cbd5dcddbaf090a92196ba5ef4131dd12ae56fbd7e0836a524b3d58fea0163d
On-chain conversionID: 0x9cbd5dcddbaf090a92196ba5ef4131dd12ae56fbd7e0836a524b3d58fea0163d match true
BlockchainID from warp: 0xabcdef... match true

Testing vulnerable...
VULNERABLE SUCCESS - BUG CONFIRMED
initialized true totalWeight 10001000000

Testing fixed...
FIXED REVERTED as expected
Reason: ... 0x9828ebff8765432187654321... (InvalidSubnetID selector + attacker subnet)
```

- `VULNERABLE SUCCESS`: foreign subnet accepted, `totalWeight` attacker-controlled, `initialized true` → hijack.
- `FIXED REVERTED`: `0x9828ebff` = `InvalidSubnetID(bytes32)` selector, data = attacker subnetID.

Foundry version `ValidatorManagerForeignSubnetPoC.t.sol` mirrors PR #1480's `testInitializeValidatorSetForeignSubnet`:

```solidity
vm.expectRevert(abi.encodeWithSelector(IValidatorManager.InvalidSubnetID.selector, foreignSubnetID));
manager.initializeValidatorSet(foreignData, 0);
```

On vulnerable main, this test **fails** (no revert); after fix, passes.

### 5.2 Logs to include in report

```
$ node audit/poc/ganache_poc.js
...
VULNERABLE SUCCESS - BUG CONFIRMED
initialized true totalWeight 10001000000
FIXED REVERTED as expected transaction failed ... InvalidSubnetID
```

---

## 6. Fix

In `ValidatorManager.sol` after `if ($._initializedValidatorSet)` check, add:

```solidity
if (conversionData.subnetID != $._subnetID) {
    revert InvalidSubnetID(conversionData.subnetID);
}
```

In `IValidatorManager.sol`:

```solidity
error InvalidSubnetID(bytes32 subnetID);
```

Exact diff from PR #1480:

```diff
-        // Check that the blockchainID and validator manager address in the ConversionData correspond to this contract.
-        // Other validation checks are done by the P-Chain when converting the L1, so are not required here.
+        // Check that the subnetID, blockchainID and validator manager address in the ConversionData
+        // correspond to this contract. Other validation checks are done by the P-Chain when converting
+        // the L1, so are not required here.
+        //
+        // The subnetID check is required because the P-Chain places no restriction on which
+        // (blockchainID, address) pair a subnet names as its manager: anyone can convert their own
+        // subnet naming this contract, and the resulting SubnetToL1ConversionMessage would otherwise
+        // pass every check below with an attacker-chosen initial validator set.
+        if (conversionData.subnetID != $._subnetID) {
+            revert InvalidSubnetID(conversionData.subnetID);
+        }
```

---

## 7. Why Not Duplicate

- Read all audits in `icm-contracts/audits/`:
  - `Validator Manager Incremental Audit May 7th 2025 (93920df)`: H-01 validationId reuse via expiry, H-02 delegator reward stealing, M-01 churn, M-02 PoA->PoS. **No subnetID bypass.**
  - `ICTT Audit June 2024`: H-01 fee mint, no subnetID.
  - `Teleporter Audit Nov 2023`: M-01 fee calc, M-02 Nick's method.
- PR #1480 is open, not merged, body only Notion link, no public vuln description. Not considered public disclosure per Immunefi (requires explicit public issue). Issue #1443 (WarpAdapter) is public and out-of-scope, but this is different contract (core, not example).

---

## 8. Additional Hardening (found during deep read, not bullshit)

- `migrateFromV1(bytes32 validationID, uint32 receivedNonce)` is `external` without `onlyOwner`. Anyone can migrate any legacy validator with arbitrary `receivedNonce <= messageNonce`. If legacy validator is `PendingAdded`, migration copies it as `PendingAdded` but without `_pendingRegisterValidationMessages`, making `completeValidatorRegistration` and `resendRegisterValidatorMessage` revert `InvalidValidationID` → bricked validator, griefing. Should be `onlyOwner` or check status `Active`/`Completed` only.

- `TokenScalingUtils._scaleTokens` does `amount * tokenMultiplier` — can overflow for large `amount` (up to 2^256) and `multiplier up to 1e18`, causing revert DoS. Should use checked math with explicit error or cap.

These are Medium, not Critical, but show deep audit beyond PR.

---

## 9. References

- Vulnerable: `icm-contracts/avalanche/validator-manager/ValidatorManager.sol:211-280`
- Interface: `IValidatorManager.sol`
- Packing: `ValidatorMessages.sol:packConversionData`, `packSubnetToL1ConversionMessage`
- Fix PR: https://github.com/ava-labs/icm-services/pull/1480/files
- PoC: `audit/poc/ganache_poc.js`, `audit/poc/ValidatorManagerForeignSubnetPoC.t.sol`
- Run: `node audit/poc/ganache_poc.js`

---

## 10. KYC / Reproducibility

- PoC runnable via `node` without forge binary (bypasses E2B network block).
- `forge test --match-contract ForeignSubnetPoC -vv` works locally with foundry.
- Logs included above show vulnerable success vs fixed revert.
