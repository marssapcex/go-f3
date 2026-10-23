// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IDiamondToken {
    function mint(address to, uint256 amount) external;
    function totalSupply() external view returns (uint256);
}

/// @title DiamondDistributor v3 — anti-farm smart mint, COUNTER-CYCLICAL adaptive budget.
/// @notice Per-epoch (6h) merkle distributor for net-loss DIAMOND minting.
///
///           budget      = min( anchorUSD · rateBps / 1e4 · 1e20 / priceX1e8, epochCap )
///
///         The rate is NOT a fixed calendar schedule. It REACTS to the signed revenue anchor,
///         epoch over epoch, exactly the way launch economics demands:
///
///           launch:        rateBps starts at R_MAX = 20000 (200% of real revenue — bait phase:
///                          mint rich while the pool bootstraps).
///           growth:        anchorUSD > prevAnchorUsd  ⇒  rateBps −= STEP_DOWN (250 bps/epoch);
///                          sustained success tightens emission toward R_FLOOR (30%).
///           weakness:      anchorUSD < prevAnchorUsd  ⇒  rateBps += STEP_UP (1000 bps/epoch);
///                          shrinking revenue RE-OPENS the tap, aggressively, to win flow back.
///
///         anchorUSD  = off-chain realized fee+edge revenue, signed with the conversion price
///                      (EIP-191 over (epochId, anchorUSD, priceX1e8)). Emission can never exceed
///                      a rate-bounded multiple of REAL revenue — hedged long/short farms mint at
///                      most rateBps× the fees they burned themselves (and multi-account sybils
///                      only split the same fixed pie).
///         priceX1e8  = internal reference price during bootstrap (attester-signed); TWAP-chained
///                      after transfers open. Signed, never free-param.
///         An absolute per-epoch token cap (epochCap) bounds any anchor-inflation attempt.
contract DiamondDistributor {
    IDiamondToken public immutable diamond;
    address public owner;
    address public budgetAttester; // bonded off-chain accountant; signs (epoch, anchor, price)

    uint256 public constant BPS = 10_000;
    uint256 public constant R_MAX_BPS = 20_000;    // 200% launch/bait ceiling
    uint256 public constant R_FLOOR_BPS = 3_000;   // 30% tighten floor
    uint256 public constant STEP_DOWN_BPS = 250;   // tighten per growth epoch (slow grind)
    uint256 public constant STEP_UP_BPS = 1_000;   // ease per weak epoch (fast re-bait)
    uint256 public constant MAX_EPOCH_GAP = 7 days;

    uint256 public rateBps = R_MAX_BPS;     // starts rich (bootstrap)
    uint256 public prevAnchorUsd;           // last epoch's signed anchor (reaction reference)

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

    constructor(address _diamond) {
        require(_diamond != address(0), "zero");
        diamond = IDiamondToken(_diamond);
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

    /// Rate the NEXT posted epoch will use (adaptive, anchor-reactive):
    /// anchor grew  → tighten by STEP_DOWN (floor R_FLOOR); anchor fell → ease by STEP_UP (cap R_MAX).
    function projectedRateBps(uint256 anchorUsd) public view returns (uint256 r) {
        r = rateBps;
        if (lastEpoch > 0) { // epoch 1 keeps the launch rate (no prior anchor to compare)
            if (anchorUsd > prevAnchorUsd) {
                r = r > R_FLOOR_BPS + STEP_DOWN_BPS ? r - STEP_DOWN_BPS : R_FLOOR_BPS;
            } else if (anchorUsd < prevAnchorUsd) {
                r = r > R_MAX_BPS - STEP_UP_BPS ? R_MAX_BPS : r + STEP_UP_BPS;
            }
        }
    }

    /// Max mintable DIAMOND (18d) for (anchorUsd 6d, price 1e8) at the rate that posting would apply.
    function budgetFor(uint256 anchorUsd, uint256 priceX1e8) public view returns (uint256) {
        require(priceX1e8 > 0, "price zero");
        uint256 usdBudget = anchorUsd * projectedRateBps(anchorUsd) / BPS; // still 6-dec USDC
        uint256 tokens = usdBudget * 1e20 / priceX1e8;                     // 6+20−8 = 18 dec
        return tokens > epochCap ? epochCap : tokens;
    }

    /// @param anchorUsd realized fee+edge anchor for the epoch (USDC, 6dp).
    /// @param priceX1e8 signed conversion price (USDC per DIAMOND ×1e8).
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
        uint256 budget = budgetFor(anchorUsd, priceX1e8);   // uses projected (adaptive) rate
        require(totalMint <= budget, "over budget");        // rate×anchor AND absolute cap
        // adapt AFTER the epoch's budget was computed at the projected rate:
        rateBps = projectedRateBps(anchorUsd);
        prevAnchorUsd = anchorUsd;
        epochs[epochId] = Epoch(root, totalMint, uint64(block.timestamp));
        lastEpoch = epochId;
        emit EpochPosted(epochId, root, totalMint, rateBps, anchorUsd, priceX1e8, budget);
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
        diamond.mint(msg.sender, amount);
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
