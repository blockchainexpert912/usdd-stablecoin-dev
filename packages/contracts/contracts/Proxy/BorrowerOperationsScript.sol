// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/CheckContract.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Dependencies/IERC20.sol";
import "hardhat/console.sol";

contract BorrowerOperationsScript is CheckContract {
    IBorrowerOperations immutable borrowerOperations;

    constructor(IBorrowerOperations _borrowerOperations) public {
        checkContract(address(_borrowerOperations));
        borrowerOperations = _borrowerOperations;
    }

    function openTrove(
        uint256 _maxFee,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external {
        IERC20(borrowerOperations.collToken()).approve(
            address(borrowerOperations),
            type(uint256).max
        );
        IERC20(borrowerOperations.collToken()).transferFrom(msg.sender, address(this), _collAmount);
        borrowerOperations.openTrove(_maxFee, _collAmount, _USDDAmount, _upperHint, _lowerHint);
    }

    function addColl(
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external {
        borrowerOperations.addColl(_collAmount, _upperHint, _lowerHint);
    }

    function withdrawColl(
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external {
        borrowerOperations.withdrawColl(_amount, _upperHint, _lowerHint);
    }

    function withdrawUSDD(
        uint256 _maxFee,
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external {
        borrowerOperations.withdrawUSDD(_maxFee, _amount, _upperHint, _lowerHint);
    }

    function repayUSDD(
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external {
        borrowerOperations.repayUSDD(_amount, _upperHint, _lowerHint);
    }

    function closeTrove() external {
        borrowerOperations.closeTrove();
    }

    function adjustTrove(
        uint256 _maxFee,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external {
        borrowerOperations.adjustTrove(
            _maxFee,
            _collDeposited,
            _collWithdrawal,
            _debtChange,
            isDebtIncrease,
            _upperHint,
            _lowerHint
        );
    }

    function claimCollateral() external {
        borrowerOperations.claimCollateral();
    }
}
