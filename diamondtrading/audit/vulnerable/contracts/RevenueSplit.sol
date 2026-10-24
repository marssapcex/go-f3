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
contract RevenueSplit {
    IERC20MinR public immutable usdc;
    IERC20MinR public immutable diamond;
    address public owner;
    address public house;           // primary house may push revenue
    mapping(address => bool) public pusher;  // additional payout engines (options…) allowed to push

    uint64 public constant UNBOND_DELAY = 7 days;

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    // reward accrual index (1e18-scaled USDC per 1 DIAMOND staked)
    uint256 public rewardIndex;
    mapping(address => uint256) public userIndex;

    struct Unbond { uint256 amount; uint64 availableAt; }
    mapping(address => Unbond) public unbonding;

    uint256 private _locked = 1;
    modifier nonReentrant() { require(_locked == 1, "reent"); _locked = 2; _; _locked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Staked(address indexed who, uint256 amount);
    event UnbondRequested(address indexed who, uint256 amount, uint64 availableAt);
    event Withdrawn(address indexed who, uint256 amount);
    event RevenueNotified(uint256 amount, uint256 newIndex);
    event RewardClaimed(address indexed who, uint256 amount);
    event HouseSet(address indexed house);
    event PusherSet(address indexed who, bool allowed);

    constructor(address _usdc, address _diamond) {
        usdc = IERC20MinR(_usdc);
        diamond = IERC20MinR(_diamond);
        owner = msg.sender;
    }

    function setHouse(address h) external onlyOwner { require(h != address(0), "zero"); house = h; emit HouseSet(h); }
    function setPusher(address h, bool allowed) external onlyOwner { pusher[h] = allowed; emit PusherSet(h, allowed); }

    function stake(uint256 amount) external nonReentrant {
        _settleReward(msg.sender);
        require(diamond.transferFrom(msg.sender, address(this), amount), "pay");
        staked[msg.sender] += amount;
        totalStaked += amount;
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

    /// Authorized engines only; pulls amount from msg.sender (House or Options).
    function notifyRevenue(uint256 amount) external {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        if (totalStaked > 0) {
            rewardIndex += amount * 1e18 / totalStaked;
        }
        emit RevenueNotified(amount, rewardIndex);
    }

    function claimable(address who) external view returns (uint256) {
        uint256 idx = rewardIndex;
        return staked[who] * (idx - userIndex[who]) / 1e18;
    }

    function claimReward() external nonReentrant {
        _settleReward(msg.sender);
    }

    function _settleReward(address who) internal {
        uint256 owed = staked[who] * (rewardIndex - userIndex[who]) / 1e18;
        userIndex[who] = rewardIndex;
        if (owed > 0) {
            require(usdc.transfer(who, owed), "reward out");
            emit RewardClaimed(who, owed);
        }
    }
}
