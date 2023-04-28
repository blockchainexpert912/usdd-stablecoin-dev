// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IPriceFeed.sol";

/*
 * PriceFeed placeholder for testnet and development. The price is simply set manually and saved in a state
 * variable. The contract does not connect to a live Chainlink price feed.
 */
contract PriceFeedTestnet is IPriceFeed {
    mapping(address => uint256) private _prices;
    uint256 private _price = 200 * 1e18;

    // --- Functions ---

    function getPrice() external view returns (uint256) {
        return _price;
    }

    // View price getter for simplicity in tests
    function getPrice(address _collToken) external view returns (uint256) {
        return _prices[_collToken];
    }

    function fetchPrice(address _collToken) external override returns (uint256) {
        uint256 result = _prices[_collToken];
        if (result > 0) {
            return result;
        }
        return _price;
    }

    // Manual external price setter.
    function setPrice(address _collToken, uint256 price) external returns (bool) {
        _prices[_collToken] = price;
        return true;
    }

    function setPrice(uint256 price) external returns (bool) {
        _price = price;
    }

    function lastGoodPrice(address _collToken) external view override returns (uint256) {
        uint256 result = _prices[_collToken];
        if (result > 0) {
            return result;
        }
        return _price;
    }

    function status(address _collToken) external view override returns (Status) {
        return Status.chainlinkWorking;
    }
}
