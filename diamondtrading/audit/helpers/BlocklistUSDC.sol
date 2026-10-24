// SPDX-License-Identifier: MIT
// PoC-only helper. Models a real-world USDC-style token with an admin blocklist:
// transfers to/from a blocked address REVERT (as Circle's FiatToken does). Used to test
// whether one reverting payee can stall the protocol's push-payment queue.
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
    function mint(address to, uint256 amt) external { totalSupply += amt; balanceOf[to] += amt; }
    function setBlocked(address who, bool on) external { require(msg.sender == admin, "admin"); blocked[who] = on; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) { require(al >= a, "allowance"); allowance[f][msg.sender] = al - a; }
        _move(f, t, a); return true;
    }
    function _move(address f, address t, uint256 a) internal {
        require(!blocked[f] && !blocked[t], "blocked");
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a; balanceOf[t] += a;
    }
}
