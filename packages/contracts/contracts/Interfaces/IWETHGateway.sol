// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface IWETHGateway {
    // BorrowerOperations
    function openTrove(
        uint256 _maxFee,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable;

    function adjustTrove(
        uint256 _maxFee,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external payable;

    function addColl(
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external payable;

    function withdrawColl(
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external;

    function closeTrove() external;

    function claimCollateral() external;

    // StabilityPool
    function provideToSP(uint256 _amount, address _frontEndTag) external;

    function withdrawFromSP(uint256 _amount) external;

    // TroveManager
    function liquidate(address _borrower) external;

    function liquidateTroves(uint256 _n) external;

    function batchLiquidateTroves(address[] calldata _troveArray) external;

    function redeemCollateral(
        uint256 _USDDAmount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFee
    ) external;

    // DEFTStaking
    function stake(uint256 _DEFTamount) external;

    function unstake(uint256 _DEFTamount) external;
}
