// SPDX-License-Identifier: MIT
// DiamondHouse v3 — transparent FIFO payout house ("pool-zero playable", papertrade-lineage).
//
// NO full-reserve gate, NO queue brake, NO pause: tickets sell even when pool = 0,
// regardless of outstanding debt. The queue is a PUBLIC ledger of what the house owes:
//   - stake is the player's money: returned immediately on settle (any outcome).
//   - profit = (M−1)·S, fee = ρ·profit withheld at settle (ρ = 3.99% of profit).
//   - WIN while queue empty: net profit paid from pool up to what pool holds, rest queues.
//   - WIN while queue has debt: entire net profit appends to FIFO (no jumping the line).
//   - losses go STRAIGHT to pool (papertrade rule); every settle pays up to
//     INLINE_HARVEST (=4) queue entries from pool inline, harvest(n≤64) anyone.
//   - claimInfo(ticketId): position in line + amount owed — the frontend shows the user
//     exactly where they stand (and should surface nothing when debt = 0).
//   - distributions to stakers allowed only with an empty queue and only out of the
//     slice of pool above TARGET_POOL (launch split 80/20, retained share stays pooled).
//   - no pause switch anywhere: fully permissoinless settlement path; owner can only
//     tune menu config (class caps, tighten-only once live), never gate user funds.
//
// AUDIT FIXES (see audit/report): F-01 solvency (not equality) lane check + owner sweep of
// donations; F-08 exact per-notify USDC approvals, revoked on sink rotation, timelocked
// verifier/quoter swaps; F-09 ttl is signed in the quote; F-10 quotes are single-use;
// F-11 payouts that the token refuses are credited for pull-withdrawal (no head-of-line DoS);
// F-12 zero-amount queue entries are never created.
//
// Money-lane invariant (checked in tests after every op):
//   USDC.balanceOf(this) == pool + openStakes                       (cash lanes)
//   queueDebt == Σ queued unpaid profits                            (public liability)
pragma solidity 0.8.26;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}
interface IOutcomeVerifier {
    function verify(uint256 ticketId, uint8 outcome, bytes[] calldata sigs) external view returns (bool);
}
interface IRevenueSink {
    function notifyRevenue(uint256 amount) external;
    function totalStaked() external view returns (uint256);
}

