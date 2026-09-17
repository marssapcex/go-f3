package main

import (
	"context"
	"fmt"

	lru "github.com/hashicorp/golang-lru/v2"
)

type ECChainKey string

func (k ECChainKey) IsZero() bool { return k == "" }

type ECChain struct {
	ID      int
	ChainKey ECChainKey
	Prefixes []ECChain
}

func (c *ECChain) AllPrefixes() []*ECChain {
	return []*ECChain{c}
}

func (c *ECChain) Key() ECChainKey { return c.ChainKey }

type chainPortion struct {
	chain *ECChain
}

func (p *chainPortion) IsPlaceholder() bool {
	return p == chainPortionPlaceHolder
}

var chainPortionPlaceHolder = &chainPortion{chain: nil}

type discovery struct {
	instance uint64
	chain    *ECChain
}

type Listener interface {
	NotifyChainDiscovered(ctx context.Context, instance uint64, chain *ECChain)
}

type MockListener struct {
	Notified []discovery
}

func (m *MockListener) NotifyChainDiscovered(ctx context.Context, instance uint64, chain *ECChain) {
	m.Notified = append(m.Notified, discovery{instance: instance, chain: chain})
	fmt.Printf("[Listener] Notified chain discovered: instance=%d key=%s\n", instance, chain.ChainKey)
}

type PubSubChainExchange struct {
	chainsWanted     map[uint64]*lru.Cache[ECChainKey, *chainPortion]
	chainsDiscovered map[uint64]*lru.Cache[ECChainKey, *chainPortion]
	listener         Listener
}

func New() *PubSubChainExchange {
	return &PubSubChainExchange{
		chainsWanted:     make(map[uint64]*lru.Cache[ECChainKey, *chainPortion]),
		chainsDiscovered: make(map[uint64]*lru.Cache[ECChainKey, *chainPortion]),
	}
}

func (p *PubSubChainExchange) getChainsWantedAt(instance uint64) *lru.Cache[ECChainKey, *chainPortion] {
	if c, ok := p.chainsWanted[instance]; ok {
		return c
	}
	cache, _ := lru.New[ECChainKey, *chainPortion](100)
	p.chainsWanted[instance] = cache
	return cache
}

func (p *PubSubChainExchange) getChainsDiscoveredAt(instance uint64) *lru.Cache[ECChainKey, *chainPortion] {
	if c, ok := p.chainsDiscovered[instance]; ok {
		return c
	}
	cache, _ := lru.New[ECChainKey, *chainPortion](100)
	p.chainsDiscovered[instance] = cache
	return cache
}

func (p *PubSubChainExchange) GetChainByInstance(ctx context.Context, instance uint64, key ECChainKey) (*ECChain, bool) {
	if key.IsZero() {
		return nil, false
	}
	wanted := p.getChainsWantedAt(instance)
	if portion, found := wanted.Get(key); found && !portion.IsPlaceholder() {
		return portion.chain, true
	}
	discovered := p.getChainsDiscoveredAt(instance)
	if portion, found := discovered.Get(key); found {
		wanted.Add(key, portion)
		discovered.Remove(key)
		if p.listener != nil {
			p.listener.NotifyChainDiscovered(ctx, instance, portion.chain)
		}
		return portion.chain, true
	}
	wanted.ContainsOrAdd(key, chainPortionPlaceHolder)
	fmt.Printf("[GetChainByInstance] Added placeholder for instance=%d key=%s\n", instance, key)
	return nil, false
}

func (p *PubSubChainExchange) cacheAsDiscoveredChain_BUGGY(ctx context.Context, instance uint64, chain *ECChain) {
	wanted := p.getChainsDiscoveredAt(instance) // BUG!
	discovered := p.getChainsDiscoveredAt(instance)

	allPrefixes := chain.AllPrefixes()
	for i := len(allPrefixes) - 1; i >= 0 && ctx.Err() == nil; i-- {
		prefix := allPrefixes[i]
		key := prefix.Key()

		if portion, found := wanted.Peek(key); !found {
			existed, _ := discovered.ContainsOrAdd(key, &chainPortion{chain: prefix})
			if !existed {
				fmt.Printf("[BUGGY] Added to discovered: key=%s\n", key)
			}
		} else if portion.IsPlaceholder() {
			wanted.Add(key, &chainPortion{chain: prefix})
			fmt.Printf("[BUGGY] Replaced placeholder: key=%s (THIS SHOULD NOT HAPPEN IN BUGGY)\n", key)
		}
	}
}

func (p *PubSubChainExchange) cacheAsDiscoveredChain_FIXED(ctx context.Context, instance uint64, chain *ECChain) {
	wanted := p.getChainsWantedAt(instance)
	discovered := p.getChainsDiscoveredAt(instance)

	var notifications []discovery
	allPrefixes := chain.AllPrefixes()
	for i := len(allPrefixes) - 1; i >= 0 && ctx.Err() == nil; i-- {
		prefix := allPrefixes[i]
		key := prefix.Key()

		if portion, found := wanted.Peek(key); !found {
			existed, _ := discovered.ContainsOrAdd(key, &chainPortion{chain: prefix})
			if !existed {
				fmt.Printf("[FIXED] Added to discovered: key=%s\n", key)
			}
		} else if portion.IsPlaceholder() {
			wanted.Add(key, &chainPortion{chain: prefix})
			fmt.Printf("[FIXED] Replaced placeholder: key=%s\n", key)
			if p.listener != nil {
				notifications = append(notifications, discovery{instance: instance, chain: prefix})
			}
		}
	}
	if p.listener != nil {
		for _, n := range notifications {
			p.listener.NotifyChainDiscovered(ctx, n.instance, n.chain)
		}
	}
}

