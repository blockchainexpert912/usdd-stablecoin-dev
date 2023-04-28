// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IPool.sol";

interface IDefaultPool is IPool {
    // --- Events ---
    event TroveManagerAddressSet(address _newTroveManagerAddress);
    event DefaultPoolUSDDDebtUpdated(uint256 _USDDDebt);
    event DefaultPoolBalanceUpdated(address _collToken, uint256 _amount);

    // --- Functions ---
    function sendToActivePool(address _collToken, uint256 _amount) external;

    function receiveColl(address _collToken, uint256 _amount) external;
}
