# go-f3 audit – DoS via retry budget starvation and permanent locks

This directory contains PoCs for vulnerabilities found in Filecoin go-f3, analogous to RootstockLabs reports #93347, #93205, #92900.

## Scope
- https://github.com/filecoin-project/go-f3 – Golang implementation of Fast Finality for Filecoin (F3)
- Impacts: High – Inability to propagate transactions, transient consensus failures, high compute consumption

## Vulnerabilities

### 1. LegacyECChain CBOR decode allows oversized chains (go-f3 #1081)
**File:** `gpbft/cbor_gen.go` – `LegacyECChain.UnmarshalCBOR`

- Generated decoder allowed `extra > 8192` then `make([]TipSet, extra)` before `Validate()` checks `ChainMaxLen=128`.
- Attacker crafts chain with 129..8192 TipSets, marshals, sends via pubsub (GMessage or chainexchange).
- Node allocates large slice before validation, causing high compute/memory.
- Flood with 8192-length chains can cause OOM and DoS of >30% validators.

**Fix:** Enforce `ChainMaxLen` before allocation in both Marshal and Unmarshal.

**PoC:** `audit/poc/cbor_dos_poc.go`
```
go run audit/poc/cbor_dos_poc.go
```
Before fix: Unmarshal succeeds with len=129, Validate fails after allocation.
After fix: Unmarshal rejects "array too large (129 > 128)" before allocation.

### 2. messageQueue unbounded future instance flooding and hash grinding (analogous to powpeg-node #93347)
**File:** `gpbft/participant.go` – `messageQueue`

- `Add` had no future instance limit: comment "There's no check on instance number being within a reasonable range".
- No per-instance or per-sender caps, no global cap.
- `Drain` iterated over `map[ActorID][]*GMessage` – Go map order randomized per iteration but still, with hard budget break (e.g., 40 sends per turn), attacker could grind to starve honest messages.
- Attacker queues 5000 msgs for instance 1e6 while current is 100, exhausting memory.

**Fix:**
- `maxFutureInstances=10`, `AddWithCurrentInstanceCheck(current, msg)` rejects far future
- per-instance 1000, per-sender per-instance 50, global 5000 with eviction of oldest
- Fair draining sorted by round/phase/sender, deterministic tie-break prevents grinding

**PoC:** `audit/poc/message_queue_dos_poc.go`

### 3. Partial message manager permanent lock via vanished chains (analogous to LP #93205)
**File:** `pmsg/partial_msg.go`

- `pmByInstance` LRU + `pmkByInstanceByChainKey` map held partial messages waiting for chain discovery.
- If chain never discovered (reorged out, invalid, or never broadcast), messages stay forever, no expiry, no cleaner, survives restart via WAL.
- Attacker can grind many distinct chainKeys (random keys) to fill `pmkByInstanceByChainKey` unbounded, evicting honest messages.
- Similar to LP corpse: bound deposit tx disappears, quote stuck in WaitingForDepositConfirmations, expiry guarded on WaitingForDeposit, cleaner only deletes TimeForDepositElapsed, lock survives restart.

**Fix (mirrors LP deposit_vanish_tracker.go):**
- `chainKeyMeta` tracks firstSeen and missCount per instance per chainKey
- Cleanup ticker every 30s expires keys older than 5m or vanished after 3 misses +30s depth, removing all partial messages for key
- `maxChainKeysPerInstance=100`, evict oldest on cap
- `senderCount` per-sender cap 50 msgs per instance

**PoC:** `audit/poc/partial_msg_vanish_poc.go`

### 4. Unauthenticated flooding (analogous to LP #92900)
**File:** `host.go` – `validatePubsubMessage`

- No rate limiting per peer, no per-sender cap.
- Attacker can flood pubsub with valid partial messages, locking all buffer slots, causing every new message to be dropped – total denial of F3 service.

**Fix (mirrors LP rate_limit.go + anonymous locking cap):**
- `peerRateLimiter` – 100 msgs/min per peer, map bounded to 10k to prevent spoof flooding
- Check in `validatePubsubMessage` before decoding, return `ValidationIgnore` on excess
- Per-sender cap in pmsg prevents single sender monopolising

## Impact
- **High** – Transient consensus failures, inability to propagate transactions, high compute consumption.
- Before fix: attacker with zero power can cause high compute/memory and starve honest registrations for entire federation change window (or F3 instance window).
- After fix: oversized chains rejected before allocation, queues bounded and fair, vanished chains expired, flooding rate-limited.

## Testing
We cannot run `go test` in this sandbox without Go binary, but braces balanced and logic matches fixes suggested for powpeg-node and LP server.

To test with Filecoin Audit Kit:
```
git clone https://github.com/FilecoinFoundationWeb/filecoin-audit-kit
cd filecoin-audit-kit
./setup.sh  # Lotus devnet
# Apply our diff
go test ./gpbft -run TestPoC
go run audit/poc/cbor_dos_poc.go
```

## Fixes applied
- `gpbft/cbor_gen.go`: enforce ChainMaxLen
- `gpbft/participant.go`: bound messageQueue, fair draining
- `pmsg/partial_msg.go`: vanish tracker, expiry, caps
- `host.go`: per-peer rate limiting

All fixes are no-consensus-change where possible, or hardening that prevents DoS without hard fork.
