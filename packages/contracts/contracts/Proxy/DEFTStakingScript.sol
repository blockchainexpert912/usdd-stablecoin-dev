// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/CheckContract.sol";
import "../Interfaces/IDEFTStaking.sol";

contract DEFTStakingScript is CheckContract {
    IDEFTStaking immutable DEFTStaking;

    constructor(address _deftStakingAddress) public {
        checkContract(_deftStakingAddress);
        DEFTStaking = IDEFTStaking(_deftStakingAddress);
    }

    function stake(uint256 _DEFTamount) external {
        DEFTStaking.stake(_DEFTamount);
    }
}
