// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../DEFT/CommunityIssuance.sol";

contract CommunityIssuanceTester is CommunityIssuance {
    function obtainDEFT(uint256 _amount) external {
        deftToken.transfer(msg.sender, _amount);
    }

    function getCumulativeIssuanceFraction() external view returns (uint256) {
        return _getCumulativeIssuanceFraction();
    }

    function unprotectedIssueDEFT() external returns (uint256) {
        // No checks on caller address

        uint256 latestTotalDEFTIssued = DEFTSupplyCap.mul(_getCumulativeIssuanceFraction()).div(
            DECIMAL_PRECISION
        );
        uint256 issuance = latestTotalDEFTIssued.sub(totalDEFTIssued);

        totalDEFTIssued = latestTotalDEFTIssued;
        return issuance;
    }
}