contract DiamondHouse {
    // ---------------- types ----------------
    enum Outcome { UNSETTLED, WON, KNOCKED, EXPIRED, REFUNDED }

    struct Quote {
        uint8   classId;
        uint8   dir;          // 0 = UP, 1 = DOWN
        uint128 stake;
        uint32  multX1e4;     // gross M × 1e4 (fee taken at settle)
        uint64  validUntil;
        bytes32 salt;
        address buyer;
        uint64  ttl;          // F-09: buyer's duration is part of the signed quote
    }
    struct Ticket {
        address owner;
        uint128 stake;
        uint32  multX1e4;
        uint64  expiry;
        uint8   classId;
        uint8   dir;
        Outcome outcome;
        uint128 queuedProfit; // audit trail: how much of this ticket's profit was queued
    }
    struct QueueEntry {
        address owner;
        uint128 amount;       // remaining unpaid
        uint64  ticketId;
    }
    struct ClassCfg {
        uint32 maxMultX1e4;
        uint64 profitCap;     // max profit (M−1)·S per ticket, USDC(6d) — static line; engine G3 tighter
        bool   enabled;
    }

    // ---------------- constants ----------------
    IERC20Min public immutable usdc;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 classId,uint8 dir,uint128 stake,uint32 multX1e4,uint64 validUntil,bytes32 salt,address buyer,uint64 ttl)");
    uint256 public constant GOV_DELAY = 2 days;  // F-08: verifier / quoter swaps are timelocked
    uint256 public constant SEND_GAS_FLOOR = 60_000;  // F-11: minimum gas left for a token payout
    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 399;              // ρ = 3.99% of profit, withheld at settle
    uint256 public constant FOUNDER_FEE_BPS = 99;       //   ↳ 0.99% streamed to founderWallet (settable later)
                                                          //   ↳ remaining 3.00% streamed to DIAMOND stakers (revenueSink)
    uint256 public constant MAX_MULT_X1E4 = 10_000_000; // 1000x envelope (v2)
    uint256 public constant MIN_MULT_X1E4 = 10_500;     // 1.05x floor
    uint256 public constant REBATE_BPS = 1_500;         // EXPIRED rebates 15% of stake
    uint256 public constant QUOTE_TTL = 30;             // seconds
    uint256 public constant STALL_DELAY = 24 hours;
    uint256 public constant LP_LOCK = 7 days;
    uint256 public constant INLINE_HARVEST = 4;
    uint256 public constant HARVEST_MAX = 64;

    // ---------------- state ----------------
    address public owner;
    address public quoterSigner;
    address public outcomeVerifier;
    address public revenueSink;
    address public founderWallet;  // 0.99% stream destination; UNSET (0x0) ⇒ that slice goes to stakers too

    // F-10: single-use quotes
    mapping(bytes32 => bool) public quoteUsed;
    // F-11: payouts refused by the token are credited and pulled later (never stall the queue)
    mapping(address => uint256) public credits;
    uint256 public totalCredits;
    // F-08: timelocked governance for the signing roots
    struct Pending { address who; uint64 eta; }
    Pending public pendingQuoter;
    Pending public pendingVerifier;

    uint256 public pool;        // house lane (loses land here directly)
    uint256 public openStakes;  // player lane (unsettled stakes)
    uint256 public queueDebt;   // Σ unpaid queued profits (public debt)
    uint256 public targetPool   = 500_000e6;   // waterfall threshold
    uint256 public constant STAKER_SHARE_BPS = 8_000; // 80% of (pool − targetPool) is distributable

    mapping(uint8 => ClassCfg) public classCfg;

    Ticket[]  public tickets;
    QueueEntry[] public payoutQueue;
    uint256 public queueHead; // payoutQueue[queueHead] is the oldest live entry

    // LP vault (optional; tickets sell with zero LP capital)
    uint256 public totalShares;
    mapping(address => uint256) public lpShares;
    mapping(address => uint256) public lpPendingExit;   // shares queued for exit
    mapping(address => uint64)  public lpExitAvailableAt;

    uint256 private _locked = 1;
    modifier nonReentrant() { require(_locked == 1, "reentrancy"); _locked = 2; _; _locked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Sold(uint256 indexed id, address indexed buyer, uint8 classId, uint8 dir,
               uint256 stake, uint32 multX1e4, uint64 expiry);
    event Settled(uint256 indexed id, uint8 outcome, uint256 stakeBack,
                  uint256 profitPaid, uint256 profitQueued, uint256 feeTaken);
    event FeeStreamed(uint256 indexed id, uint256 founderAmt, uint256 stakerAmt);
    event Refunded(uint256 indexed id, uint256 stake);
    event Queued(uint256 indexed entryId, uint256 indexed ticketId, address owner, uint256 amount);
    event Dequeued(uint256 indexed entryId, address owner, uint256 amount);
    event ClassSet(uint8 classId, uint32 maxMult, uint64 profitCap, bool enabled);
    event ParamSet(string what, uint256 value);
    event LpDeposit(address indexed lp, uint256 amount, uint256 shares);
    event LpExitRequested(address indexed lp, uint256 shares, uint64 availableAt);
    event LpWithdrawn(address indexed lp, uint256 amount);
    event RevenueDistributed(uint256 amount, address sink);
    event Credited(address indexed to, uint256 amount);
    event CreditWithdrawn(address indexed to, uint256 amount);
    event GovProposed(string what, address who, uint64 eta);

    constructor(address _usdc, address _quoter) {
        require(_usdc != address(0) && _quoter != address(0), "zero addr");
        usdc = IERC20Min(_usdc);
        owner = msg.sender;
        quoterSigner = _quoter;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DiamondHouse"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // ---------------- views ----------------
    function balance() public view returns (uint256) { return usdc.balanceOf(address(this)); }

    /// Cash-lane invariant (F-01 fix): the contract must HOLD at least what it owes.
    /// Surplus (accidental transfers) cannot freeze the protocol; owner may sweep it.
    function lanesIntact() public view returns (bool) {
        return balance() >= pool + openStakes + totalCredits;
    }
    /// NAV available to LPs: queued winners are senior (F-06).
    function navPool() public view returns (uint256) {
        return pool > queueDebt ? pool - queueDebt : 0;
    }
    /// Sweep of unallocated surplus only (donations); never touches pool / openStakes / credits.
    function sweepSurplus(address to) external onlyOwner nonReentrant {
        uint256 b = balance();
        uint256 owed = pool + openStakes + totalCredits;
        require(b > owed, "no surplus");
        require(usdc.transfer(to, b - owed), "sweep out");
    }
    function liveQueueEntries() public view returns (uint256) {
        return payoutQueue.length - queueHead;
    }

    /// User-facing queue transparency: where does this ticket stand and what is it owed?
    /// position = 0 when nothing is queued for this ticket; otherwise 1 = next to be paid.
    mapping(uint256 => uint256) public queueOf; // ticketId → entryId+1 (0 = never queued)

    function claimInfo(uint256 ticketId) external view returns (
        bool hasDebt, uint256 amountOwed, uint256 position, uint256 totalDebt
    ) {
        uint256 ref = queueOf[ticketId];
        totalDebt = queueDebt;
        if (ref == 0) return (false, 0, 0, totalDebt);
        uint256 entryId = ref - 1;
        QueueEntry storage e = payoutQueue[entryId];
        if (e.amount == 0) return (false, 0, 0, totalDebt);
        return (true, uint256(e.amount), entryId - queueHead + 1, totalDebt);
    }

    // ---------------- sales (v2: no solvency gate) ----------------
    function buyTicket(Quote calldata q, bytes calldata sig, uint32 minMultX1e4, uint64 ttl)
        external nonReentrant returns (uint256 id)
    {
        require(ttl == 30 || ttl == 60 || ttl == 120 || ttl == 300, "bad ttl");
        require(q.validUntil >= block.timestamp, "quote expired");
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        require(q.multX1e4 >= minMultX1e4, "slippage: mult");
        require(q.ttl == ttl, "ttl mismatch");                       // F-09

        ClassCfg memory cc = classCfg[q.classId];
        require(cc.enabled, "class disabled");
        require(q.multX1e4 <= cc.maxMultX1e4, "class mult cap");

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(QUOTE_TYPEHASH, q.classId, q.dir, q.stake,
                                 q.multX1e4, q.validUntil, q.salt, msg.sender, q.ttl))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");
        require(q.buyer == msg.sender, "quote not yours");
        require(!quoteUsed[digest], "quote used");                   // F-10
        quoteUsed[digest] = true;

        uint256 stake = q.stake;
        uint256 profit = uint256(q.multX1e4 - 10_000) * stake / 10_000; // (M−1)·S
        require(stake > 0, "zero stake");
        require(profit <= cc.profitCap, "profit over class cap");       // static per-ticket line

        require(usdc.transferFrom(msg.sender, address(this), stake), "pay in");
        openStakes += stake;

        id = tickets.length;
        tickets.push(Ticket({
            owner: msg.sender,
            stake: uint128(stake),
            multX1e4: q.multX1e4,
            expiry: uint64(block.timestamp + ttl),
            classId: q.classId,
            dir: q.dir,
            outcome: Outcome.UNSETTLED,
            queuedProfit: 0
        }));
        emit Sold(id, msg.sender, q.classId, q.dir, stake, q.multX1e4, uint64(block.timestamp + ttl));
        require(lanesIntact(), "lane drift");
    }

    // ---------------- settlement (attested, VWAP off-chain) ----------------
    /// Permissionless relay. EXPIRED requires expiry reached; WON/KNOCKED any time after sale.
    /// Pays up to INLINE_HARVEST queue entries from the side bucket after the settle.
    function settleWithProof(uint256 id, Outcome o, bytes[] calldata sigs) external nonReentrant {
        Ticket storage t = tickets[id];
        require(t.outcome == Outcome.UNSETTLED, "settled");
        require(o == Outcome.WON || o == Outcome.KNOCKED || o == Outcome.EXPIRED, "bad outcome");
        if (o == Outcome.EXPIRED) require(block.timestamp >= t.expiry, "not expired");
        require(IOutcomeVerifier(outcomeVerifier).verify(id, uint8(o), sigs), "unattested");

        t.outcome = o;
        uint256 S = t.stake;
        openStakes -= S;

        uint256 stakeBack = S;
        uint256 profitPaid = 0;
        uint256 profitQueued = 0;
        uint256 feeTaken = 0;

        if (o == Outcome.WON) {
            uint256 profit = uint256(t.multX1e4 - 10_000) * S / 10_000;
            feeTaken = profit * FEE_BPS / BPS;            // ρ = 3.99% of profit
            uint256 netProfit = profit - feeTaken;
            // ρ is a haircut on the PLAYER'S CLAIM. A queued/partial claim never streams fee.
            // On a fully paid claim, _streamFee sends only what the remaining pool can cover:
            //   0.99% of profit → founderWallet (address(0) ⇒ re-routed to active stakers)
            //   3.00% of profit → revenueSink (DIAMOND stakers, pull-based; retained if none stake)
            // The mint anchor still records the full feeTaken haircut from Settled, independently
            // of whether any fee cash was streamable.
            if (queueDebt == 0) {
                profitPaid = netProfit > pool ? pool : netProfit; // pool pays what it can
                pool -= profitPaid;
                if (profitPaid < netProfit) _enqueue(t.owner, netProfit - profitPaid, uint64(id));
                profitQueued = netProfit - profitPaid;
                if (profitPaid == netProfit && feeTaken > 0) _streamFee(id, profit, feeTaken);
            } else {
                _enqueue(t.owner, netProfit, uint64(id)); // no jumping the line
                profitQueued = netProfit;
            }
            t.queuedProfit = uint128(profitQueued);
            _send(t.owner, S + profitPaid);
        } else if (o == Outcome.KNOCKED) {
            pool += S;                 // papertrade rule: loser money feeds the house pot directly
            stakeBack = 0;
        } else { // EXPIRED: rebate 15% of stake, rest to pool
            uint256 rebate = S * REBATE_BPS / BPS;
            stakeBack = rebate;
            pool += S - rebate;
            _send(t.owner, rebate);
        }

        emit Settled(id, uint8(o), stakeBack, profitPaid, profitQueued, feeTaken);
        _payQueue(INLINE_HARVEST);
        require(lanesIntact(), "lane drift");
    }

    /// §8 failsafe: attesters stalled > 24h past expiry ⇒ full stake back, no fee, no rebate math.
    function refundAfterStall(uint256 id) external nonReentrant {
        Ticket storage t = tickets[id];
        require(t.outcome == Outcome.UNSETTLED, "settled");
        require(block.timestamp >= t.expiry + STALL_DELAY, "not stalled");
        t.outcome = Outcome.REFUNDED;
        openStakes -= t.stake;
        _send(t.owner, t.stake);
        emit Refunded(id, t.stake);
        require(lanesIntact(), "lane drift");
    }

    /// Streams only cash that actually has a destination. With no stakers the 3% slice
    /// stays in pool instead of becoming unclaimable in RevenueSplit. With both destinations
    /// active, total=feeTaken, so pre-settle pool must cover net+fee (= gross profit).
    function _streamFee(uint256 id, uint256 profit, uint256 feeTaken) internal {
        uint256 nominalFounder = profit * FOUNDER_FEE_BPS / BPS;
        address founder = founderWallet;
        address sink = revenueSink;
        uint256 founderAmt = founder == address(0) ? 0 : nominalFounder;
        uint256 stakerAmt = 0;
        if (sink != address(0) && IRevenueSink(sink).totalStaked() > 0) {
            stakerAmt = founder == address(0) ? feeTaken : feeTaken - nominalFounder;
        }
        uint256 total = founderAmt + stakerAmt;
        if (total == 0 || pool < total) return; // no realized cash: retain in pool, never underflow
        pool -= total;
        if (founderAmt > 0) _send(founder, founderAmt);
        if (stakerAmt > 0) {
            require(usdc.approve(sink, stakerAmt), "approve");  // F-08: exact, single-use allowance
            IRevenueSink(sink).notifyRevenue(stakerAmt);
        }
        emit FeeStreamed(id, founderAmt, stakerAmt);
    }
    /// F-11: a token-level refusal (blocklist, pause) must not stall the protocol. The amount is
    /// credited to the payee and can be pulled with withdrawCredit(); the lane stays solvent.
    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        // gas floor: a caller must not be able to starve the token call so that it fails and the
        // payout silently becomes a credit (no theft, but a griefing path). Revert instead.
        require(gasleft() >= SEND_GAS_FLOOR, "send gas");
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        credits[to] += amount;
        totalCredits += amount;
        emit Credited(to, amount);
    }
    function withdrawCredit() external nonReentrant {
        uint256 a = credits[msg.sender];
        require(a > 0, "no credit");
        credits[msg.sender] = 0;
        totalCredits -= a;
        require(usdc.transfer(msg.sender, a), "credit out");
        emit CreditWithdrawn(msg.sender, a);
    }

    // ---------------- FIFO payout queue ----------------
    function _enqueue(address who, uint256 amount, uint64 ticketId) internal {
        if (amount == 0) return;                                     // F-12: no zero-value entries
        payoutQueue.push(QueueEntry({ owner: who, amount: uint128(amount), ticketId: ticketId }));
        queueDebt += amount;
        queueOf[ticketId] = payoutQueue.length; // entryId+1 for claimInfo()
        emit Queued(payoutQueue.length - 1, ticketId, who, amount);
    }

    function _payQueue(uint256 maxN) internal {
        uint256 n = maxN;
        while (n > 0 && queueHead < payoutQueue.length && pool > 0) {
            QueueEntry storage e = payoutQueue[queueHead];
            uint256 pay = e.amount > pool ? pool : e.amount;
            e.amount -= uint128(pay);
            pool -= pay;
            queueDebt -= pay;
            _send(e.owner, pay);                                    // F-11: never revert the queue
            emit Dequeued(queueHead, e.owner, pay);
            if (e.amount == 0) queueHead++;
            n--;
        }
    }

    /// Permissionless FIFO harvest. n ≤ HARVEST_MAX keeps gas bounded.
    function harvest(uint256 n) external nonReentrant {
        require(n > 0 && n <= HARVEST_MAX, "n bounds");
        _payQueue(n);
        require(lanesIntact(), "lane drift");
    }

    // ---------------- LP vault (optional; pool-backed, first-loss) ----------------
    // F-04/F-05: virtual shares & assets (ERC-4626 inflation defence). The offset makes a 1-wei
    // deposit into an orphaned pool worth ~0 shares and makes donation-based share inflation
    // unprofitable. Virtual shares are never redeemable, so the dust stays in the pool.
    uint256 public constant VIRTUAL_SHARES = 1e6;
    uint256 public constant VIRTUAL_ASSETS = 1;

    function lpDeposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        require(amount > 0, "zero");
        shares = amount * (totalShares + VIRTUAL_SHARES) / (navPool() + VIRTUAL_ASSETS);
        require(shares > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        pool += amount;
        totalShares += shares;
        lpShares[msg.sender] += shares;
        emit LpDeposit(msg.sender, amount, shares);
        require(lanesIntact(), "lane drift");
    }

    function lpRequestExit(uint256 sharesAmt) external {
        require(sharesAmt > 0 && sharesAmt <= lpShares[msg.sender], "bad shares");
        lpShares[msg.sender] -= sharesAmt;
        lpPendingExit[msg.sender] += sharesAmt;
        lpExitAvailableAt[msg.sender] = uint64(block.timestamp + LP_LOCK);
        emit LpExitRequested(msg.sender, sharesAmt, uint64(block.timestamp + LP_LOCK));
    }

    function lpWithdraw() external nonReentrant {
        uint256 sh = lpPendingExit[msg.sender];
        require(sh > 0, "nothing");
        require(block.timestamp >= lpExitAvailableAt[msg.sender], "locked");
        lpPendingExit[msg.sender] = 0;
        // NAV slice computed BEFORE burning (F-06: senior queue debt is excluded)
        uint256 amount = sh * (navPool() + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
        if (amount > navPool()) amount = navPool();
        // never burn shares for nothing: while queued winners owe more than the pool, NAV is 0
        // and the exit must wait (reverts → shares and the exit request are kept).
        require(amount > 0, "nav empty");
        totalShares -= sh;
        pool -= amount;
        _send(msg.sender, amount);
        emit LpWithdrawn(msg.sender, amount);
        require(lanesIntact(), "lane drift");
    }

    // ---------------- revenue waterfall (§10) ----------------
    /// Distributable only when the queue is clean; only the slice above targetPool, 80% of it.
    function distributable() public view returns (uint256) {
        if (queueDebt > 0 || liveQueueEntries() > 0) return 0;
        if (pool <= targetPool) return 0;
        return (pool - targetPool) * STAKER_SHARE_BPS / BPS;
    }

    function distributeRevenue(uint256 amount) external onlyOwner nonReentrant {
        require(revenueSink != address(0), "no sink");
        require(amount > 0 && amount <= distributable(), "nothing/too much");
        pool -= amount;                                   // pre-debit against reentrancy/double-count
        require(usdc.approve(revenueSink, amount), "approve");  // F-08: exact allowance
        IRevenueSink(revenueSink).notifyRevenue(amount);  // sink pulls exactly `amount`
        emit RevenueDistributed(amount, revenueSink);
        require(lanesIntact(), "lane drift");
    }

    // ---------------- governance (tighten-only where it matters) ----------------
    function setClassCfg(uint8 classId, uint32 maxMult2, uint64 profitCap, bool enabled) external onlyOwner {
        require(maxMult2 >= MIN_MULT_X1E4 && maxMult2 <= MAX_MULT_X1E4, "class mult range");
        ClassCfg memory old = classCfg[classId];
        if (old.enabled) {                                          // live class: tighten-only
            require(maxMult2 <= old.maxMultX1e4 && profitCap <= old.profitCap, "tighten only");
        }
        classCfg[classId] = ClassCfg(maxMult2, profitCap, enabled);
        emit ClassSet(classId, maxMult2, profitCap, enabled);
    }
    function setTargetPool(uint256 tp) external onlyOwner { targetPool = tp; emit ParamSet("targetPool", tp); }
    // F-08: the signing roots can only be swapped through a public 2-day timelock once set.
    // Initial wiring (zero → value) stays immediate so deployment scripts keep working.
    function proposeQuoter(address qa) external onlyOwner {
        require(qa != address(0), "zero");
        pendingQuoter = Pending(qa, uint64(block.timestamp + GOV_DELAY));
        emit GovProposed("quoter", qa, pendingQuoter.eta);
    }
    function executeQuoter() external {
        Pending memory p = pendingQuoter;
        require(p.who != address(0) && block.timestamp >= p.eta, "not ready");
        quoterSigner = p.who; delete pendingQuoter;
        emit ParamSet("quoter", uint256(uint160(p.who)));
    }
    function proposeOutcomeVerifier(address v) external onlyOwner {
        require(v != address(0), "zero");
        pendingVerifier = Pending(v, uint64(block.timestamp + GOV_DELAY));
        emit GovProposed("verifier", v, pendingVerifier.eta);
    }
    function executeOutcomeVerifier() external {
        Pending memory p = pendingVerifier;
        require(p.who != address(0) && block.timestamp >= p.eta, "not ready");
        outcomeVerifier = p.who; delete pendingVerifier;
        emit ParamSet("verifier", uint256(uint160(p.who)));
    }
    function setOutcomeVerifier(address v) external onlyOwner {
        require(v != address(0) && outcomeVerifier == address(0), "timelocked: use proposeOutcomeVerifier");
        outcomeVerifier = v; emit ParamSet("verifier", uint256(uint160(v)));
    }
    /// Rotating the sink revokes the previous sink's allowance (no stale spender).
    function setRevenueSink(address s) external onlyOwner {
        require(s.code.length > 0, "sink must be a contract");   // F-08: an EOA sink would brick settlements
        if (revenueSink != address(0)) usdc.approve(revenueSink, 0);
        revenueSink = s;                       // no standing approval: see _streamFee / distributeRevenue
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }
    function setFounderWallet(address f) external onlyOwner { founderWallet = f; emit ParamSet("founderWallet", uint256(uint160(f))); }

    // ---------------- sig plumbing ----------------
    function _recoverSig(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "sig len");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
