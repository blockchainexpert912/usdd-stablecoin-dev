// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../PriceFeed.sol";

contract PriceFeedTester is PriceFeed {
    function setLastGoodPrice(address _collToken, uint256 _lastGoodPrice) external {
        priceFeeds[_collToken].lastGoodPrice = _lastGoodPrice;
    }

    function setStatus(address _collToken, Status _status) external {
        priceFeeds[_collToken].status = _status;
    }
}
