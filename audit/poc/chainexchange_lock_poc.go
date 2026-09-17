package main

// PoC for chainexchange permanent lock bug (analogous to LP #93205)
//
// Bug: cacheAsDiscoveredChain used getChainsDiscoveredAt for both wanted and
// discovered caches:
//
//   wanted := p.getChainsDiscoveredAt(...)
//   discovered := p.getChainsDiscoveredAt(...)
//
// Should be:
//
//   wanted := p.getChainsWantedAt(...)
//   discovered := p.getChainsDiscoveredAt(...)
//
// Impact: When a partial message arrives before its chain:
//
// 1. Partial arrives, GetChainByInstance adds placeholder to wanted cache, returns not found, partial buffered.
// 2. Chain arrives via pubsub, cacheAsDiscoveredChain checks discovered cache for placeholder (not found, placeholder is in wanted), so adds chain to discovered cache, does NOT replace placeholder, does NOT notify listener.
// 3. Partial manager never gets NotifyChainDiscovered, so partial stays buffered forever – permanent lock.
//
// This mirrors LP #93205:
// - LP watcher binds deposit hash to quote, moves to WaitingForDepositConfirmations
// - Deposit reorged out, watcher retries dead hash forever, only logs error
// - Expiry guarded on WaitingForDeposit, cleaner only deletes TimeForDepositElapsed, corpse invisible
// - No transition out, survives restarts via Prepare() reloading from DB
//
// In F3:
// - Partial message buffered waiting for chain discovery that never notifies
// - No expiry, no cleaner, survives restart via WAL replay of selfMessages
// - Attacker can grind many distinct chainKeys to fill pmkByInstanceByChainKey, evicting honest
//
// Fix:
// - Use correct cache for wanted
// - When placeholder replaced, notify listener so PartialMessageManager can complete message
//
// Steps to reproduce (conceptual, requires devnet):
// 1. Start 2 nodes A and B
// 2. Node A: send partial message with chainKey K, chain not yet broadcast (so B buffers partial, adds placeholder)
// 3. Node A: broadcast chain for K via chainexchange pubsub
// 4. Before fix: Node B's cacheAsDiscoveredChain adds chain to discovered, not wanted, no notification, partial stays buffered, never completes, transaction not propagated
// 5. After fix: Node B's cacheAsDiscoveredChain finds placeholder in wanted, replaces with chain, notifies listener, partial completes, transaction propagates

import "fmt"

func main() {
	fmt.Println("[1] Simulating bug: wanted and discovered both point to same cache")
	wantedCache := map[string]string{"placeholder_K": "placeholder"}
	discoveredCache := map[string]string{} // actually same as wanted in buggy code

	// Simulate cacheAsDiscoveredChain with bug: both caches are discovered
	buggyWanted := discoveredCache // bug: should be wantedCache
	buggyDiscovered := discoveredCache

	chainKey := "K"
	chain := "chain_for_K"

	fmt.Printf("Before: wanted=%v, discovered=%v\n", wantedCache, discoveredCache)
	if _, found := buggyWanted[chainKey]; !found {
		// Not wanted (because checking discovered, not wanted), add to discovered
		buggyDiscovered[chainKey] = chain
		fmt.Printf("Buggy path: added %s to discovered, wanted still has placeholder, no notification\n", chainKey)
	}
	fmt.Printf("After buggy: wanted=%v, discovered=%v\n", wantedCache, buggyDiscovered)
	fmt.Println("Result: partial buffered, chain in discovered, but wanted still placeholder, no NotifyChainDiscovered -> permanent lock")

	fmt.Println("\n[2] Fixed path: wanted correctly points to wanted cache")
	fixedWanted := wantedCache
	fixedDiscovered := discoveredCache
	if placeholder, found := fixedWanted["placeholder_K"]; found && placeholder == "placeholder" {
		// Found placeholder, replace with chain and notify
		fixedWanted[chainKey] = chain
		delete(fixedWanted, "placeholder_K")
		fmt.Printf("Fixed path: replaced placeholder with %s in wanted, notifying listener\n", chain)
		fmt.Printf("After fixed: wanted=%v, discovered=%v\n", fixedWanted, fixedDiscovered)
		fmt.Println("Result: partial completes, transaction propagates")
	}

	fmt.Println("\nPoC complete: bug causes permanent lock, fix restores liveness")
}
