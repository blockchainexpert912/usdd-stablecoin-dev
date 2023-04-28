// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../BorrowerOperations.sol";

/* Tester contract inherits from BorrowerOperations, and provides external functions 
for testing the parent's internal functions. */
contract BorrowerOperationsTester is BorrowerOperations {
    function getNewICRFromTroveChange(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool isCollIncrease,
        uint256 _debtChange,
        bool isDebtIncrease,
        uint256 _price
    ) external pure returns (uint256) {
        return
            _getNewICRFromTroveChange(
                _coll,
                _debt,
                _collChange,
                isCollIncrease,
                _debtChange,
                isDebtIncrease,
                _price
            );
    }

    function getNewTCRFromTroveChange(
        uint256 _collChange,
        bool isCollIncrease,
        uint256 _debtChange,
        bool isDebtIncrease,
        uint256 _price
    ) external view returns (uint256) {
        return
            _getNewTCRFromTroveChange(
                _collChange,
                isCollIncrease,
                _debtChange,
                isDebtIncrease,
                _price
            );
    }

    function getUSDValue(uint256 _coll, uint256 _price) external pure returns (uint256) {
        return _getUSDValue(_coll, _price);
    }

    function callInternalAdjustLoan(
        address _borrower,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external {
        _adjustTrove(
            _borrower,
            _collDeposited,
            _collWithdrawal,
            _debtChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            0
        );
    }

    function forward(address _dest, bytes calldata _data) external payable {
        (bool success, bytes memory returnData) = _dest.call{value: msg.value}(_data);
        //console.logBytes(returnData);
        require(success, string(returnData));
    }
}
