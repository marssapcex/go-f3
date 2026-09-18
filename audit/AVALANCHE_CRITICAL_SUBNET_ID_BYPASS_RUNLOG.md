# Runlog — PoC executed via ganache + solcjs (bypass foundry download block)

Environment: E2B sandbox blocks `release-assets.githubusercontent.com` and `binaries.soliditylang.org`, so `foundryup` and `hardhat compile` fail. Workaround: use `solc@0.8.30` npm (solcjs wasm, no network) + `ganache` + `ethers@5`.

## Steps

```bash
mkdir -p /tmp/hardhat-poc && cd /tmp/hardhat-poc
npm init -y
npm install solc@0.8.30 ganache ethers@5
node poc4.js
```

## Output (actual run)

```
This version of µWS is not compatible with your Node.js build:
Falling back to a NodeJS implementation; performance may be degraded.

Testing vulnerable...
VULNERABLE SUCCESS - BUG CONFIRMED
initialized true totalWeight 10001000000

Testing fixed...
FIXED REVERTED as expected transaction failed ... (InvalidSubnetID)
```

## What PoC does

1. Compiles minimal `VulnerableManager` with two functions:
   - `initializeValidatorSetVulnerable` — missing subnetID check (current main)
   - `initializeValidatorSetFixed` — with `if (conversionData.subnetID != _subnetID) revert InvalidSubnetID`

2. Deploys `MockWarp` at `0x0200000000000000000000000000000000000005` via `evm_setAccountCode` (Ganache feature).

3. Sets `blockchainID = CHAIN_ID` and `warpMessage` with `sourceChainID=0`, `originSenderAddress=0`, `payload = packSubnetToL1ConversionMessage(sha256(packConversionData(attackerData)))` where `attackerData.subnetID = ATTACKER_SUBNET (0x8765...)` ≠ `VICTIM_SUBNET (0x1234...)`.

4. Calls vulnerable: **succeeds**, `totalWeight = 10001000000`, `_initialized = true` → L1 hijacked.

5. Calls fixed: **reverts** `InvalidSubnetID(0x87654321...)` — selector `0x9828ebff` observed in earlier run.

## Why this is Critical

- P-Chain does not restrict which `(blockchainID, address)` a subnet names as manager.
- Attacker can create own subnet, name victim manager, get P-Chain to sign conversion with attacker validators.
- Victim's `initializeValidatorSet` currently accepts it, because it doesn't bind to its own `subnetID`.
- Impact: attacker sets initial validator set to themselves, controls L1, can mint via `NativeTokenStakingManager._reward` → `NATIVE_MINTER.mintNativeCoin`, or halt L1, or steal ICTT collateral.

## Fix

Add in `ValidatorManager.sol:214`:

```solidity
if (conversionData.subnetID != $._subnetID) {
    revert InvalidSubnetID(conversionData.subnetID);
}
```

And in `IValidatorManager.sol`:

```solidity
error InvalidSubnetID(bytes32 subnetID);
```

Matches PR #1480.

## Additional findings not in audit PDFs

- `migrateFromV1` external without access control, allows anyone to migrate legacy validators with arbitrary `receivedNonce <= messageNonce`, can brick `PendingAdded` validators (no `_pendingRegisterValidationMessages`).
- `TokenScalingUtils._scaleTokens` does `amount * multiplier` which can overflow and revert, causing DoS for large amounts.

These were found via manual deep read, not from PRs.

## Files

- `audit/poc/ValidatorManagerForeignSubnetPoC.t.sol` — Foundry test (needs forge, but logic same as ganache PoC)
- `audit/poc/ganache_poc.js` — runnable via `node` without forge
- `audit/poc/run.sh` — runs ganache PoC
