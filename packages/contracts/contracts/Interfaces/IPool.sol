// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

// Common interface for the Pools.
interface IPool {
    // --- Events ---

    event ETHBalanceUpdated(uint256 _newBalance);
    event USDDBalanceUpdated(uint256 _newBalance);
    event ActivePoolAddressChanged(address _newActivePoolAddress);
    event DefaultPoolAddressChanged(address _newDefaultPoolAddress);
    event StabilityPoolAddressChanged(address _newStabilityPoolAddress);
    event CollTokenSent(address _to, address _collToken, uint256 _amount);

    // --- Functions ---

    function getColl(address _collToken) external view returns (uint256);

    function getUSDDDebt() external view returns (uint256);

    function increaseUSDDDebt(uint256 _amount) external;

    function decreaseUSDDDebt(uint256 _amount) external;
}
