// SPDX-License-Identifier: MIT
// Test-only USDC model whose admin can block addresses. Transfers involving a blocked
// address revert, matching the queue-griefing condition exercised by security.test.js.
pragma solidity 0.8.26;

contract BlocklistUSDC {
    string public constant name = "Blocklist USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    address public admin;

    constructor() { admin = msg.sender; }
    function mint(address to, uint256 amount) external { totalSupply += amount; balanceOf[to] += amount; }
    function setBlocked(address who, bool on) external { require(msg.sender == admin, "admin"); blocked[who] = on; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) { require(allowed >= amount, "allowance"); allowance[from][msg.sender] = allowed - amount; }
        _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        require(!blocked[from] && !blocked[to], "blocked");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}
