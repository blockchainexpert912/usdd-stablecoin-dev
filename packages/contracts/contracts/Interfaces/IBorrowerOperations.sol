// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

// Common interface for the Trove Manager.
interface IBorrowerOperations {
    // --- Events ---

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event GasPoolAddressChanged(address _gasPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address _newPriceFeedAddress);
    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event USDDTokenAddressChanged(address _usddTokenAddress);
    event DEFTStakingAddressChanged(address _deftStakingAddress);

    event TroveCreated(address indexed _borrower, uint256 arrayIndex);
    event TroveUpdated(
        address indexed _borrower,
        uint256 _debt,
        uint256 _coll,
        uint256 stake,
        uint8 operation
    );
    event USDDBorrowingFeePaid(address indexed _borrower, uint256 _USDDFee);

    // --- Functions ---

    function collToken() external view returns (address);

    function setAddresses(
        address _collToken,
        address wETHGatewayAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _gasPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _sortedTrovesAddress,
        address _usddTokenAddress,
        address _deftStakingAddress
    ) external;

    function openTrove(
        address _onBehalfOf,
        uint256 _maxFee,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external;

    function openTrove(
        uint256 _maxFee,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external;

    function addColl(
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external;

    function moveCollGainToTrove(
        address _user,
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external;

    function withdrawColl(
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external;

    function withdrawUSDD(
        uint256 _maxFee,
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external;

    function repayUSDD(
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external;

    function closeTrove(address _onBehalfOf) external;

    function closeTrove() external;

    function adjustTrove(
        uint256 _maxFee,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external;

    function adjustTrove(
        address _onBehalfOf,
        uint256 _maxFee,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external;

    function claimCollateral(address _onBehalfOf) external;

    function claimCollateral() external;

    function getCompositeDebt(uint256 _debt) external pure returns (uint256);
}
