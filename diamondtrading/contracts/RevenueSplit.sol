// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20MinR {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @title RevenueSplit — DIAMOND staking with time-streamed USDC rewards.
/// Authorized House/Options engines pull their own USDC into this contract atomically.
/// Revenue accrues over DURATION instead of being credited instantly to whoever stake-front-runs
/// a settlement. Revenue with no active staker is rejected so cash stays in the source House;
/// there is no carry that would gift old revenue to a later staker. If the last staker leaves,
/// an unfinished stream pauses and resumes when someone stakes again.
contract RevenueSplit {
    IERC20MinR public immutable usdc;
    IERC20MinR public immutable diamond;
    address public owner;
    address public house;
    mapping(address => bool) public pusher;

    uint64 public constant UNBOND_DELAY = 7 days;
    uint64 public constant DURATION = 7 days;
    uint256 public constant SCALE = 1e36;
    uint256 public constant SEND_GAS_FLOOR = 60_000;

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    // USDC-base-units × SCALE per DIAMOND-wei. The large scale limits index-rounding dust.
    uint256 public rewardIndex;
    mapping(address => uint256) public userIndex;
    uint256 public rewardRate;      // USDC base units × SCALE per second
    uint256 public periodFinish;
    uint256 public lastUpdate;

    // USDC refunds refused by the token (for example a blocklist) remain claimable later.
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
    event RewardClaimed(address indexed who, uint256 amount);
    event Credited(address indexed who, uint256 amount);
    event CreditWithdrawn(address indexed who, uint256 amount);
    event HouseSet(address indexed house);
    event PusherSet(address indexed who, bool allowed);

    constructor(address _usdc, address _diamond) {
        require(_usdc != address(0) && _diamond != address(0), "zero");
        usdc = IERC20MinR(_usdc);
        diamond = IERC20MinR(_diamond);
        owner = msg.sender;
    }

    function setHouse(address h) external onlyOwner { require(h != address(0), "zero"); house = h; emit HouseSet(h); }
    function setPusher(address h, bool allowed) external onlyOwner { pusher[h] = allowed; emit PusherSet(h, allowed); }

    /// Bring the global index up to now before every stake-weight change.
    function _update() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs <= lastUpdate) return;
        if (totalStaked == 0) {
            // Preserve the remaining stream duration while nobody can earn it.
            if (periodFinish > lastUpdate) periodFinish += nowTs - lastUpdate;
            lastUpdate = nowTs;
            return;
        }
        uint256 t = nowTs < periodFinish ? nowTs : periodFinish;
        if (t > lastUpdate) rewardIndex += rewardRate * (t - lastUpdate) / totalStaked;
        lastUpdate = nowTs;
    }

    function _currentIndex() internal view returns (uint256 idx) {
        idx = rewardIndex;
        if (totalStaked > 0 && block.timestamp > lastUpdate) {
            uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
            if (t > lastUpdate) idx += rewardRate * (t - lastUpdate) / totalStaked;
        }
    }

    /// Add cash while preserving the unfinished remainder of the previous stream.
    function _addToStream(uint256 amount) internal {
        uint256 leftover = block.timestamp < periodFinish
            ? rewardRate * (periodFinish - block.timestamp) : 0;
        rewardRate = (amount * SCALE + leftover) / DURATION;
        periodFinish = block.timestamp + DURATION;
        lastUpdate = block.timestamp;
    }

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
        uint256 amount = u.amount;
        delete unbonding[msg.sender];
        require(diamond.transfer(msg.sender, amount), "diamond out");
        emit Withdrawn(msg.sender, amount);
    }

    /// Authorized engines only; pulls exactly amount from msg.sender (House or Options).
    function notifyRevenue(uint256 amount) external nonReentrant {
        require(msg.sender == house || pusher[msg.sender], "not house");
        require(amount > 0, "zero revenue");
        require(totalStaked > 0, "no stakers"); // source House retains no-staker revenue
        _update();
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        _addToStream(amount);
        emit RevenueNotified(amount, rewardIndex);
    }

    function claimable(address who) external view returns (uint256) {
        return staked[who] * (_currentIndex() - userIndex[who]) / SCALE + credits[who];
    }

    function claimReward() external nonReentrant {
        _settleReward(msg.sender);
        _withdrawCredit(msg.sender);
    }

    function withdrawCredit() external nonReentrant { _withdrawCredit(msg.sender); }

    function _withdrawCredit(address who) internal {
        uint256 amount = credits[who];
        if (amount == 0) return;
        credits[who] = 0;
        totalCredits -= amount;
        require(usdc.transfer(who, amount), "credit out");
        emit CreditWithdrawn(who, amount);
    }

    function _settleReward(address who) internal {
        _update();
        uint256 owed = staked[who] * (rewardIndex - userIndex[who]) / SCALE;
        userIndex[who] = rewardIndex;
        if (owed > 0) _send(who, owed);
    }

    /// A refused USDC transfer is credited rather than blocking that staker's exit.
    function _send(address to, uint256 amount) internal {
        require(gasleft() >= SEND_GAS_FLOOR, "send gas");
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20MinR.transfer.selector, to, amount));
        if (ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))))) {
            emit RewardClaimed(to, amount);
            return;
        }
        credits[to] += amount;
        totalCredits += amount;
        emit Credited(to, amount);
    }
}
