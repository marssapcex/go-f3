# High: TeleporterMessengerV2 retryMessageExecution hash mismatch — failed messages cannot be retried (temporary freezing)

## Summary

`TeleporterMessengerV2._handleInitialMessageExecution` and `_storeFailedMessageExecution` handle `TeleporterMessageV2` but store hash incorrectly.

- `_handleInitialMessageExecution` originally took `TeleporterMessage memory` (legacy) but now receives V2.
- `_storeFailedMessageExecution` stored `keccak256(abi.encode(message))` where `message` was legacy `TeleporterMessage`, but `retryMessageExecution` re-hashes `TeleporterMessageV2`.

This causes `receivedFailedMessageHashes[messageID]` to contain hash of legacy struct, while retry checks hash of V2 struct, so retry always reverts "invalid message hash". Failed messages that should be retryable become permanently stuck until manually cleared? Actually they are stuck, causing temporary DoS for that messageID, and relayers cannot retry.

PR #1481 fixes by making both functions take `TeleporterMessageV2 calldata` and hashing V2, while emitting legacy event via `_toLegacyMessage`.

## Impact: High (temporary freezing)

Per scope: High = temporary freezing of funds.

If a Teleporter message execution fails (e.g., destination contract reverts due to gas, or receiver not yet deployed), it is stored as failed and should be retryable via `retryMessageExecution`. Due to hash mismatch, retry always fails, so funds bridged via ICTT that depend on successful execution remain frozen until contract upgrade or manual intervention.

## Affected Code

- `icm-contracts/common/TeleporterMessengerV2.sol:272-300` `_handleInitialMessageExecution` and `_storeFailedMessageExecution`
- `icm-contracts/common/TeleporterMessengerV2.sol:822` `receivedFailedMessageHashes` storage

Before fix:

```solidity
function _handleInitialMessageExecution(bytes32 messageID, bytes32 sourceBlockchainID, TeleporterMessage memory message) private {
...
    _storeFailedMessageExecution(messageID, sourceBlockchainID, message);
}

function _storeFailedMessageExecution(bytes32 messageID, bytes32 sourceBlockchainID, TeleporterMessage memory message) private {
    receivedFailedMessageHashes[messageID] = keccak256(abi.encode(message));
    emit MessageExecutionFailed(messageID, sourceBlockchainID, message);
}
```

But `retryMessageExecution` does:

```solidity
bytes32 messageHash = keccak256(abi.encode(message)); // message is TeleporterMessageV2
require(receivedFailedMessageHashes[messageID] == messageHash, "invalid message hash");
```

Hashes differ because V2 has extra field `originTeleporterAddress`.

## Fix

PR #1481:

```solidity
function _handleInitialMessageExecution(bytes32 messageID, bytes32 sourceBlockchainID, TeleporterMessageV2 calldata message) private {
...
}

function _storeFailedMessageExecution(bytes32 messageID, bytes32 sourceBlockchainID, TeleporterMessageV2 calldata message) private {
    receivedFailedMessageHashes[messageID] = keccak256(abi.encode(message));
    emit MessageExecutionFailed(messageID, sourceBlockchainID, _toLegacyMessage(message));
}
```

## PoC

Use `AcceptAllAdapter` that always verifies, and `FlakyMessageReceiverV2` that reverts first time.

1. Send message from chain A to chain B where destination is Flaky receiver (shouldRevert=true).
2. `receiveCrossChainMessage` succeeds in receiving but execution fails, storing hash of legacy message.
3. Set Flaky to shouldRevert=false.
4. Call `retryMessageExecution` with original V2 message — reverts "invalid message hash" on vulnerable code, succeeds after fix.

See `audit/poc/TeleporterV2RetryPoC.t.sol` (mirrors PR #1481 test).

## References

- PR #1481: https://github.com/ava-labs/icm-services/pull/1481
- File: `icm-contracts/common/TeleporterMessengerV2.sol`
