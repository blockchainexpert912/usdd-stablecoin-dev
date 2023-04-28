// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IWETHGateway.sol";
import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IStabilityPool.sol";
import "./Interfaces/IDEFTStaking.sol";
import "./Dependencies/SafeMath.sol";
import "./Interfaces/IWETH.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";

contract WETHGateway is Ownable, CheckContract, IWETHGateway {
    using SafeMath for uint256;
    IWETH internal WETH;
    IBorrowerOperations public borrowerOperations;
    ITroveManager public troveManager;
    IStabilityPool public stabilityPool;
    IDEFTStaking public lQTYStaking;

    constructor(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _stabilityPoolAddress,
        address _wethAddress
    ) public {
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_wethAddress);
        borrowerOperations = IBorrowerOperations(_borrowerOperationsAddress);
        troveManager = ITroveManager(_troveManagerAddress);
        stabilityPool = IStabilityPool(_stabilityPoolAddress);
        WETH = IWETH(_wethAddress);
        WETH.approve(_borrowerOperationsAddress, type(uint256).max);
    }

    modifier transferSenderETH() {
        uint256 balanceBefore = WETH.balanceOf(address(this));
        _;
        uint256 balanceAfter = WETH.balanceOf(address(this));
        uint256 recievedWETH = balanceAfter.sub(balanceBefore);
        _safeTransferETH(msg.sender, recievedWETH);
    }

    /**
     * @dev transfer ETH to an address, revert if it fails.
     * @param to recipient of the transfer
     * @param value the amount to send
     */
    function _safeTransferETH(address to, uint256 value) internal {
        WETH.withdraw(value);
        (bool success, ) = to.call{value: value}(new bytes(0));
        require(success, "ETH_TRANSFER_FAILED");
    }

    // BorrowerOperations

    function openTrove(
        uint256 _maxFee,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        WETH.deposit{value: msg.value}();
        borrowerOperations.openTrove(
            msg.sender,
            _maxFee,
            _collAmount,
            _USDDAmount,
            _upperHint,
            _lowerHint
        );
    }

    function adjustTrove(
        uint256 _maxFee,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        WETH.deposit{value: msg.value}();
        borrowerOperations.adjustTrove(
            msg.sender,
            _maxFee,
            _collDeposited,
            _collWithdrawal,
            _debtChange,
            isDebtIncrease,
            _upperHint,
            _lowerHint
        );
    }

    function addColl(
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        WETH.deposit{value: msg.value}();
        borrowerOperations.adjustTrove(
            msg.sender,
            0,
            _collAmount,
            0,
            0,
            false,
            _upperHint,
            _lowerHint
        );
    }

    function withdrawColl(
        uint256 _collWithdrawal,
        address _upperHint,
        address _lowerHint
    ) external override {
        borrowerOperations.adjustTrove(
            msg.sender,
            0,
            0,
            _collWithdrawal,
            0,
            false,
            _upperHint,
            _lowerHint
        );
        _safeTransferETH(msg.sender, _collWithdrawal);
    }

    function closeTrove() external override transferSenderETH {
        borrowerOperations.closeTrove(msg.sender);
    }

    function claimCollateral() external override transferSenderETH {
        borrowerOperations.claimCollateral(msg.sender);
    }

    // StabilityPool

    function provideToSP(uint256 _amount, address _frontEndTag) external override transferSenderETH {
        stabilityPool.provideToSP(msg.sender, _amount, _frontEndTag);
    }

    function withdrawFromSP(uint256 _amount) external override transferSenderETH {
        stabilityPool.withdrawFromSP(msg.sender, _amount);
    }

    // TroveManager

    function liquidate(address _borrower) external override transferSenderETH {
        troveManager.liquidate(msg.sender, _borrower);
    }

    function liquidateTroves(uint256 _n) external override transferSenderETH {
        troveManager.liquidateTroves(msg.sender, _n);
    }

    function batchLiquidateTroves(address[] calldata _troveArray)
        external
        override
        transferSenderETH
    {
        troveManager.batchLiquidateTroves(msg.sender, _troveArray);
    }

    function redeemCollateral(
        uint256 _USDDAmount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFee
    ) external override transferSenderETH {
        troveManager.redeemCollateral(
            msg.sender,
            _USDDAmount,
            _firstRedemptionHint,
            _upperPartialRedemptionHint,
            _lowerPartialRedemptionHint,
            _partialRedemptionHintNICR,
            _maxIterations,
            _maxFee
        );
    }

    // DEFTStaking
    function stake(uint256 _DEFTamount) external override transferSenderETH {
        lQTYStaking.stake(msg.sender, _DEFTamount);
    }

    function unstake(uint256 _DEFTamount) external override transferSenderETH {
        lQTYStaking.unstake(msg.sender, _DEFTamount);
    }
}
