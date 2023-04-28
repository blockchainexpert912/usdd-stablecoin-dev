// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../StabilityPool.sol";

contract StabilityPoolTester is StabilityPool {
    function unprotectedReceiveColl(address _account, uint256 _amount) external {
        COLL = COLL.add(_amount);
        IERC20(collToken).safeTransferFrom(_account, address(this), _amount);
        emit StabilityPoolCollBalanceUpdated(COLL);
    }
}
