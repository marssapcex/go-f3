// SPDX-License-Identifier: MIT
// DiamondOptions v3 — capped-vanilla ramp, transparent FIFO payouts (same mechanics as DiamondHouse v3).
//
//   Payoff at attested close C (European, VWAP of real prints):
//     CALL: pay = maxPay · min(C−K, band·K)/(band·K)   (0 if C ≤ K)
//     PUT:  pay = maxPay · min(K−C, band·K)/(band·K)   (0 if C ≥ K)
//   maxPay = premium × M (M ≤ class cap, ≤ 25x envelope — ramps already saturate at the band).
//   ρ = 3.99% of the payout withheld at settle; net payout pays from pool if the queue is clean,
//   else goes entirely to the FIFO (no jumping the line). Premiums are house income → pool,
//   directly, always (papertrade rule). No QMAX, no pause: positions sell regardless of debt.
//   claimInfo(option-id) reports queue position + amount owed.
pragma solidity 0.8.26;

interface IERC20MinO {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}
interface IPriceVerifier {
    function verifyOpt(uint256 optionId, uint64 closePx, bytes[] calldata sigs) external view returns (bool);
}

interface IRevenueSinkO {
    function notifyRevenue(uint256 amount) external;
    function totalStaked() external view returns (uint256);
}

