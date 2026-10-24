// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only sink that reports active stake but refuses to pull notified revenue.
contract NonPullSink {
    uint256 public totalStaked = 1;
    function notifyRevenue(uint256) external {}
}
