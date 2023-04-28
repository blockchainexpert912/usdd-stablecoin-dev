// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface IPriceFeed {
    enum Status {
        chainlinkWorking,
        usingTellorChainlinkUntrusted,
        bothOraclesUntrusted,
        usingTellorChainlinkFrozen,
        usingChainlinkTellorUntrusted
    }
    // --- Events ---
    event LastGoodPriceUpdated(address _collToken, uint256 _lastGoodPrice);

    // --- Function ---
    function fetchPrice(address _collToken) external returns (uint256);

    function lastGoodPrice(address _collToken) external view returns (uint256);

    function status(address _collToken) external view returns (Status);
}
