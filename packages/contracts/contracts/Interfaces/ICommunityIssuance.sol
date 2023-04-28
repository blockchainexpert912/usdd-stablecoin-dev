// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface ICommunityIssuance {
    // --- Events ---

    event DEFTTokenAddressSet(address _deftTokenAddress);
    event StabilityPoolAddressSet(address _stabilityPoolAddress);
    event TotalDEFTIssuedUpdated(uint256 _totalDEFTIssued);

    // --- Functions ---

    function start(uint256 DEFTSupplyCap) external;

    function setAddresses(address _deftTokenAddress, address _stabilityPoolAddress) external;

    function issueDEFT() external returns (uint256);

    function sendDEFT(address _account, uint256 _DEFTamount) external;
}
