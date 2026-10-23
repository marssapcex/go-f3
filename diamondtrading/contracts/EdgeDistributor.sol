// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IEdgeToken {
    function mint(address to, uint256 amount) external;
    function totalSupply() external view returns (uint256);
}

/// @title EdgeDistributor v2 — anti-farm smart mint, time-decayed budget (replaces SRI throttle).
/// @notice Per-epoch (6h) merkle distributor for net-loss EDGE minting.
///         Budget rule per epoch e (seconds-based epoch counter, sequential on-chain id):
///
///           r(e)        = max(R0 − (R0 − R_FLOOR)·e/N_DECAY, R_FLOOR)   [bps of anchor]
///           usdBudget   = anchorUSD · r(e) / 1e4        (6-dec USDC units)
///           tokenBudget = usdBudget · 1e20 / priceX1e8  (18-dec EDGE)
///
///         anchorUSD  = OFF-CHAIN realized fee+edge revenue of the epoch, signed by the
///                      budgetAttester together with the conversion price (EIP-191 over
///                      (epochId, anchorUSD, priceX1e8)). Emission can therefore never exceed
///                      a schedule-bounded multiple of REAL revenue — hedged long/short farms
///                      mint at most r(e)× the fees they burned themselves.
///         priceX1e8  = internal reference price, p0 with deterministic per-epoch decay during
///                      bootstrap; TWAP-chained after transfers open. Signed, never free-param.
///         An absolute per-epoch token cap (epochCap, 0.5%-of-genesis-scale by default)
///                      bounds any anchor-inflation attempt.
///         The v1 SRI/solvency throttle is REMOVED: pool=0 must throttle nothing (bootstrap).
contract EdgeDistributor {
    IEdgeToken public immutable edge;
    address public owner;
    address public budgetAttester; // bonded off-chain accountant; signs (epoch, anchor, price)

    uint256 public constant BPS = 10_000;
    uint256 public constant R0_BPS = 20_000;   // 200% of anchor at launch (bootstrap)
    uint256 public constant R_FLOOR_BPS = 3_000; // 30% of anchor, forever after decay
    uint256 public constant N_DECAY = 360;     // epochs (6h each ⇒ 90 days) to reach floor
    uint256 public constant MAX_EPOCH_GAP = 7 days;

    uint256 public epochCap = 2_000_000e18;      // absolute per-epoch mint cap (≈0.5% genesis scale)
    uint256 public constant EPOCH_CAP_CEILING = 5_000_000e18;

    struct Epoch { bytes32 root; uint256 totalMint; uint64 postedAt; }
    mapping(uint256 => Epoch) public epochs;
    uint256 public lastEpoch;
    mapping(uint256 => mapping(address => bool)) public claimed;
    uint256 public totalMinted;

    event EpochPosted(uint256 indexed epochId, bytes32 root, uint256 totalMint,
                      uint256 rateBps, uint256 anchorUsd, uint256 priceX1e8, uint256 budget);
    event Claimed(uint256 indexed epochId, address indexed account, uint256 amount);
    event BudgetAttesterSet(address indexed who);
    event EpochCapSet(uint256 cap);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _edge) {
        require(_edge != address(0), "zero");
        edge = IEdgeToken(_edge);
        owner = msg.sender;
    }

    function setBudgetAttester(address who) external onlyOwner {
        budgetAttester = who;
        emit BudgetAttesterSet(who);
    }
    function setEpochCap(uint256 c) external onlyOwner {
        require(c <= EPOCH_CAP_CEILING, "cap ceiling");
        epochCap = c;
        emit EpochCapSet(c);
    }

    /// r(e) in bps of anchor: 20000 → 3000 linearly over N_DECAY epochs, then floor forever.
    function rateBps(uint256 epochId) public pure returns (uint256) {
        if (epochId >= N_DECAY) return R_FLOOR_BPS;
        return R0_BPS - (R0_BPS - R_FLOOR_BPS) * epochId / N_DECAY;
    }

    /// Max mintable EDGE (18d) for (anchorUsd 6d, price 1e8) at this epoch's rate; after both caps.
    function budgetFor(uint256 epochId, uint256 anchorUsd, uint256 priceX1e8) public view returns (uint256) {
        require(priceX1e8 > 0, "price zero");
        uint256 usdBudget = anchorUsd * rateBps(epochId) / BPS;      // still 6-dec USDC
        uint256 tokens = usdBudget * 1e20 / priceX1e8;               // 6+20−8 = 18 dec
        return tokens > epochCap ? epochCap : tokens;
    }

    /// @param anchorUsd realized fee+edge anchor for the epoch (USDC, 6dp).
    /// @param priceX1e8 signed conversion price (USDC per EDGE ×1e8).
    /// @param budgetSig EIP-191 personal sign by budgetAttester over (epochId, anchorUsd, priceX1e8).
    function postEpoch(
        uint256 epochId,
        bytes32 root,
        uint256 totalMint,
        uint256 anchorUsd,
        uint256 priceX1e8,
        bytes calldata budgetSig
    ) external onlyOwner {
        require(epochId == lastEpoch + 1, "epoch order");
        require(epochs[epochId].root == bytes32(0), "posted");
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",
                        keccak256(abi.encode(epochId, anchorUsd, priceX1e8))));
        require(_rec(h, budgetSig) == budgetAttester, "bad budget sig");
        uint256 budget = budgetFor(epochId, anchorUsd, priceX1e8);
        require(totalMint <= budget, "over budget"); // r(e)×anchor AND absolute cap — the whole point
        epochs[epochId] = Epoch(root, totalMint, uint64(block.timestamp));
        lastEpoch = epochId;
        emit EpochPosted(epochId, root, totalMint, rateBps(epochId), anchorUsd, priceX1e8, budget);
    }

    function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof) external {
        Epoch storage e = epochs[epochId];
        require(e.root != bytes32(0), "no epoch");
        require(block.timestamp <= e.postedAt + MAX_EPOCH_GAP, "claim window closed");
        require(!claimed[epochId][msg.sender], "claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, msg.sender, amount))));
        require(_verify(leaf, e.root, proof), "bad proof");
        claimed[epochId][msg.sender] = true;
        totalMinted += amount;
        edge.mint(msg.sender, amount);
        emit Claimed(epochId, msg.sender, amount);
    }

    // ---- merkle verification (OZ-style, sorted pairs) ----
    function _verify(bytes32 leaf, bytes32 root, bytes32[] calldata proof) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function _rec(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function transferOwnership(address n) external onlyOwner { require(n != address(0), "zero"); owner = n; }
}
