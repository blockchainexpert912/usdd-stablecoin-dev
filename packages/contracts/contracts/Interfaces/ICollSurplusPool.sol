// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface ICollSurplusPool {
    // --- Events ---

    event BorrowerOperationsAddressSet(address _newBorrowerOperationsAddress);
    event TroveManagerAddressSet(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);

    event CollBalanceUpdated(address indexed _account, address _collToken, uint256 _newBalance);
    event CollSent(address _to, address _collToken, uint256 _amount);

    // --- Contract setters ---

    function receiveColl(address _collToken, uint256 _amount) external;

    function setAddresses(
        address[] calldata _collTokens,
        address[] calldata _troveManagerAddresses,
        address[] calldata _borrowerOperationsAddresses,
        address _activePoolAddress
    ) external;

    function getColl(address _collToken) external view returns (uint256);

    function getCollateral(address _account, address _collToken) external view returns (uint256);

    function accountSurplus(
        address _account,
        address _collToken,
        uint256 _amount
    ) external;

    function claimColl(
        address _account,
        address _to,
        address _collToken
    ) external;
}
