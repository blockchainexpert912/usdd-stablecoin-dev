// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../DEFT/DEFTStaking.sol";

contract DEFTStakingTester is DEFTStaking {
    function requireCallerIsTroveManager(address _collToken) external view {
        _requireCallerIsTroveManager(_collToken);
    }
}
