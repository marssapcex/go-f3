// Quoter: assembles and EIP-712-signs quotes for DiamondHouse (binary tickets) and
// DiamondOptions (capped-vanilla spreads). Domain/types must mirror the contracts exactly.
//
// F-09 fix: `ttl` (the duration the multiplier was priced for, τ in seconds) is part of the
// signed payload. A quote is therefore valid for exactly one duration; the buyer cannot switch
// to a shorter/longer ttl that the quoter did not price. F-10: each quote is single-use on-chain.
export const HOUSE_TYPES = { Quote: [
  { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
  { name: "stake", type: "uint128" }, { name: "multX1e4", type: "uint32" },
  { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
  { name: "buyer", type: "address" }, { name: "ttl", type: "uint64" } ] };

export const OPTIONS_TYPES = { OQuote: [
  { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
  { name: "premium", type: "uint128" }, { name: "multX1e4", type: "uint32" },
  { name: "bandBps", type: "uint32" }, { name: "strikeX1e8", type: "uint64" },
  { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
  { name: "buyer", type: "address" }, { name: "ttl", type: "uint64" } ] };

export class Quoter {
  constructor(wallet, { houseAddr, optionsAddr, chainId }) {
    this.w = wallet;
    this.chainId = chainId;
    this.domains = {};
    if (houseAddr) this.domains.house = { name: "DiamondHouse", version: "1", chainId, verifyingContract: houseAddr };
    if (optionsAddr) this.domains.options = { name: "DiamondOptions", version: "1", chainId, verifyingContract: optionsAddr };
  }
  async signTicket(value) {   // value: HOUSE_TYPES.Quote fields (ttl REQUIRED, F-09)
    if (value.ttl === undefined) throw new Error("signTicket: ttl is required (signed field)");
    return { q: value, sig: await this.w.signTypedData(this.domains.house, HOUSE_TYPES, value) };
  }
  async signOption(value) {   // value: OPTIONS_TYPES.OQuote fields (ttl REQUIRED, F-09)
    if (value.ttl === undefined) throw new Error("signOption: ttl is required (signed field)");
    return { q: value, sig: await this.w.signTypedData(this.domains.options, OPTIONS_TYPES, value) };
  }
}

// Attester worker: builds the close price from routed venue tape(s) and signs settlement.
export const PRICE_TYPES = { OptPrice: [
  { name: "optionId", type: "uint256" }, { name: "closePx", type: "uint64" },
  { name: "house", type: "address" } ] };

export const OUTCOME_TYPES = { Outcome: [
  { name: "ticketId", type: "uint256" }, { name: "outcome", type: "uint8" },
  { name: "house", type: "address" } ] };

/** G8: two-venue tolerance — returns agreed price (1e8 int) or null = NO-SIGN. */
export function agreePrice(pxA, pxB, tolFrac = 0.0012) {
  if (pxA == null || pxB == null) return pxA ?? pxB;      // single-read venues pass through
  if (Math.abs(pxA - pxB) / Math.min(pxA, pxB) > tolFrac) return null;
  return (pxA + pxB) / 2;
}

export class Attester {
  constructor(wallet, { priceVerifierAddr, outcomeVerifierAddr, chainId, houseAddr }) {
    this.w = wallet; this.chainId = chainId; this.houseAddr = houseAddr;
    this.pDomain = priceVerifierAddr && { name: "DiamondPrice", version: "1", chainId, verifyingContract: priceVerifierAddr };
    this.oDomain = outcomeVerifierAddr && { name: "DiamondOutcome", version: "1", chainId, verifyingContract: outcomeVerifierAddr };
  }
  async signOptPrice(optionId, closePxX1e8) {
    return this.w.signTypedData(this.pDomain, PRICE_TYPES,
      { optionId, closePx: closePxX1e8, house: this.houseAddr });
  }
  async signOutcome(ticketId, outcome) {
    return this.w.signTypedData(this.oDomain, OUTCOME_TYPES,
      { ticketId, outcome, house: this.houseAddr });
  }
}