contract DiamondOptions {
    uint8 public constant CALL = 0;
    uint8 public constant PUT  = 1;

    struct OQuote {
        uint8   classId;
        uint8   dir;            // 0 CALL / 1 PUT
        uint128 premium;        // USDC in (6dp)
        uint32  multX1e4;       // maxPay = premium × multX1e4 / 1e4
        uint32  bandBps;        // band edge distance from strike, bps of strike
        uint64  strikeX1e8;
        uint64  validUntil;
        bytes32 salt;
        address buyer;
    }
    struct Option_ {
        address owner;
        uint128 premium;
        uint128 maxPay;
        uint64  strikeX1e8;
        uint64  expiry;
        uint32  bandBps;
        uint8   classId;
        uint8   dir;
        uint8   state;          // 0 live, 1 settled, 2 refunded
        uint128 queuedPay;      // audit trail
    }
    struct QueueEntry { address owner; uint128 amount; uint64 optionId; }
    struct ClassCfg { uint32 maxMultX1e4; uint64 payCap; bool enabled; }

    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 399;             // ρ = 3.99% of payout
    uint256 public constant FOUNDER_FEE_BPS = 99;      // 0.99% → founderWallet (0x0 ⇒ to stakers); 3.00% → stakers
    uint256 public constant MAX_MULT_X1E4 = 250_000;   // 25x envelope (ramps saturate at band)
    uint256 public constant MIN_MULT_X1E4 = 10_500;
    uint256 public constant MIN_BAND_BPS  = 5;         // 0.05%
    uint256 public constant MAX_BAND_BPS  = 500;       // 5%
    uint256 public constant MIN_STRIKE_X1E8 = 1e4;
    uint256 public constant QUOTE_TTL = 30;
    uint256 public constant STALL_DELAY = 24 hours;
    uint256 public constant INLINE_HARVEST = 4;
    uint256 public constant HARVEST_MAX = 64;

    bytes32 public constant OQUOTE_TYPEHASH = keccak256(
        "OQuote(uint8 classId,uint8 dir,uint128 premium,uint32 multX1e4,uint32 bandBps,"
        "uint64 strikeX1e8,uint64 validUntil,bytes32 salt,address buyer)");

    IERC20MinO public immutable usdc;
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public owner;
    address public quoterSigner;
    address public priceVerifier;

    uint256 public pool;
    uint256 public openPremiums;  // player lane: unsettled premiums
    uint256 public queueDebt;
    address public revenueSink;
    address public founderWallet;


    Option_[]   public options;
    QueueEntry[] public payoutQueue;
    uint256 public queueHead;
    mapping(uint8 => ClassCfg) public classCfg;

    uint256 private _locked = 1;
    modifier nonReentrant() { require(_locked == 1, "reentrancy"); _locked = 2; _; _locked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event OSold(uint256 indexed id, address indexed buyer, uint8 classId, uint8 dir,
                uint256 premium, uint256 maxPay, uint64 strike, uint32 bandBps, uint64 expiry);
    event OSettled(uint256 indexed id, uint64 closePx, uint256 payout,
                   uint256 paidNow, uint256 queued, uint256 feeTaken);
    event FeeStreamed(uint256 indexed id, uint256 founderAmt, uint256 stakerAmt);
    event ORefunded(uint256 indexed id, uint256 premium);
    event OQueued(uint256 indexed entryId, uint256 indexed optionId, address owner, uint256 amount);
    event ODequeued(uint256 indexed entryId, address owner, uint256 amount);
    event ParamSet(string what, uint256 value);

    constructor(address _usdc, address _quoter) {
        require(_usdc != address(0) && _quoter != address(0), "zero addr");
        usdc = IERC20MinO(_usdc);
        owner = msg.sender;
        quoterSigner = _quoter;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DiamondOptions"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function lanesIntact() public view returns (bool) {
        return usdc.balanceOf(address(this)) == pool + openPremiums;
    }

    /// queue transparency: position (1 = next to pay) + amount owed; hasDebt=false when clean.
    mapping(uint256 => uint256) public queueOf; // optionId → entryId+1 (0 = never queued)
    function claimInfo(uint256 optionId) external view returns (
        bool hasDebt, uint256 amountOwed, uint256 position, uint256 totalDebt
    ) {
        uint256 ref = queueOf[optionId];
        totalDebt = queueDebt;
        if (ref == 0) return (false, 0, 0, totalDebt);
        uint256 entryId = ref - 1;
        QueueEntry storage e = payoutQueue[entryId];
        if (e.amount == 0) return (false, 0, 0, totalDebt);
        return (true, uint256(e.amount), entryId - queueHead + 1, totalDebt);
    }
    function liveQueueEntries() public view returns (uint256) {
        return payoutQueue.length - queueHead;
    }

    /// Theoretical payout for (dir, strike, band, close) — pure pricing, mirror-checked in tests.
    function payoutOf(uint8 dir, uint64 strikeX1e8, uint32 bandBps, uint64 closePx, uint256 maxPay)
        public pure returns (uint256)
    {
        uint256 edge = (uint256(strikeX1e8) * bandBps) / BPS;
        uint256 m;
        if (dir == CALL) { if (closePx <= strikeX1e8) return 0; m = uint256(closePx - strikeX1e8); }
        else             { if (closePx >= strikeX1e8) return 0; m = uint256(strikeX1e8 - closePx); }
        return m >= edge ? maxPay : maxPay * m / edge;
    }

    function buyOption(OQuote calldata q, bytes calldata sig, uint64 worstStrikeX1e8, uint64 ttl)
        external nonReentrant returns (uint256 id)
    {
        require(ttl == 30 || ttl == 60 || ttl == 120 || ttl == 300, "bad ttl");
        require(q.validUntil >= block.timestamp, "quote expired");
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        require(q.bandBps >= MIN_BAND_BPS && q.bandBps <= MAX_BAND_BPS, "band clamp");
        require(q.strikeX1e8 >= MIN_STRIKE_X1E8, "strike floor");
        // strike slippage guard: buyer pins the worst strike they will accept
        if (q.dir == CALL) require(q.strikeX1e8 <= worstStrikeX1e8, "strike worse");
        else               require(q.strikeX1e8 >= worstStrikeX1e8, "strike worse");

        ClassCfg memory cc = classCfg[q.classId];
        require(cc.enabled, "class disabled");
        require(q.multX1e4 <= cc.maxMultX1e4, "class mult cap");

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(OQUOTE_TYPEHASH, q.classId, q.dir, q.premium, q.multX1e4,
                                 q.bandBps, q.strikeX1e8, q.validUntil, q.salt, msg.sender))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");
        require(q.buyer == msg.sender, "quote not yours");

        uint256 premium = q.premium;
        uint256 maxPay = premium * q.multX1e4 / 10_000;
        require(premium > 0, "zero premium");
        require(maxPay <= cc.payCap, "pay over class cap");

        require(usdc.transferFrom(msg.sender, address(this), premium), "pay in");
        openPremiums += premium;

        id = options.length;
        options.push(Option_({
            owner: msg.sender, premium: uint128(premium), maxPay: uint128(maxPay),
            strikeX1e8: q.strikeX1e8, expiry: uint64(block.timestamp + ttl),
            bandBps: q.bandBps, classId: q.classId, dir: q.dir, state: 0, queuedPay: 0
        }));
        emit OSold(id, msg.sender, q.classId, q.dir, premium, maxPay, q.strikeX1e8, q.bandBps,
                   uint64(block.timestamp + ttl));
        require(lanesIntact(), "lane drift");
    }

    /// European: settle only at/after expiry, price attested by MultiPriceVerifier. Permissionless.
    function settleWithPrice(uint256 id, uint64 closePx, bytes[] calldata sigs) external nonReentrant {
        Option_ storage o = options[id];
        require(o.state == 0, "settled");
        require(block.timestamp >= o.expiry, "not expired");
        require(IPriceVerifier(priceVerifier).verifyOpt(id, closePx, sigs), "unattested");

        o.state = 1;
        openPremiums -= o.premium;

        uint256 payout = payoutOf(o.dir, o.strikeX1e8, o.bandBps, closePx, o.maxPay);
        // house income = the premium (real cash). The un-paid band slice is a liability haircut,
        // NOT cash — maxPay was never segregated. Premium feeds pool directly (papertrade rule).
        pool += o.premium;

        uint256 feeTaken = payout * FEE_BPS / BPS;   // ρ haircut on the player's claim (see house)
        uint256 net = payout - feeTaken;

        uint256 paidNow = 0;
        if (net > 0) {
            if (queueDebt == 0) {
                paidNow = net > pool ? pool : net;
                pool -= paidNow;
                if (paidNow < net) _enqueue(o.owner, net - paidNow, uint64(id));
                if (paidNow == net && feeTaken > 0) _streamFee(id, payout, feeTaken);
            } else {
                _enqueue(o.owner, net, uint64(id));
            }
            o.queuedPay = uint128(net - paidNow);
            if (paidNow > 0) require(usdc.transfer(o.owner, paidNow), "pay out");
        }

        emit OSettled(id, closePx, payout, paidNow, net - paidNow, feeTaken);
        _payQueue(INLINE_HARVEST);
        require(lanesIntact(), "lane drift");
    }

    /// Streams only cash that actually has a destination. With no stakers the 3% slice
    /// stays in pool instead of becoming unclaimable in RevenueSplit. With both destinations
    /// active, total=feeTaken, so pre-settle pool must cover net+fee (= gross payout).
    function _streamFee(uint256 id, uint256 payoutAmt, uint256 feeTaken) internal {
        uint256 nominalFounder = payoutAmt * FOUNDER_FEE_BPS / BPS;
        address founder = founderWallet;
        address sink = revenueSink;
        uint256 founderAmt = founder == address(0) ? 0 : nominalFounder;
        uint256 stakerAmt = 0;
        if (sink != address(0) && IRevenueSinkO(sink).totalStaked() > 0) {
            stakerAmt = founder == address(0) ? feeTaken : feeTaken - nominalFounder;
        }
        uint256 total = founderAmt + stakerAmt;
        if (total == 0 || pool < total) return; // no realized cash: retain in pool, never underflow
        pool -= total;
        if (founderAmt > 0) require(usdc.transfer(founder, founderAmt), "founder out");
        if (stakerAmt > 0) IRevenueSinkO(sink).notifyRevenue(stakerAmt);
        emit FeeStreamed(id, founderAmt, stakerAmt);
    }
    /// Attester stall > 24h past expiry ⇒ premium back verbatim.
    function refundAfterStall(uint256 id) external nonReentrant {
        Option_ storage o = options[id];
        require(o.state == 0, "settled");
        require(block.timestamp >= o.expiry + STALL_DELAY, "not stalled");
        o.state = 2;
        openPremiums -= o.premium;
        require(usdc.transfer(o.owner, o.premium), "refund out");
        emit ORefunded(id, o.premium);
        require(lanesIntact(), "lane drift");
    }

    function _enqueue(address who, uint256 amount, uint64 optionId) internal {
        payoutQueue.push(QueueEntry({ owner: who, amount: uint128(amount), optionId: optionId }));
        queueDebt += amount;
        queueOf[optionId] = payoutQueue.length; // entryId+1 for claimInfo()
        emit OQueued(payoutQueue.length - 1, optionId, who, amount);
    }
    function _payQueue(uint256 maxN) internal {
        uint256 n = maxN;
        while (n > 0 && queueHead < payoutQueue.length && pool > 0) {
            QueueEntry storage e = payoutQueue[queueHead];
            uint256 pay = e.amount > pool ? pool : e.amount;
            e.amount -= uint128(pay);
            pool -= pay;
            queueDebt -= pay;
            require(usdc.transfer(e.owner, pay), "queue out");
            emit ODequeued(queueHead, e.owner, pay);
            if (e.amount == 0) queueHead++;
            n--;
        }
    }
    function harvest(uint256 n) external nonReentrant {
        require(n > 0 && n <= HARVEST_MAX, "n bounds");
        _payQueue(n);
        require(lanesIntact(), "lane drift");
    }

    // ---------------- governance ----------------
    function setClassCfg(uint8 classId, uint32 maxMult2, uint64 payCap, bool enabled) external onlyOwner {
        require(maxMult2 >= MIN_MULT_X1E4 && maxMult2 <= MAX_MULT_X1E4, "class mult range");
        classCfg[classId] = ClassCfg(maxMult2, payCap, enabled);
        emit ParamSet("classCfg", uint256(classId));
    }
    function setQuoter(address qa) external onlyOwner { require(qa != address(0), "zero"); quoterSigner = qa; emit ParamSet("quoter", uint256(uint160(qa))); }
    function setRevenueSink(address s) external onlyOwner {
        revenueSink = s;
        require(usdc.approve(s, type(uint256).max), "approve");
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }
    function setFounderWallet(address f) external onlyOwner { founderWallet = f; emit ParamSet("founderWallet", uint256(uint160(f))); }
    function setPriceVerifier(address v) external onlyOwner { require(v != address(0), "zero"); priceVerifier = v; emit ParamSet("verifier", uint256(uint160(v))); }

    function _recoverSig(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "sig len");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