func main() {
	ctx := context.Background()
	fmt.Println("=== PoC for chain exchange bug ===")
	fmt.Println()
	fmt.Println("Scenario: Participant wants chain K at instance 10, creates placeholder via GetChainByInstance,")
	fmt.Println("then chain K arrives via remote pubsub (discovered path).")
	fmt.Println("In buggy version, placeholder NOT replaced and listener NOT notified -> partial messages stay buffered.")
	fmt.Println()

	fmt.Println("--- Testing BUGGY version (main) ---")
	p1 := New()
	listener1 := &MockListener{}
	p1.listener = listener1

	instance := uint64(10)
	key := ECChainKey("chain-key-123")

	_, found := p1.GetChainByInstance(ctx, instance, key)
	fmt.Printf("After GetChainByInstance: found=%v (expected false, placeholder created)\n", found)

	wantedCache := p1.getChainsWantedAt(instance)
	if portion, ok := wantedCache.Peek(key); ok {
		fmt.Printf("Wanted cache has key: isPlaceholder=%v\n", portion.IsPlaceholder())
	}
	discoveredCache := p1.getChainsDiscoveredAt(instance)
	if _, ok := discoveredCache.Peek(key); ok {
		fmt.Printf("Discovered cache has key (should not yet)\n")
	} else {
		fmt.Printf("Discovered cache does NOT have key (correct)\n")
	}

	chain := &ECChain{ID: 1, ChainKey: key}
	fmt.Printf("\nSimulating remote chain arrival via pubsub for key=%s\n", key)
	p1.cacheAsDiscoveredChain_BUGGY(ctx, instance, chain)

	if portion, ok := wantedCache.Peek(key); ok {
		fmt.Printf("After BUGGY cacheAsDiscoveredChain, wanted cache has key: isPlaceholder=%v (BUG: still placeholder!)\n", portion.IsPlaceholder())
	} else {
		fmt.Printf("After BUGGY, wanted cache does NOT have key (BUG: placeholder lost?)\n")
	}
	if portion, ok := discoveredCache.Peek(key); ok {
		fmt.Printf("After BUGGY, discovered cache has key: isPlaceholder=%v (BUG: chain went to discovered instead of wanted)\n", portion.IsPlaceholder())
	}
	fmt.Printf("Listener notified count: %d (BUG: should be 1 but is 0)\n", len(listener1.Notified))
	fmt.Printf("\nBUGGY RESULT: Placeholder NOT replaced, notification NOT sent -> partial messages waiting for this chain will stay buffered until second partial same key or RemoveChainsByInstance\n")

	fmt.Println()
	fmt.Println("--- Testing FIXED version (branch) ---")
	p2 := New()
	listener2 := &MockListener{}
	p2.listener = listener2

	_, found = p2.GetChainByInstance(ctx, instance, key)
	fmt.Printf("After GetChainByInstance: found=%v\n", found)

	wantedCache2 := p2.getChainsWantedAt(instance)
	discoveredCache2 := p2.getChainsDiscoveredAt(instance)

	fmt.Printf("\nSimulating remote chain arrival via pubsub for key=%s\n", key)
	p2.cacheAsDiscoveredChain_FIXED(ctx, instance, chain)

	if portion, ok := wantedCache2.Peek(key); ok {
		fmt.Printf("After FIXED cacheAsDiscoveredChain, wanted cache has key: isPlaceholder=%v (FIXED: should be false)\n", portion.IsPlaceholder())
		if !portion.IsPlaceholder() {
			fmt.Printf("Chain in wanted cache: ID=%d Key=%s\n", portion.chain.ID, portion.chain.ChainKey)
		}
	}
	if _, ok := discoveredCache2.Peek(key); ok {
		fmt.Printf("After FIXED, discovered cache has key (should NOT, because it was wanted)\n")
	} else {
		fmt.Printf("After FIXED, discovered cache does NOT have key (correct, it went to wanted)\n")
	}
	fmt.Printf("Listener notified count: %d (FIXED: should be 1)\n", len(listener2.Notified))

	fmt.Println()
	if len(listener1.Notified) == 0 && len(listener2.Notified) == 1 {
		fmt.Println("=== PoC SUCCESS: Bug reproduced in BUGGY, fixed in FIXED ===")
		fmt.Println("Impact: Medium - liveness delay, partial messages buffered waiting for chain that already arrived via pubsub")
		fmt.Println("In F3, this can cause instance to stall waiting for chain that is already discovered, until another partial triggers GetChainByInstance path that does notify")
	} else {
		fmt.Println("=== PoC FAILED ===")
	}
}
