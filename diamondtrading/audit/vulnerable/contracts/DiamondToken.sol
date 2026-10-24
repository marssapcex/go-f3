// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DIAMOND — loss-receipt token of DiamondTrading (bootstrap transfer guard).
/// @notice Capped ERC20, minting restricted to the distributor (no house cursor can touch supply).
///         v2 adds a bootstrap transfer lock: while `transfersEnabled == false` tokens can move
///         only to/from allowlisted protocol contracts (stake/unstake/claim paths) or be burned.
///         This kills farm-exit during bootstrap: farmed tokens cannot be sold, only staked.
///         `enableTransfers()` is one-way and irreversible.
contract DiamondToken {
    string public constant name = "DiamondToken";
    string public constant symbol = "DIAMOND";
    uint8 public constant decimals = 18;
    uint256 public constant CAP = 1_000_000_000e18;

    uint256 public totalSupply;
    address public owner;
    address public minter; // distributor contract (budget-bounded)

    uint256 public transfersEnabled;                  // bootstrap: 0 = locked (uint avoids bool byte-packing)
    mapping(address => bool) public transferAllowlist; // protocol contracts (RevenueSplit, distributor…)

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner_, address indexed spender, uint256 value);
    event MinterSet(address indexed minter);
    event TransfersEnabled();
    event AllowlistSet(address indexed who, bool on);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() { owner = msg.sender; }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setMinter(address m) external onlyOwner { emit MinterSet(m); minter = m; }

    function setTransferAllowlist(address who, bool on) external onlyOwner {
        transferAllowlist[who] = on;
        emit AllowlistSet(who, on);
    }

    /// One-way: once transfers are open they can never be locked again.
    function enableTransfers() external onlyOwner {
        transfersEnabled = 1;
        emit TransfersEnabled();
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        require(totalSupply + amount <= CAP, "cap");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(transfersEnabled != 0 || transferAllowlist[from] || transferAllowlist[to], "transfers locked (bootstrap)");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
