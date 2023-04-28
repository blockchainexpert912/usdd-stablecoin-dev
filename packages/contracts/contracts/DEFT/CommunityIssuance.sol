// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IDEFTToken.sol";
import "../Interfaces/ICommunityIssuance.sol";
import "../Dependencies/BaseMath.sol";
import "../Dependencies/LiquityMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
import "../Dependencies/SafeMath.sol";

contract CommunityIssuance is ICommunityIssuance, Ownable, CheckContract, BaseMath {
    using SafeMath for uint256;

    // --- Data ---

    string public constant NAME = "CommunityIssuance";

    uint256 public constant SECONDS_IN_ONE_MINUTE = 60;

    /* The issuance factor F determines the curvature of the issuance curve.
     *
     * Minutes in one year: 60*24*365 = 525600
     *
     * For 50% of remaining tokens issued each year, with minutes as time units, we have:
     *
     * F ** 525600 = 0.5
     *
     * Re-arranging:
     *
     * 525600 * ln(F) = ln(0.5)
     * F = 0.5 ** (1/525600)
     * F = 0.999998681227695000
     */
    uint256 public constant ISSUANCE_FACTOR = 999998681227695000;

    /*
     * The community DEFT supply cap is the starting balance of the Community Issuance contract.
     * It should be minted to this contract by DEFTToken, when the token is deployed.
     */
    uint256 public DEFTSupplyCap;

    IDEFTToken public deftToken;

    address public stabilityPoolAddress;

    uint256 public totalDEFTIssued;
    uint256 public startTime;

    // --- Events ---

    event DEFTTokenAddressSet(address _deftTokenAddress);
    event StabilityPoolAddressSet(address _stabilityPoolAddress);
    event TotalDEFTIssuedUpdated(uint256 _totalDEFTIssued);

    // --- Modifiers ---

    modifier shouldStarted() {
        require(startTime > 0, "Issuance not started");
        _;
    }

    // --- Functions ---

    function setAddresses(address _deftTokenAddress, address _stabilityPoolAddress)
        external
        override
        onlyOwner
    {
        checkContract(_deftTokenAddress);
        checkContract(_stabilityPoolAddress);

        deftToken = IDEFTToken(_deftTokenAddress);
        stabilityPoolAddress = _stabilityPoolAddress;

        // When DEFTToken deployed, it should have transferred CommunityIssuance's DEFT entitlement
        uint256 DEFTBalance = deftToken.balanceOf(address(this));
        assert(DEFTBalance >= DEFTSupplyCap);

        emit DEFTTokenAddressSet(_deftTokenAddress);
        emit StabilityPoolAddressSet(_stabilityPoolAddress);
    }

    function start(uint256 _DEFTSupplyCap) external override onlyOwner {
        assert(_DEFTSupplyCap > 0);
        assert(_DEFTSupplyCap <= deftToken.balanceOf(address(this)));
        DEFTSupplyCap = _DEFTSupplyCap;
        startTime = block.timestamp;
        _renounceOwnership();
    }

    function issueDEFT() external override shouldStarted returns (uint256) {
        _requireCallerIsStabilityPool();

        uint256 latestTotalDEFTIssued = DEFTSupplyCap.mul(_getCumulativeIssuanceFraction()).div(
            DECIMAL_PRECISION
        );
        uint256 issuance = latestTotalDEFTIssued.sub(totalDEFTIssued);

        totalDEFTIssued = latestTotalDEFTIssued;
        emit TotalDEFTIssuedUpdated(latestTotalDEFTIssued);

        return issuance;
    }

    /* Gets 1-f^t    where: f < 1

    f: issuance factor that determines the shape of the curve
    t:  time passed since last DEFT issuance event  */
    function _getCumulativeIssuanceFraction() internal view returns (uint256) {
        // Get the time passed since deployment
        uint256 timePassedInMinutes = block.timestamp.sub(startTime).div(SECONDS_IN_ONE_MINUTE);

        // f^t
        uint256 power = LiquityMath._decPow(ISSUANCE_FACTOR, timePassedInMinutes);

        //  (1 - f^t)
        uint256 cumulativeIssuanceFraction = (uint256(DECIMAL_PRECISION).sub(power));
        assert(cumulativeIssuanceFraction <= DECIMAL_PRECISION); // must be in range [0,1]

        return cumulativeIssuanceFraction;
    }

    function sendDEFT(address _account, uint256 _DEFTamount) external override shouldStarted {
        _requireCallerIsStabilityPool();

        deftToken.transfer(_account, _DEFTamount);
    }

    // --- 'require' functions ---

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "CommunityIssuance: caller is not SP");
    }
}
