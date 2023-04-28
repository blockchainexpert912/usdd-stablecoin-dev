// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../ActivePool.sol";

contract ActivePoolTester is ActivePool {
    function unprotectedIncreaseUSDDDebt(uint256 _amount) external {
        USDDDebt = USDDDebt.add(_amount);
    }

    function unprotectedReceiveColl(
        address _account,
        address _collToken,
        uint256 _amount
    ) external {
        balances[_collToken] = balances[_collToken].add(_amount);
        emit ActivePoolBalanceUpdated(_collToken, balances[_collToken]);
        IERC20(_collToken).safeTransferFrom(_account, address(this), _amount);
    }

    function forward(address _dest, bytes calldata _data) external payable {
        (bool success, bytes memory returnData) = _dest.call{value: msg.value}(_data);
        //console.logBytes(returnData);
        require(success, string(returnData));
    }
}
