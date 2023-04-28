// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Dependencies/LiquityMath.sol";
import "../Dependencies/IERC20.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Interfaces/ITroveManager.sol";
import "../Interfaces/IStabilityPool.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/IDEFTStaking.sol";
import "./BorrowerOperationsScript.sol";
import "./ETHTransferScript.sol";
import "./DEFTStakingScript.sol";
import "hardhat/console.sol";

// import "../Dependencies/console.sol";

contract BorrowerWrappersScript is BorrowerOperationsScript, ETHTransferScript, DEFTStakingScript {
    using SafeMath for uint256;

    string public constant NAME = "BorrowerWrappersScript";

    ITroveManager immutable troveManager;
    IStabilityPool immutable stabilityPool;
    IPriceFeed immutable priceFeed;
    IERC20 immutable usddToken;
    IERC20 immutable deftToken;
    IDEFTStaking immutable deftStaking;

    constructor(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _deftStakingAddress
    )
        public
        BorrowerOperationsScript(IBorrowerOperations(_borrowerOperationsAddress))
        DEFTStakingScript(_deftStakingAddress)
    {
        checkContract(_troveManagerAddress);
        ITroveManager troveManagerCached = ITroveManager(_troveManagerAddress);
        troveManager = troveManagerCached;

        IStabilityPool stabilityPoolCached = troveManagerCached.stabilityPool();
        checkContract(address(stabilityPoolCached));
        stabilityPool = stabilityPoolCached;

        IPriceFeed priceFeedCached = troveManagerCached.priceFeed();
        checkContract(address(priceFeedCached));
        priceFeed = priceFeedCached;

        address usddTokenCached = address(troveManagerCached.usddToken());
        checkContract(usddTokenCached);
        usddToken = IERC20(usddTokenCached);

        address deftTokenCached = address(troveManagerCached.deftToken());
        checkContract(deftTokenCached);
        deftToken = IERC20(deftTokenCached);

        IDEFTStaking deftStakingCached = troveManagerCached.deftStaking();
        require(
            _deftStakingAddress == address(deftStakingCached),
            "BorrowerWrappersScript: Wrong DEFTStaking address"
        );
        deftStaking = deftStakingCached;
    }

    function claimCollateralAndOpenTrove(
        uint256 _maxFee,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external {
        uint256 balanceBefore = IERC20(troveManager.collToken()).balanceOf(address(this));
        // Claim collateral
        borrowerOperations.claimCollateral();
        uint256 balanceAfter = IERC20(troveManager.collToken()).balanceOf(address(this));

        // already checked in CollSurplusPool
        assert(balanceAfter > balanceBefore);

        uint256 totalCollateral = balanceAfter.sub(balanceBefore).add(_collAmount);

        IERC20(borrowerOperations.collToken()).approve(
            address(borrowerOperations),
            type(uint256).max
        );

        IERC20(borrowerOperations.collToken()).transferFrom(msg.sender, address(this), _collAmount);
        // Open trove with obtained collateral, plus collateral sent by user
        borrowerOperations.openTrove(_maxFee, totalCollateral, _USDDAmount, _upperHint, _lowerHint);
    }

    function claimSPRewardsAndRecycle(
        uint256 _maxFee,
        address _upperHint,
        address _lowerHint
    ) external {
        uint256 collBalanceBefore = IERC20(troveManager.collToken()).balanceOf(address(this));
        uint256 deftBalanceBefore = deftToken.balanceOf(address(this));

        // Claim rewards
        stabilityPool.withdrawFromSP(0);

        uint256 collBalanceAfter = IERC20(troveManager.collToken()).balanceOf(address(this));
        uint256 deftBalanceAfter = deftToken.balanceOf(address(this));
        uint256 claimedCollateral = collBalanceAfter.sub(collBalanceBefore);

        // Add claimed ETH to trove, get more USDD and stake it into the Stability Pool
        if (claimedCollateral > 0) {
            _requireUserHasTrove(address(this));
            uint256 USDDAmount = _getNetUSDDAmount(claimedCollateral);
            borrowerOperations.adjustTrove(
                _maxFee,
                claimedCollateral,
                0,
                USDDAmount,
                true,
                _upperHint,
                _lowerHint
            );
            // Provide withdrawn USDD to Stability Pool
            if (USDDAmount > 0) {
                stabilityPool.provideToSP(USDDAmount, address(0));
            }
        }

        // Stake claimed DEFT
        uint256 claimedDEFT = deftBalanceAfter.sub(deftBalanceBefore);
        if (claimedDEFT > 0) {
            deftToken.increaseAllowance(address(deftStaking), claimedDEFT);
            deftStaking.stake(claimedDEFT);
        }
    }

    function claimStakingGainsAndRecycle(
        uint256 _maxFee,
        address _upperHint,
        address _lowerHint
    ) external {
        uint256 collBalanceBefore = IERC20(troveManager.collToken()).balanceOf(address(this));
        uint256 usddBalanceBefore = usddToken.balanceOf(address(this));
        uint256 deftBalanceBefore = deftToken.balanceOf(address(this));

        // Claim gains
        deftStaking.unstake(0);

        uint256 gainedCollateral = IERC20(troveManager.collToken()).balanceOf(address(this)).sub(
            collBalanceBefore
        ); // stack too deep issues :'(
        uint256 gainedUSDD = usddToken.balanceOf(address(this)).sub(usddBalanceBefore);

        uint256 netUSDDAmount;
        // Top up trove and get more USDD, keeping ICR constant
        if (gainedCollateral > 0) {
            _requireUserHasTrove(address(this));
            netUSDDAmount = _getNetUSDDAmount(gainedCollateral);
            borrowerOperations.adjustTrove(
                _maxFee,
                gainedCollateral,
                0,
                netUSDDAmount,
                true,
                _upperHint,
                _lowerHint
            );
        }

        uint256 totalUSDD = gainedUSDD.add(netUSDDAmount);
        if (totalUSDD > 0) {
            stabilityPool.provideToSP(totalUSDD, address(0));

            // Providing to Stability Pool also triggers DEFT claim, so stake it if any
            uint256 deftBalanceAfter = deftToken.balanceOf(address(this));
            uint256 claimedDEFT = deftBalanceAfter.sub(deftBalanceBefore);
            if (claimedDEFT > 0) {
                deftToken.increaseAllowance(address(deftStaking), claimedDEFT);
                deftStaking.stake(claimedDEFT);
            }
        }
    }

    function _getNetUSDDAmount(uint256 _collateral) internal returns (uint256) {
        uint256 price = priceFeed.fetchPrice(borrowerOperations.collToken());
        uint256 ICR = troveManager.getCurrentICR(address(this), price);

        uint256 USDDAmount = _collateral.mul(price).div(ICR);
        uint256 borrowingRate = troveManager.getBorrowingRateWithDecay();
        uint256 netDebt = USDDAmount.mul(LiquityMath.DECIMAL_PRECISION).div(
            LiquityMath.DECIMAL_PRECISION.add(borrowingRate)
        );

        return netDebt;
    }

    function _requireUserHasTrove(address _depositor) internal view {
        require(
            troveManager.getTroveStatus(_depositor) == 1,
            "BorrowerWrappersScript: caller must have an active trove"
        );
    }
}
