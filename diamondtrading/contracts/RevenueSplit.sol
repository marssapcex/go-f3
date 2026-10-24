// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20MinR {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @title RevenueSplit — DIAMOND staking pool receiving the stakers' share of REALIZED
/// positive diamond in USDC. Cash-basis only: the house pushes USDC in via notifyRevenue();
/// nothing here is ever read INTO the house's solvency accounting (one-directional flow,
/// audit lesson H-01/H-02/KV-06: no cross-domain cursors).
/// Authorized House/Options engines pull-transfer their own USDC into this contract atomically.
/// Per-win fee streams and the owner's surplus waterfall share the same cumulative-index rewards.
///
/// AUDIT FIXES (audit/report):
///  F-02 (JIT): revenue is STREAMED linearly over DURATION (7 days) instead of being credited
///       instantly to whoever is staked at notify time. A stake added right before a settlement
///       earns only its pro-rata share of the stream, and nothing if it leaves before accruing.
///  F-13 (stranded): revenue notified while nobody is staked is carried and starts streaming as
///       soon as the first staker arrives (never stranded). Stream time does not elapse while
///       totalStaked == 0 (the stream is paused, not lost).
///  F-11: a token-level refusal to pay a reward does not revert the staker's exit; it is credited.
contract RevenueSplit {
    IERC20MinR public immutable usdc;
    IERC20MinR public immutable diamond;
    address public owner;
    address public house;           // primary house may push revenue
    mapping(address => bool) public pusher;  // additional payout engines (options…) allowed to push

    uint64 public constant UNBOND_DELAY = 7 days;
    uint64 public constant DURATION = 7 days;   // F-02: reward stream length
    uint256 public constant SEND_GAS_FLOOR = 60_000;

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    // reward accrual index, 1e36-scaled: index units per DIAMOND-wei. 1e36 (not 1e18) keeps the
    // flooring error below 1 base unit per claim; at 1e18 it reached ~staked/1e18 base units.
    uint256 public constant SCALE = 1e36;
    uint256 public rewardIndex;
    mapping(address => uint256) public userIndex;

    // streaming state (F-02)
    uint256 public rewardRate;      // USDC base units × SCALE per second
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public carry;           // F-13: revenue waiting for the first staker (USDC base units)

    // F-11: credits for refused payouts
    mapping(address => uint256) public credits;
    uint256 public totalCredits;

    struct Unbond { uint256 amount; uint64 availableAt; }
    mapping(address => Unbond) public unbonding;

    uint256 private _locked = 1;
    modifier nonReentrant() { require(_locked == 1, "reent"); _locked = 2; _; _locked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Staked(address indexed who, uint256 amount);
    event UnbondRequested(address indexed who, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed who, uint256 amount);
    event RevenueNotified(uint256 amount, uint256 newIndex);
    event RevenueCarried(uint256 amount);
    event RewardClaimed(address indexed who, uint256 amount);
    event Credited(address indexed who, uint256 amount);
    event CreditWithdrawn(address indexed who, uint256 amount);
    event HouseSet(address indexed house);
    event PusherSet(address indexed who, bool allowed);

    constructor(address _usdc, address _diamond) {
        usdc = IERC20MinR(_usdc);
        diamond = IERC20MinR(_diamond);
        owner = msg.sender;
    }

    function setHouse(address h) external onlyOwner { require(h != address(0), "zero"); house = h; emit HouseSet(h); }
    function setPusher(address h, bool allowed) external onlyOwner { pusher[h] = allowed; emit PusherSet(h, allowed); }

    // ---------------- streaming core ----------------

    /// Bring the index up to now. Must run before any change to totalStaked.
    function _update() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs <= lastUpdate) return;
        if (totalStaked == 0) {
            // paused: the stream's remaining time is preserved, not consumed by nobody
            if (periodFinish > lastUpdate) periodFinish += nowTs - lastUpdate;
            lastUpdate = nowTs;
            return;
        }
        uint256 t = nowTs < periodFinish ? nowTs : periodFinish;
        if (t > lastUpdate) rewardIndex += rewardRate * (t - lastUpdate) / totalStaked;
        lastUpdate = nowTs;
    }

    /// Add `amt` (plus any carry) to the running stream, keeping the unfinished remainder.
    function _addToStream(uint256 amt) internal {
        amt += carry; carry = 0;
        if (amt == 0) return;
        uint256 leftover = block.timestamp < periodFinish
            ? rewardRate * (periodFinish - block.timestamp) : 0;
        rewardRate = (amt * SCALE + leftover) / DURATION;
        periodFinish = block.timestamp + DURATION;
        lastUpdate = block.timestamp;
    }

    function _currentIndex() internal view returns (uint256 idx) {
        idx = rewardIndex;
        if (totalStaked > 0 && block.timestamp > lastUpdate) {
            uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
            if (t > lastUpdate) idx += rewardRate * (t - lastUpdate) / totalStaked;
        }
    }

    // ---------------- user actions ----------------

    function stake(uint256 amount) external nonReentrant {
        _settleReward(msg.sender);                 // also runs _update()
        require(diamond.transferFrom(msg.sender, address(this), amount), "pay");
        staked[msg.sender] += amount;
        totalStaked += amount;
        if (carry > 0) _addToStream(0);            // F-13: first staker starts the carried stream
        emit Staked(msg.sender, amount);
    }

    function requestUnbond(uint256 amount) external {
        _settleReward(msg.sender);
        require(staked[msg.sender] >= amount, "staked");
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        Unbond storage u = unbonding[msg.sender];
        u.amount += amount;
        u.availableAt = uint64(block.timestamp + UNBOND_DELAY);
        emit UnbondRequested(msg.sender, amount, u.availableAt);
    }

    function withdrawUnbonded() external nonReentrant {
        Unbond storage u = unbonding[msg.sender];
        require(u.amount > 0 && block.timestamp >= u.availableAt, "not ready");
        uint256 amt = u.amount;
        delete unbonding[msg.sender];
        require(diamond.transfer(msg.sender, amt), "diamond out");
        emit Withdrawn(msg.sender, amt);
    }

    /// Authorized engines only; pulls exactly `amount` from msg.sender (House or Options).
    function notifyRevenue(uint256 amount) external {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        _update();
        if (totalStaked > 0) {
            _addToStream(amount);
        } else {
            carry += amount;                        // F-13: never stranded
            emit RevenueCarried(amount);
        }
        emit RevenueNotified(amount, rewardIndex);
    }

    function claimable(address who) external view returns (uint256) {
        return staked[who] * (_currentIndex() - userIndex[who]) / SCALE + credits[who];
    }

    function claimReward() external nonReentrant {
        _settleReward(msg.sender);
    }

    function withdrawCredit() external nonReentrant {
        uint256 a = credits[msg.sender];
        require(a > 0, "no credit");
        credits[msg.sender] = 0;
        totalCredits -= a;
        require(usdc.transfer(msg.sender, a), "credit out");
        emit CreditWithdrawn(msg.sender, a);
    }

    function _settleReward(address who) internal {
        _update();
        uint256 owed = staked[who] * (rewardIndex - userIndex[who]) / SCALE;
        userIndex[who] = rewardIndex;
        if (owed > 0) _send(who, owed);
    }

    /// F-11: a refused transfer is credited instead of reverting (exit can never be blocked).
    function _send(address to, uint256 amount) internal {
        require(gasleft() >= SEND_GAS_FLOOR, "send gas");   // see DiamondHouse._send
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20MinR.transfer.selector, to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
            emit RewardClaimed(to, amount);
            return;
        }
        credits[to] += amount;
        totalCredits += amount;
        emit Credited(to, amount);
    }
}
