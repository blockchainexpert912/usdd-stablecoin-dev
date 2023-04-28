// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IPriceFeed.sol";
import "./Interfaces/ITellorCaller.sol";
import "./Dependencies/AggregatorV3Interface.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/BaseMath.sol";
import "./Dependencies/LiquityMath.sol";
// import "./Dependencies/console.sol";

/*
 * PriceFeed for mainnet deployment, to be connected to Chainlink's live ETH:USD aggregator reference
 * contract, and a wrapper contract TellorCaller, which connects to TellorMaster contract.
 *
 * The PriceFeed uses Chainlink as primary oracle, and Tellor as fallback. It contains logic for
 * switching oracles based on oracle failures, timeouts, and conditions for returning to the primary
 * Chainlink oracle.
 */
contract PriceFeed is Ownable, CheckContract, BaseMath, IPriceFeed {
    using SafeMath for uint256;

    string public constant NAME = "PriceFeed";

    struct PriceFeeds {
        AggregatorV3Interface priceAggregator; // Mainnet Chainlink aggregator
        ITellorCaller tellorCaller; // Wrapper contract that calls the Tellor system
        uint256 lastGoodPrice; // The last good price seen from an oracle by Liquity
        Status status; // The current status of the PricFeed, which determines the conditions for the next price fetch attempt
    }

    mapping(address => PriceFeeds) public priceFeeds;

    // Core Liquity contracts
    address borrowerOperationsAddress;
    address troveManagerAddress;

    uint256 public constant ETHUSD_TELLOR_REQ_ID = 1;

    // Use to convert a price answer to an 18-digit precision uint
    uint256 public constant TARGET_DIGITS = 18;
    uint256 public constant TELLOR_DIGITS = 6;

    // Maximum time period allowed since Chainlink's latest round data timestamp, beyond which Chainlink is considered frozen.
    uint256 public constant TIMEOUT = 14400; // 4 hours: 60 * 60 * 4

    // Maximum deviation allowed between two consecutive Chainlink oracle prices. 18-digit precision.
    uint256 public constant MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND = 5e17; // 50%

    /*
     * The maximum relative price difference between two oracle responses allowed in order for the PriceFeed
     * to return to using the Chainlink oracle. 18-digit precision.
     */
    uint256 public constant MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES = 5e16; // 5%

    struct ChainlinkResponse {
        uint80 roundId;
        int256 answer;
        uint256 timestamp;
        bool success;
        uint8 decimals;
    }

    struct TellorResponse {
        bool ifRetrieve;
        uint256 value;
        uint256 timestamp;
        bool success;
    }

    event LastGoodPriceUpdated(address _collToken, uint256 _lastGoodPrice);
    event PriceFeedStatusChanged(address _collToken, Status newStatus);

    // --- Dependency setters ---

    function setAddresses(
        address _collToken,
        address _priceAggregatorAddress,
        address _tellorCallerAddress
    ) external onlyOwner {
        checkContract(_priceAggregatorAddress);
        checkContract(_tellorCallerAddress);
        PriceFeeds storage priceFeed = priceFeeds[_collToken];
        AggregatorV3Interface _priceAggregator = AggregatorV3Interface(_priceAggregatorAddress);
        priceFeed.priceAggregator = _priceAggregator;
        priceFeed.tellorCaller = ITellorCaller(_tellorCallerAddress);

        // Explicitly set initial system status
        priceFeed.status = Status.chainlinkWorking;

        // Get an initial price from Chainlink to serve as first reference for lastGoodPrice
        ChainlinkResponse memory chainlinkResponse = _getCurrentChainlinkResponse(_priceAggregator);
        ChainlinkResponse memory prevChainlinkResponse = _getPrevChainlinkResponse(
            _priceAggregator,
            chainlinkResponse.roundId,
            chainlinkResponse.decimals
        );

        require(
            !_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse) &&
                !_chainlinkIsFrozen(chainlinkResponse),
            "PriceFeed: Chainlink must be working and current"
        );

        _storeChainlinkPrice(_collToken, chainlinkResponse);

        _renounceOwnership();
    }

    // --- Functions ---

    function _requirePriceFeedExist(address _collToken) internal view returns (bool) {
        PriceFeeds memory priceFeed = priceFeeds[_collToken];
        require(
            address(priceFeed.priceAggregator) != address(0) &&
                address(priceFeed.tellorCaller) != address(0),
            "PriceFeed: Chainlink and Tellor can not be zero address"
        );
    }

    /*
     * fetchPrice():
     * Returns the latest price obtained from the Oracle. Called by Liquity functions that require a current price.
     *
     * Also callable by anyone externally.
     *
     * Non-view function - it stores the last good price seen by Liquity.
     *
     * Uses a main oracle (Chainlink) and a fallback oracle (Tellor) in case Chainlink fails. If both fail,
     * it uses the last good price seen by Liquity.
     *
     */
    function fetchPrice(address _collToken) external override returns (uint256) {
        _requirePriceFeedExist(_collToken);
        PriceFeeds memory priceFeed = priceFeeds[_collToken];

        // Get current and previous price data from Chainlink, and current price data from Tellor

        ChainlinkResponse memory chainlinkResponse = _getCurrentChainlinkResponse(
            priceFeed.priceAggregator
        );
        ChainlinkResponse memory prevChainlinkResponse = _getPrevChainlinkResponse(
            priceFeed.priceAggregator,
            chainlinkResponse.roundId,
            chainlinkResponse.decimals
        );
        TellorResponse memory tellorResponse = _getCurrentTellorResponse(priceFeed.tellorCaller);

        // --- CASE 1: System fetched last price from Chainlink  ---
        if (priceFeed.status == Status.chainlinkWorking) {
            // If Chainlink is broken, try Tellor
            if (_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse)) {
                // If Tellor is broken then both oracles are untrusted, so return the last good price
                if (_tellorIsBroken(tellorResponse)) {
                    _changeStatus(_collToken, Status.bothOraclesUntrusted);
                    return priceFeed.lastGoodPrice;
                }
                /*
                 * If Tellor is only frozen but otherwise returning valid data, return the last good price.
                 * Tellor may need to be tipped to return current data.
                 */
                if (_tellorIsFrozen(tellorResponse)) {
                    _changeStatus(_collToken, Status.usingTellorChainlinkUntrusted);
                    return priceFeed.lastGoodPrice;
                }

                // If Chainlink is broken and Tellor is working, switch to Tellor and return current Tellor price
                _changeStatus(_collToken, Status.usingTellorChainlinkUntrusted);
                return _storeTellorPrice(_collToken, tellorResponse);
            }

            // If Chainlink is frozen, try Tellor
            if (_chainlinkIsFrozen(chainlinkResponse)) {
                // If Tellor is broken too, remember Tellor broke, and return last good price
                if (_tellorIsBroken(tellorResponse)) {
                    _changeStatus(_collToken, Status.usingChainlinkTellorUntrusted);
                    return priceFeed.lastGoodPrice;
                }

                // If Tellor is frozen or working, remember Chainlink froze, and switch to Tellor
                _changeStatus(_collToken, Status.usingTellorChainlinkFrozen);

                if (_tellorIsFrozen(tellorResponse)) {
                    return priceFeed.lastGoodPrice;
                }

                // If Tellor is working, use it
                return _storeTellorPrice(_collToken, tellorResponse);
            }

            // If Chainlink price has changed by > 50% between two consecutive rounds, compare it to Tellor's price
            if (_chainlinkPriceChangeAboveMax(chainlinkResponse, prevChainlinkResponse)) {
                // If Tellor is broken, both oracles are untrusted, and return last good price
                if (_tellorIsBroken(tellorResponse)) {
                    _changeStatus(_collToken, Status.bothOraclesUntrusted);
                    return priceFeed.lastGoodPrice;
                }

                // If Tellor is frozen, switch to Tellor and return last good price
                if (_tellorIsFrozen(tellorResponse)) {
                    _changeStatus(_collToken, Status.usingTellorChainlinkUntrusted);
                    return priceFeed.lastGoodPrice;
                }

                /*
                 * If Tellor is live and both oracles have a similar price, conclude that Chainlink's large price deviation between
                 * two consecutive rounds was likely a legitmate market price movement, and so continue using Chainlink
                 */
                if (_bothOraclesSimilarPrice(chainlinkResponse, tellorResponse)) {
                    return _storeChainlinkPrice(_collToken, chainlinkResponse);
                }

                // If Tellor is live but the oracles differ too much in price, conclude that Chainlink's initial price deviation was
                // an oracle failure. Switch to Tellor, and use Tellor price
                _changeStatus(_collToken, Status.usingTellorChainlinkUntrusted);
                return _storeTellorPrice(_collToken, tellorResponse);
            }

            // If Chainlink is working and Tellor is broken, remember Tellor is broken
            if (_tellorIsBroken(tellorResponse)) {
                _changeStatus(_collToken, Status.usingChainlinkTellorUntrusted);
            }

            // If Chainlink is working, return Chainlink current price (no status change)
            return _storeChainlinkPrice(_collToken, chainlinkResponse);
        }

        // --- CASE 2: The system fetched last price from Tellor ---
        if (priceFeed.status == Status.usingTellorChainlinkUntrusted) {
            // If both Tellor and Chainlink are live, unbroken, and reporting similar prices, switch back to Chainlink
            if (
                _bothOraclesLiveAndUnbrokenAndSimilarPrice(
                    chainlinkResponse,
                    prevChainlinkResponse,
                    tellorResponse
                )
            ) {
                _changeStatus(_collToken, Status.chainlinkWorking);
                return _storeChainlinkPrice(_collToken, chainlinkResponse);
            }

            if (_tellorIsBroken(tellorResponse)) {
                _changeStatus(_collToken, Status.bothOraclesUntrusted);
                return priceFeed.lastGoodPrice;
            }

            /*
             * If Tellor is only frozen but otherwise returning valid data, just return the last good price.
             * Tellor may need to be tipped to return current data.
             */
            if (_tellorIsFrozen(tellorResponse)) {
                return priceFeed.lastGoodPrice;
            }

            // Otherwise, use Tellor price
            return _storeTellorPrice(_collToken, tellorResponse);
        }

        // --- CASE 3: Both oracles were untrusted at the last price fetch ---
        if (priceFeed.status == Status.bothOraclesUntrusted) {
            /*
             * If both oracles are now live, unbroken and similar price, we assume that they are reporting
             * accurately, and so we switch back to Chainlink.
             */
            if (
                _bothOraclesLiveAndUnbrokenAndSimilarPrice(
                    chainlinkResponse,
                    prevChainlinkResponse,
                    tellorResponse
                )
            ) {
                _changeStatus(_collToken, Status.chainlinkWorking);
                return _storeChainlinkPrice(_collToken, chainlinkResponse);
            }

            // Otherwise, return the last good price - both oracles are still untrusted (no status change)
            return priceFeed.lastGoodPrice;
        }

        // --- CASE 4: Using Tellor, and Chainlink is frozen ---
        if (priceFeed.status == Status.usingTellorChainlinkFrozen) {
            if (_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse)) {
                // If both Oracles are broken, return last good price
                if (_tellorIsBroken(tellorResponse)) {
                    _changeStatus(_collToken, Status.bothOraclesUntrusted);
                    return priceFeed.lastGoodPrice;
                }

                // If Chainlink is broken, remember it and switch to using Tellor
                _changeStatus(_collToken, Status.usingTellorChainlinkUntrusted);

                if (_tellorIsFrozen(tellorResponse)) {
                    return priceFeed.lastGoodPrice;
                }

                // If Tellor is working, return Tellor current price
                return _storeTellorPrice(_collToken, tellorResponse);
            }

            if (_chainlinkIsFrozen(chainlinkResponse)) {
                // if Chainlink is frozen and Tellor is broken, remember Tellor broke, and return last good price
                if (_tellorIsBroken(tellorResponse)) {
                    _changeStatus(_collToken, Status.usingChainlinkTellorUntrusted);
                    return priceFeed.lastGoodPrice;
                }

                // If both are frozen, just use lastGoodPrice
                if (_tellorIsFrozen(tellorResponse)) {
                    return priceFeed.lastGoodPrice;
                }

                // if Chainlink is frozen and Tellor is working, keep using Tellor (no status change)
                return _storeTellorPrice(_collToken, tellorResponse);
            }

            // if Chainlink is live and Tellor is broken, remember Tellor broke, and return Chainlink price
            if (_tellorIsBroken(tellorResponse)) {
                _changeStatus(_collToken, Status.usingChainlinkTellorUntrusted);
                return _storeChainlinkPrice(_collToken, chainlinkResponse);
            }

            // If Chainlink is live and Tellor is frozen, just use last good price (no status change) since we have no basis for comparison
            if (_tellorIsFrozen(tellorResponse)) {
                return priceFeed.lastGoodPrice;
            }

            // If Chainlink is live and Tellor is working, compare prices. Switch to Chainlink
            // if prices are within 5%, and return Chainlink price.
            if (_bothOraclesSimilarPrice(chainlinkResponse, tellorResponse)) {
                _changeStatus(_collToken, Status.chainlinkWorking);
                return _storeChainlinkPrice(_collToken, chainlinkResponse);
            }

            // Otherwise if Chainlink is live but price not within 5% of Tellor, distrust Chainlink, and return Tellor price
            _changeStatus(_collToken, Status.usingTellorChainlinkUntrusted);
            return _storeTellorPrice(_collToken, tellorResponse);
        }

        // --- CASE 5: Using Chainlink, Tellor is untrusted ---
        if (priceFeed.status == Status.usingChainlinkTellorUntrusted) {
            // If Chainlink breaks, now both oracles are untrusted
            if (_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse)) {
                _changeStatus(_collToken, Status.bothOraclesUntrusted);
                return priceFeed.lastGoodPrice;
            }

            // If Chainlink is frozen, return last good price (no status change)
            if (_chainlinkIsFrozen(chainlinkResponse)) {
                return priceFeed.lastGoodPrice;
            }

            // If Chainlink and Tellor are both live, unbroken and similar price, switch back to chainlinkWorking and return Chainlink price
            if (
                _bothOraclesLiveAndUnbrokenAndSimilarPrice(
                    chainlinkResponse,
                    prevChainlinkResponse,
                    tellorResponse
                )
            ) {
                _changeStatus(_collToken, Status.chainlinkWorking);
                return _storeChainlinkPrice(_collToken, chainlinkResponse);
            }

            // If Chainlink is live but deviated >50% from it's previous price and Tellor is still untrusted, switch
            // to bothOraclesUntrusted and return last good price
            if (_chainlinkPriceChangeAboveMax(chainlinkResponse, prevChainlinkResponse)) {
                _changeStatus(_collToken, Status.bothOraclesUntrusted);
                return priceFeed.lastGoodPrice;
            }

            // Otherwise if Chainlink is live and deviated <50% from it's previous price and Tellor is still untrusted,
            // return Chainlink price (no status change)
            return _storeChainlinkPrice(_collToken, chainlinkResponse);
        }
    }

    // --- Helper functions ---

    /* Chainlink is considered broken if its current or previous round data is in any way bad. We check the previous round
     * for two reasons:
     *
     * 1) It is necessary data for the price deviation check in case 1,
     * and
     * 2) Chainlink is the PriceFeed's preferred primary oracle - having two consecutive valid round responses adds
     * peace of mind when using or returning to Chainlink.
     */
    function _chainlinkIsBroken(
        ChainlinkResponse memory _currentResponse,
        ChainlinkResponse memory _prevResponse
    ) internal view returns (bool) {
        return _badChainlinkResponse(_currentResponse) || _badChainlinkResponse(_prevResponse);
    }

    function _badChainlinkResponse(ChainlinkResponse memory _response) internal view returns (bool) {
        // Check for response call reverted
        if (!_response.success) {
            return true;
        }
        // Check for an invalid roundId that is 0
        if (_response.roundId == 0) {
            return true;
        }
        // Check for an invalid timeStamp that is 0, or in the future
        if (_response.timestamp == 0 || _response.timestamp > block.timestamp) {
            return true;
        }
        // Check for non-positive price
        if (_response.answer <= 0) {
            return true;
        }

        return false;
    }

    function _chainlinkIsFrozen(ChainlinkResponse memory _response) internal view returns (bool) {
        return block.timestamp.sub(_response.timestamp) > TIMEOUT;
    }

    function _chainlinkPriceChangeAboveMax(
        ChainlinkResponse memory _currentResponse,
        ChainlinkResponse memory _prevResponse
    ) internal pure returns (bool) {
        uint256 currentScaledPrice = _scaleChainlinkPriceByDigits(
            uint256(_currentResponse.answer),
            _currentResponse.decimals
        );
        uint256 prevScaledPrice = _scaleChainlinkPriceByDigits(
            uint256(_prevResponse.answer),
            _prevResponse.decimals
        );

        uint256 minPrice = LiquityMath._min(currentScaledPrice, prevScaledPrice);
        uint256 maxPrice = LiquityMath._max(currentScaledPrice, prevScaledPrice);

        /*
         * Use the larger price as the denominator:
         * - If price decreased, the percentage deviation is in relation to the the previous price.
         * - If price increased, the percentage deviation is in relation to the current price.
         */
        uint256 percentDeviation = maxPrice.sub(minPrice).mul(DECIMAL_PRECISION).div(maxPrice);

        // Return true if price has more than doubled, or more than halved.
        return percentDeviation > MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND;
    }

    function _tellorIsBroken(TellorResponse memory _response) internal view returns (bool) {
        // Check for response call reverted
        if (!_response.success) {
            return true;
        }
        // Check for an invalid timeStamp that is 0, or in the future
        if (_response.timestamp == 0 || _response.timestamp > block.timestamp) {
            return true;
        }
        // Check for zero price
        if (_response.value == 0) {
            return true;
        }

        return false;
    }

    function _tellorIsFrozen(TellorResponse memory _tellorResponse) internal view returns (bool) {
        return block.timestamp.sub(_tellorResponse.timestamp) > TIMEOUT;
    }

    function _bothOraclesLiveAndUnbrokenAndSimilarPrice(
        ChainlinkResponse memory _chainlinkResponse,
        ChainlinkResponse memory _prevChainlinkResponse,
        TellorResponse memory _tellorResponse
    ) internal view returns (bool) {
        // Return false if either oracle is broken or frozen
        if (
            _tellorIsBroken(_tellorResponse) ||
            _tellorIsFrozen(_tellorResponse) ||
            _chainlinkIsBroken(_chainlinkResponse, _prevChainlinkResponse) ||
            _chainlinkIsFrozen(_chainlinkResponse)
        ) {
            return false;
        }

        return _bothOraclesSimilarPrice(_chainlinkResponse, _tellorResponse);
    }

    function _bothOraclesSimilarPrice(
        ChainlinkResponse memory _chainlinkResponse,
        TellorResponse memory _tellorResponse
    ) internal pure returns (bool) {
        uint256 scaledChainlinkPrice = _scaleChainlinkPriceByDigits(
            uint256(_chainlinkResponse.answer),
            _chainlinkResponse.decimals
        );
        uint256 scaledTellorPrice = _scaleTellorPriceByDigits(_tellorResponse.value);

        // Get the relative price difference between the oracles. Use the lower price as the denominator, i.e. the reference for the calculation.
        uint256 minPrice = LiquityMath._min(scaledTellorPrice, scaledChainlinkPrice);
        uint256 maxPrice = LiquityMath._max(scaledTellorPrice, scaledChainlinkPrice);
        uint256 percentPriceDifference = maxPrice.sub(minPrice).mul(DECIMAL_PRECISION).div(minPrice);

        /*
         * Return true if the relative price difference is <= 3%: if so, we assume both oracles are probably reporting
         * the honest market price, as it is unlikely that both have been broken/hacked and are still in-sync.
         */
        return percentPriceDifference <= MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES;
    }

    function _scaleChainlinkPriceByDigits(uint256 _price, uint256 _answerDigits)
        internal
        pure
        returns (uint256)
    {
        /*
         * Convert the price returned by the Chainlink oracle to an 18-digit decimal for use by Liquity.
         * At date of Liquity launch, Chainlink uses an 8-digit price, but we also handle the possibility of
         * future changes.
         *
         */
        uint256 price;
        if (_answerDigits >= TARGET_DIGITS) {
            // Scale the returned price value down to Liquity's target precision
            price = _price.div(10**(_answerDigits - TARGET_DIGITS));
        } else if (_answerDigits < TARGET_DIGITS) {
            // Scale the returned price value up to Liquity's target precision
            price = _price.mul(10**(TARGET_DIGITS - _answerDigits));
        }
        return price;
    }

    function _scaleTellorPriceByDigits(uint256 _price) internal pure returns (uint256) {
        return _price.mul(10**(TARGET_DIGITS - TELLOR_DIGITS));
    }

    function _changeStatus(address _collToken, Status _status) internal {
        priceFeeds[_collToken].status = _status;
        emit PriceFeedStatusChanged(_collToken, _status);
    }

    function _storePrice(address _collToken, uint256 _currentPrice) internal {
        priceFeeds[_collToken].lastGoodPrice = _currentPrice;
        emit LastGoodPriceUpdated(_collToken, _currentPrice);
    }

    function _storeTellorPrice(address _collToken, TellorResponse memory _tellorResponse)
        internal
        returns (uint256)
    {
        uint256 scaledTellorPrice = _scaleTellorPriceByDigits(_tellorResponse.value);
        _storePrice(_collToken, scaledTellorPrice);

        return scaledTellorPrice;
    }

    function _storeChainlinkPrice(address _collToken, ChainlinkResponse memory _chainlinkResponse)
        internal
        returns (uint256)
    {
        uint256 scaledChainlinkPrice = _scaleChainlinkPriceByDigits(
            uint256(_chainlinkResponse.answer),
            _chainlinkResponse.decimals
        );
        _storePrice(_collToken, scaledChainlinkPrice);

        return scaledChainlinkPrice;
    }

    // --- Oracle response wrapper functions ---

    function _getCurrentTellorResponse(ITellorCaller _tellorCaller)
        internal
        view
        returns (TellorResponse memory tellorResponse)
    {
        try _tellorCaller.getTellorCurrentValue(ETHUSD_TELLOR_REQ_ID) returns (
            bool ifRetrieve,
            uint256 value,
            uint256 _timestampRetrieved
        ) {
            // If call to Tellor succeeds, return the response and success = true
            tellorResponse.ifRetrieve = ifRetrieve;
            tellorResponse.value = value;
            tellorResponse.timestamp = _timestampRetrieved;
            tellorResponse.success = true;

            return (tellorResponse);
        } catch {
            // If call to Tellor reverts, return a zero response with success = false
            return (tellorResponse);
        }
    }

    function _getCurrentChainlinkResponse(AggregatorV3Interface _priceAggregator)
        internal
        view
        returns (ChainlinkResponse memory chainlinkResponse)
    {
        // First, try to get current decimal precision:
        try _priceAggregator.decimals() returns (uint8 decimals) {
            // If call to Chainlink succeeds, record the current decimal precision
            chainlinkResponse.decimals = decimals;
        } catch {
            // If call to Chainlink aggregator reverts, return a zero response with success = false
            return chainlinkResponse;
        }

        // Secondly, try to get latest price data:
        try _priceAggregator.latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256, /* startedAt */
            uint256 timestamp,
            uint80 /* answeredInRound */
        ) {
            // If call to Chainlink succeeds, return the response and success = true
            chainlinkResponse.roundId = roundId;
            chainlinkResponse.answer = answer;
            chainlinkResponse.timestamp = timestamp;
            chainlinkResponse.success = true;
            return chainlinkResponse;
        } catch {
            // If call to Chainlink aggregator reverts, return a zero response with success = false
            return chainlinkResponse;
        }
    }

    function _getPrevChainlinkResponse(
        AggregatorV3Interface _priceAggregator,
        uint80 _currentRoundId,
        uint8 _currentDecimals
    ) internal view returns (ChainlinkResponse memory prevChainlinkResponse) {
        /*
         * NOTE: Chainlink only offers a current decimals() value - there is no way to obtain the decimal precision used in a
         * previous round.  We assume the decimals used in the previous round are the same as the current round.
         */

        // Try to get the price data from the previous round:
        try _priceAggregator.getRoundData(_currentRoundId - 1) returns (
            uint80 roundId,
            int256 answer,
            uint256, /* startedAt */
            uint256 timestamp,
            uint80 /* answeredInRound */
        ) {
            // If call to Chainlink succeeds, return the response and success = true
            prevChainlinkResponse.roundId = roundId;
            prevChainlinkResponse.answer = answer;
            prevChainlinkResponse.timestamp = timestamp;
            prevChainlinkResponse.decimals = _currentDecimals;
            prevChainlinkResponse.success = true;
            return prevChainlinkResponse;
        } catch {
            // If call to Chainlink aggregator reverts, return a zero response with success = false
            return prevChainlinkResponse;
        }
    }

    function lastGoodPrice(address _collToken) external view override returns (uint256) {
        return priceFeeds[_collToken].lastGoodPrice;
    }

    function status(address _collToken) external view override returns (Status) {
        return priceFeeds[_collToken].status;
    }
}
