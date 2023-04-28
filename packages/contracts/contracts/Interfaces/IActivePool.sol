// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IPool.sol";

interface IActivePool is IPool {
    // --- Events ---
    event BorrowerOperationsAddressSet(address _newBorrowerOperationsAddress);
    event TroveManagerAddressSet(address _newTroveManagerAddress);
    event ActivePoolUSDDDebtUpdated(uint256 _USDDDebt);
    event ActivePoolBalanceUpdated(address _collToken, uint256 _amount);

    // --- Functions ---
    function sendColl(
        address _account,
        address _collToken,
        uint256 _amount
    ) external;

    function receiveColl(address _collToken, uint256 _amount) external;
}
