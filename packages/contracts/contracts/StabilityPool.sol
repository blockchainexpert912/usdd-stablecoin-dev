// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/IStabilityPool.sol";
import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IUSDDToken.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/ICommunityIssuance.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/LiquitySafeMath128.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
// import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import "./LPRewards/Dependencies/SafeERC20.sol";

/*
 * The Stability Pool holds USDD tokens deposited by Stability Pool depositors.
 *
 * When a trove is liquidated, then depending on system conditions, some of its USDD debt gets offset with
 * USDD in the Stability Pool:  that is, the offset debt evaporates, and an equal amount of USDD tokens in the Stability Pool is burned.
 *
 * Thus, a liquidation causes each depositor to receive a USDD loss, in proportion to their deposit as a share of total deposits.
 * They also receive an COLL gain, as the COLL collateral of the liquidated trove is distributed among Stability depositors,
 * in the same proportion.
 *
 * When a liquidation occurs, it depletes every deposit by the same fraction: for example, a liquidation that depletes 40%
 * of the total USDD in the Stability Pool, depletes 40% of each deposit.
 *
 * A deposit that has experienced a series of liquidations is termed a "compounded deposit": each liquidation depletes the deposit,
 * multiplying it by some factor in range ]0,1[
 *
 *
 * --- IMPLEMENTATION ---
 *
 * We use a highly scalable method of tracking deposits and COLL gains that has O(1) complexity.
 *
 * When a liquidation occurs, rather than updating each depositor's deposit and COLL gain, we simply update two state variables:
 * a product P, and a sum S.
 *
 * A mathematical manipulation allows us to factor out the initial deposit, and accurately track all depositors' compounded deposits
 * and accumulated COLL gains over time, as liquidations occur, using just these two variables P and S. When depositors join the
 * Stability Pool, they get a snapshot of the latest P and S: P_t and S_t, respectively.
 *
 * The formula for a depositor's accumulated COLL gain is derived here:
 * https://github.com/liquity/dev/blob/main/packages/contracts/mathProofs/Scalable%20Compounding%20Stability%20Pool%20Deposits.pdf
 *
 * For a given deposit d_t, the ratio P/P_t tells us the factor by which a deposit has decreased since it joined the Stability Pool,
 * and the term d_t * (S - S_t)/P_t gives us the deposit's total accumulated COLL gain.
 *
 * Each liquidation updates the product P and sum S. After a series of liquidations, a compounded deposit and corresponding COLL gain
 * can be calculated using the initial deposit, the depositor’s snapshots of P and S, and the latest values of P and S.
 *
 * Any time a depositor updates their deposit (withdrawal, top-up) their accumulated COLL gain is paid out, their new deposit is recorded
 * (based on their latest compounded deposit and modified by the withdrawal/top-up), and they receive new snapshots of the latest P and S.
 * Essentially, they make a fresh deposit that overwrites the old one.
 *
 *
 * --- SCALE FACTOR ---
 *
 * Since P is a running product in range ]0,1] that is always-decreasing, it should never reach 0 when multiplied by a number in range ]0,1[.
 * Unfortunately, Solidity floor division always reaches 0, sooner or later.
 *
 * A series of liquidations that nearly empty the Pool (and thus each multiply P by a very small number in range ]0,1[ ) may push P
 * to its 18 digit decimal limit, and round it to 0, when in fact the Pool hasn't been emptied: this would break deposit tracking.
 *
 * So, to track P accurately, we use a scale factor: if a liquidation would cause P to decrease to <1e-9 (and be rounded to 0 by Solidity),
 * we first multiply P by 1e9, and increment a currentScale factor by 1.
 *
 * The added benefit of using 1e9 for the scale factor (rather than 1e18) is that it ensures negligible precision loss close to the
 * scale boundary: when P is at its minimum value of 1e9, the relative precision loss in P due to floor division is only on the
 * order of 1e-9.
 *
 * --- EPOCHS ---
 *
 * Whenever a liquidation fully empties the Stability Pool, all deposits should become 0. However, setting P to 0 would make P be 0
 * forever, and break all future reward calculations.
 *
 * So, every time the Stability Pool is emptied by a liquidation, we reset P = 1 and currentScale = 0, and increment the currentEpoch by 1.
 *
 * --- TRACKING DEPOSIT OVER SCALE CHANGES AND EPOCHS ---
 *
 * When a deposit is made, it gets snapshots of the currentEpoch and the currentScale.
 *
 * When calculating a compounded deposit, we compare the current epoch to the deposit's epoch snapshot. If the current epoch is newer,
 * then the deposit was present during a pool-emptying liquidation, and necessarily has been depleted to 0.
 *
 * Otherwise, we then compare the current scale to the deposit's scale snapshot. If they're equal, the compounded deposit is given by d_t * P/P_t.
 * If it spans one scale change, it is given by d_t * P/(P_t * 1e9). If it spans more than one scale change, we define the compounded deposit
 * as 0, since it is now less than 1e-9'th of its initial value (e.g. a deposit of 1 billion USDD has depleted to < 1 USDD).
 *
 *
 *  --- TRACKING DEPOSITOR'S COLL GAIN OVER SCALE CHANGES AND EPOCHS ---
 *
 * In the current epoch, the latest value of S is stored upon each scale change, and the mapping (scale -> S) is stored for each epoch.
 *
 * This allows us to calculate a deposit's accumulated COLL gain, during the epoch in which the deposit was non-zero and earned COLL.
 *
 * We calculate the depositor's accumulated COLL gain for the scale at which they made the deposit, using the COLL gain formula:
 * e_1 = d_t * (S - S_t) / P_t
 *
 * and also for scale after, taking care to divide the latter by a factor of 1e9:
 * e_2 = d_t * S / (P_t * 1e9)
 *
 * The gain in the second scale will be full, as the starting point was in the previous scale, thus no need to subtract anything.
 * The deposit therefore was present for reward events from the beginning of that second scale.
 *
 *        S_i-S_t + S_{i+1}
 *      .<--------.------------>
 *      .         .
 *      . S_i     .   S_{i+1}
 *   <--.-------->.<----------->
 *   S_t.         .
 *   <->.         .
 *      t         .
 *  |---+---------|-------------|-----...
 *         i            i+1
 *
 * The sum of (e_1 + e_2) captures the depositor's total accumulated COLL gain, handling the case where their
 * deposit spanned one scale change. We only care about gains across one scale change, since the compounded
 * deposit is defined as being 0 once it has spanned more than one scale change.
 *
 *
 * --- UPDATING P WHEN A LIQUIDATION OCCURS ---
 *
 * Please see the implementation spec in the proof document, which closely follows on from the compounded deposit / COLL gain derivations:
 * https://github.com/liquity/liquity/blob/master/papers/Scalable_Reward_Distribution_with_Compounding_Stakes.pdf
 *
 *
 * --- DEFT ISSUANCE TO STABILITY POOL DEPOSITORS ---
 *
 * An DEFT issuance event occurs at every deposit operation, and every liquidation.
 *
 * Each deposit is tagged with the address of the front end through which it was made.
 *
 * All deposits earn a share of the issued DEFT in proportion to the deposit as a share of total deposits. The DEFT earned
 * by a given deposit, is split between the depositor and the front end through which the deposit was made, based on the front end's kickbackRate.
 *
 * Please see the system Readme for an overview:
 * https://github.com/liquity/dev/blob/main/README.md#deft-issuance-to-stability-providers
 *
 * We use the same mathematical product-sum approach to track DEFT gains for depositors, where 'G' is the sum corresponding to DEFT gains.
 * The product P (and snapshot P_t) is re-used, as the ratio P/P_t tracks a deposit's depletion due to liquidations.
 *
 */
contract StabilityPool is LiquityBase, Ownable, CheckContract, IStabilityPool {
    using LiquitySafeMath128 for uint128;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    string public constant NAME = "StabilityPool";

    address public override collToken;

    IBorrowerOperations public borrowerOperations;

    address wETHGatewayAddress;

    ITroveManager public troveManager;

    IUSDDToken public usddToken;

    // Needed to check if there are pending liquidations
    ISortedTroves public sortedTroves;

    ICommunityIssuance public communityIssuance;

    uint256 internal COLL; // deposited ether tracker

    // Tracker for USDD held in the pool. Changes when users deposit/withdraw, and when Trove debt is offset.
    uint256 internal totalUSDDDeposits;

    // --- Data structures ---

    struct FrontEnd {
        uint256 kickbackRate;
        bool registered;
    }

    struct Deposit {
        uint256 initialValue;
        address frontEndTag;
    }

    struct Snapshots {
        uint256 S;
        uint256 P;
        uint256 G;
        uint128 scale;
        uint128 epoch;
    }

    mapping(address => Deposit) public deposits; // depositor address -> Deposit struct
    mapping(address => Snapshots) public depositSnapshots; // depositor address -> snapshots struct

    mapping(address => FrontEnd) public frontEnds; // front end address -> FrontEnd struct
    mapping(address => uint256) public frontEndStakes; // front end address -> last recorded total deposits, tagged with that front end
    mapping(address => Snapshots) public frontEndSnapshots; // front end address -> snapshots struct

    /*  Product 'P': Running product by which to multiply an initial deposit, in order to find the current compounded deposit,
     * after a series of liquidations have occurred, each of which cancel some USDD debt with the deposit.
     *
     * During its lifetime, a deposit's value evolves from d_t to d_t * P / P_t , where P_t
     * is the snapshot of P taken at the instant the deposit was made. 18-digit decimal.
     */
    uint256 public P = DECIMAL_PRECISION;

    uint256 public constant SCALE_FACTOR = 1e9;

    // Each time the scale of P shifts by SCALE_FACTOR, the scale is incremented by 1
    uint128 public currentScale;

    // With each offset that fully empties the Pool, the epoch is incremented by 1
    uint128 public currentEpoch;

    /* COLL Gain sum 'S': During its lifetime, each deposit d_t earns an COLL gain of ( d_t * [S - S_t] )/P_t, where S_t
     * is the depositor's snapshot of S taken at the time t when the deposit was made.
     *
     * The 'S' sums are stored in a nested mapping (epoch => scale => sum):
     *
     * - The inner mapping records the sum S at different scales
     * - The outer mapping records the (scale => sum) mappings, for different epochs.
     */
    mapping(uint128 => mapping(uint128 => uint256)) public epochToScaleToSum;

    /*
     * Similarly, the sum 'G' is used to calculate DEFT gains. During it's lifetime, each deposit d_t earns a DEFT gain of
     *  ( d_t * [G - G_t] )/P_t, where G_t is the depositor's snapshot of G taken at time t when  the deposit was made.
     *
     *  DEFT reward events occur are triggered by depositor operations (new deposit, topup, withdrawal), and liquidations.
     *  In each case, the DEFT reward is issued (i.e. G is updated), before other state changes are made.
     */
    mapping(uint128 => mapping(uint128 => uint256)) public epochToScaleToG;

    // Error tracker for the error correction in the DEFT issuance calculation
    uint256 public lastDEFTError;
    // Error trackers for the error correction in the offset calculation
    uint256 public lastCollError_Offset;
    uint256 public lastUSDDLossError_Offset;

    // --- Events ---

    event StabilityPoolCollBalanceUpdated(uint256 _newBalance);
    event StabilityPoolUSDDBalanceUpdated(uint256 _newBalance);

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);
    event DefaultPoolAddressChanged(address _newDefaultPoolAddress);
    event USDDTokenAddressChanged(address _newUSDDTokenAddress);
    event SortedTrovesAddressChanged(address _newSortedTrovesAddress);
    event PriceFeedAddressChanged(address _newPriceFeedAddress);
    event CommunityIssuanceAddressChanged(address _newCommunityIssuanceAddress);

    event P_Updated(uint256 _P);
    event S_Updated(uint256 _S, uint128 _epoch, uint128 _scale);
    event G_Updated(uint256 _G, uint128 _epoch, uint128 _scale);
    event EpochUpdated(uint128 _currentEpoch);
    event ScaleUpdated(uint128 _currentScale);

    event FrontEndRegistered(address indexed _frontEnd, uint256 _kickbackRate);
    event FrontEndTagSet(address indexed _depositor, address indexed _frontEnd);

    event DepositSnapshotUpdated(address indexed _depositor, uint256 _P, uint256 _S, uint256 _G);
    event FrontEndSnapshotUpdated(address indexed _frontEnd, uint256 _P, uint256 _G);
    event UserDepositChanged(address indexed _depositor, uint256 _newDeposit);
    event FrontEndStakeChanged(
        address indexed _frontEnd,
        uint256 _newFrontEndStake,
        address _depositor
    );

    event CollGainWithdrawn(address indexed _depositor, uint256 _collAmount, uint256 _USDDLoss);
    event DEFTPaidToDepositor(address indexed _depositor, uint256 _DEFT);
    event DEFTPaidToFrontEnd(address indexed _frontEnd, uint256 _DEFT);
    event CollTokenSent(address _to, uint256 _amount);

    // --- Contract setters ---

    function setAddresses(
        address _collTokenAddress,
        address _wETHGatewayAddress,
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _usddTokenAddress,
        address _sortedTrovesAddress,
        address _priceFeedAddress,
        address _communityIssuanceAddress
    ) external override onlyOwner {
        checkContract(_collTokenAddress);
        checkContract(_wETHGatewayAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_usddTokenAddress);
        checkContract(_sortedTrovesAddress);
        checkContract(_priceFeedAddress);
        checkContract(_communityIssuanceAddress);

        collToken = _collTokenAddress;
        wETHGatewayAddress = _wETHGatewayAddress;
        borrowerOperations = IBorrowerOperations(_borrowerOperationsAddress);
        troveManager = ITroveManager(_troveManagerAddress);
        activePool = IActivePool(_activePoolAddress);
        usddToken = IUSDDToken(_usddTokenAddress);
        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        communityIssuance = ICommunityIssuance(_communityIssuanceAddress);

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit USDDTokenAddressChanged(_usddTokenAddress);
        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit CommunityIssuanceAddressChanged(_communityIssuanceAddress);

        IERC20(collToken).approve(_borrowerOperationsAddress, type(uint256).max);
        _renounceOwnership();
    }

    // --- Getters for public variables. Required by IPool interface ---

    function getColl() external view override returns (uint256) {
        return COLL;
    }

    function getTotalUSDDDeposits() external view override returns (uint256) {
        return totalUSDDDeposits;
    }

    function provideToSP(
        address _depositor,
        uint256 _amount,
        address _frontEndTag
    ) external override {
        _provideToSP(_depositor, _amount, _frontEndTag);
    }

    function provideToSP(uint256 _amount, address _frontEndTag) external override {
        _provideToSP(msg.sender, _amount, _frontEndTag);
    }

    // --- External Depositor Functions ---

    /*  provideToSP():
     *
     * - Triggers a DEFT issuance, based on time passed since the last issuance. The DEFT issuance is shared between *all* depositors and front ends
     * - Tags the deposit with the provided front end tag param, if it's a new deposit
     * - Sends depositor's accumulated gains (DEFT, COLL) to depositor
     * - Sends the tagged front end's accumulated DEFT gains to the tagged front end
     * - Increases deposit and tagged front end's stake, and takes new snapshots for each.
     */
    function _provideToSP(
        address _depositor,
        uint256 _amount,
        address _frontEndTag
    ) internal {
        _requireCallerIsBorrowerOrGw(_depositor);
        _requireFrontEndIsRegisteredOrZero(_frontEndTag);
        _requireFrontEndNotRegistered(_depositor);
        _requireNonZeroAmount(_amount);

        uint256 initialDeposit = deposits[_depositor].initialValue;

        ICommunityIssuance communityIssuanceCached = communityIssuance;

        _triggerDEFTIssuance(communityIssuanceCached);

        if (initialDeposit == 0) {
            _setFrontEndTag(_depositor, _frontEndTag);
        }
        uint256 depositorCollGain = getDepositorCollGain(_depositor);
        uint256 compoundedUSDDDeposit = getCompoundedUSDDDeposit(_depositor);
        uint256 USDDLoss = initialDeposit.sub(compoundedUSDDDeposit); // Needed only for event log

        // First pay out any DEFT gains
        address frontEnd = deposits[_depositor].frontEndTag;
        _payOutDEFTGains(communityIssuanceCached, _depositor, frontEnd);

        // Update front end stake
        uint256 compoundedFrontEndStake = getCompoundedFrontEndStake(frontEnd);
        uint256 newFrontEndStake = compoundedFrontEndStake.add(_amount);
        _updateFrontEndStakeAndSnapshots(frontEnd, newFrontEndStake);
        emit FrontEndStakeChanged(frontEnd, newFrontEndStake, _depositor);

        _sendUSDDtoStabilityPool(_depositor, _amount);

        uint256 newDeposit = compoundedUSDDDeposit.add(_amount);
        _updateDepositAndSnapshots(_depositor, newDeposit);
        emit UserDepositChanged(_depositor, newDeposit);

        emit CollGainWithdrawn(_depositor, depositorCollGain, USDDLoss); // USDD Loss required for event log

        _sendCollGainToDepositor(depositorCollGain);
    }

    function withdrawFromSP(address _depositor, uint256 _amount) external override {
        _withdrawFromSP(_depositor, _amount);
    }

    function withdrawFromSP(uint256 _amount) external override {
        _withdrawFromSP(msg.sender, _amount);
    }

    /*  withdrawFromSP():
     *
     * - Triggers a DEFT issuance, based on time passed since the last issuance. The DEFT issuance is shared between *all* depositors and front ends
     * - Removes the deposit's front end tag if it is a full withdrawal
     * - Sends all depositor's accumulated gains (DEFT, COLL) to depositor
     * - Sends the tagged front end's accumulated DEFT gains to the tagged front end
     * - Decreases deposit and tagged front end's stake, and takes new snapshots for each.
     *
     * If _amount > userDeposit, the user withdraws all of their compounded deposit.
     */
    function _withdrawFromSP(address _depositor, uint256 _amount) internal {
        _requireCallerIsBorrowerOrGw(_depositor);
        if (_amount != 0) {
            _requireNoUnderCollateralizedTroves();
        }
        uint256 initialDeposit = deposits[_depositor].initialValue;
        _requireUserHasDeposit(initialDeposit);

        ICommunityIssuance communityIssuanceCached = communityIssuance;

        _triggerDEFTIssuance(communityIssuanceCached);

        uint256 depositorCollGain = getDepositorCollGain(_depositor);

        uint256 compoundedUSDDDeposit = getCompoundedUSDDDeposit(_depositor);
        uint256 USDDtoWithdraw = LiquityMath._min(_amount, compoundedUSDDDeposit);
        uint256 USDDLoss = initialDeposit.sub(compoundedUSDDDeposit); // Needed only for event log

        // First pay out any DEFT gains
        address frontEnd = deposits[_depositor].frontEndTag;
        _payOutDEFTGains(communityIssuanceCached, _depositor, frontEnd);

        // Update front end stake
        uint256 compoundedFrontEndStake = getCompoundedFrontEndStake(frontEnd);
        uint256 newFrontEndStake = compoundedFrontEndStake.sub(USDDtoWithdraw);
        _updateFrontEndStakeAndSnapshots(frontEnd, newFrontEndStake);
        emit FrontEndStakeChanged(frontEnd, newFrontEndStake, _depositor);

        _sendUSDDToDepositor(_depositor, USDDtoWithdraw);

        // Update deposit
        uint256 newDeposit = compoundedUSDDDeposit.sub(USDDtoWithdraw);
        _updateDepositAndSnapshots(_depositor, newDeposit);
        emit UserDepositChanged(_depositor, newDeposit);

        emit CollGainWithdrawn(_depositor, depositorCollGain, USDDLoss); // USDD Loss required for event log

        _sendCollGainToDepositor(depositorCollGain);
    }

    /* withdrawCollGainToTrove:
     * - Triggers a DEFT issuance, based on time passed since the last issuance. The DEFT issuance is shared between *all* depositors and front ends
     * - Sends all depositor's DEFT gain to  depositor
     * - Sends all tagged front end's DEFT gain to the tagged front end
     * - Transfers the depositor's entire COLL gain from the Stability Pool to the caller's trove
     * - Leaves their compounded deposit in the Stability Pool
     * - Updates snapshots for deposit and tagged front end stake */
    function withdrawCollGainToTrove(address _upperHint, address _lowerHint) external override {
        uint256 initialDeposit = deposits[msg.sender].initialValue;
        _requireUserHasDeposit(initialDeposit);
        _requireUserHasTrove(msg.sender);
        _requireUserHasCollGain(msg.sender);

        ICommunityIssuance communityIssuanceCached = communityIssuance;

        _triggerDEFTIssuance(communityIssuanceCached);

        uint256 depositorCollGain = getDepositorCollGain(msg.sender);

        uint256 compoundedUSDDDeposit = getCompoundedUSDDDeposit(msg.sender);
        uint256 USDDLoss = initialDeposit.sub(compoundedUSDDDeposit); // Needed only for event log

        // First pay out any DEFT gains
        address frontEnd = deposits[msg.sender].frontEndTag;
        _payOutDEFTGains(communityIssuanceCached, msg.sender, frontEnd);

        // Update front end stake
        uint256 compoundedFrontEndStake = getCompoundedFrontEndStake(frontEnd);
        uint256 newFrontEndStake = compoundedFrontEndStake;
        _updateFrontEndStakeAndSnapshots(frontEnd, newFrontEndStake);
        emit FrontEndStakeChanged(frontEnd, newFrontEndStake, msg.sender);

        _updateDepositAndSnapshots(msg.sender, compoundedUSDDDeposit);

        /* Emit events before transferring COLL gain to Trove.
         This lets the event log make more sense (i.e. so it appears that first the COLL gain is withdrawn
        and then it is deposited into the Trove, not the other way around). */
        emit CollGainWithdrawn(msg.sender, depositorCollGain, USDDLoss);
        emit UserDepositChanged(msg.sender, compoundedUSDDDeposit);

        COLL = COLL.sub(depositorCollGain);
        emit StabilityPoolCollBalanceUpdated(COLL);
        emit CollTokenSent(msg.sender, depositorCollGain);

        borrowerOperations.moveCollGainToTrove(
            msg.sender,
            depositorCollGain,
            _upperHint,
            _lowerHint
        );
    }

    // --- DEFT issuance functions ---

    function _triggerDEFTIssuance(ICommunityIssuance _communityIssuance) internal {
        uint256 DEFTIssuance = _communityIssuance.issueDEFT();
        _updateG(DEFTIssuance);
    }

    function _updateG(uint256 _DEFTIssuance) internal {
        uint256 totalUSDD = totalUSDDDeposits; // cached to save an SLOAD
        /*
         * When total deposits is 0, G is not updated. In this case, the DEFT issued can not be obtained by later
         * depositors - it is missed out on, and remains in the balanceof the CommunityIssuance contract.
         *
         */
        if (totalUSDD == 0 || _DEFTIssuance == 0) {
            return;
        }

        uint256 DEFTPerUnitStaked;
        DEFTPerUnitStaked = _computeDEFTPerUnitStaked(_DEFTIssuance, totalUSDD);

        uint256 marginalDEFTGain = DEFTPerUnitStaked.mul(P);
        epochToScaleToG[currentEpoch][currentScale] = epochToScaleToG[currentEpoch][currentScale]
            .add(marginalDEFTGain);

        emit G_Updated(epochToScaleToG[currentEpoch][currentScale], currentEpoch, currentScale);
    }

    function _computeDEFTPerUnitStaked(uint256 _DEFTIssuance, uint256 _totalUSDDDeposits)
        internal
        returns (uint256)
    {
        /*
         * Calculate the DEFT-per-unit staked.  Division uses a "feedback" error correction, to keep the
         * cumulative error low in the running total G:
         *
         * 1) Form a numerator which compensates for the floor division error that occurred the last time this
         * function was called.
         * 2) Calculate "per-unit-staked" ratio.
         * 3) Multiply the ratio back by its denominator, to reveal the current floor division error.
         * 4) Store this error for use in the next correction when this function is called.
         * 5) Note: static analysis tools complain about this "division before multiplication", however, it is intended.
         */
        uint256 DEFTNumerator = _DEFTIssuance.mul(DECIMAL_PRECISION).add(lastDEFTError);

        uint256 DEFTPerUnitStaked = DEFTNumerator.div(_totalUSDDDeposits);
        lastDEFTError = DEFTNumerator.sub(DEFTPerUnitStaked.mul(_totalUSDDDeposits));

        return DEFTPerUnitStaked;
    }

    // --- Liquidation functions ---

    /*
     * Cancels out the specified debt against the USDD contained in the Stability Pool (as far as possible)
     * and transfers the Trove's COLL collateral from ActivePool to StabilityPool.
     * Only called by liquidation functions in the TroveManager.
     */
    function offset(uint256 _debtToOffset, uint256 _collToAdd) external override {
        _requireCallerIsTroveManager();
        uint256 totalUSDD = totalUSDDDeposits; // cached to save an SLOAD
        if (totalUSDD == 0 || _debtToOffset == 0) {
            return;
        }

        _triggerDEFTIssuance(communityIssuance);

        (
            uint256 CollGainPerUnitStaked,
            uint256 USDDLossPerUnitStaked
        ) = _computeRewardsPerUnitStaked(_collToAdd, _debtToOffset, totalUSDD);

        _updateRewardSumAndProduct(CollGainPerUnitStaked, USDDLossPerUnitStaked); // updates S and P

        _moveOffsetCollAndDebt(_collToAdd, _debtToOffset);
    }

    // --- Offset helper functions ---

    function _computeRewardsPerUnitStaked(
        uint256 _collToAdd,
        uint256 _debtToOffset,
        uint256 _totalUSDDDeposits
    ) internal returns (uint256 CollGainPerUnitStaked, uint256 USDDLossPerUnitStaked) {
        /*
         * Compute the USDD and COLL rewards. Uses a "feedback" error correction, to keep
         * the cumulative error in the P and S state variables low:
         *
         * 1) Form numerators which compensate for the floor division errors that occurred the last time this
         * function was called.
         * 2) Calculate "per-unit-staked" ratios.
         * 3) Multiply each ratio back by its denominator, to reveal the current floor division error.
         * 4) Store these errors for use in the next correction when this function is called.
         * 5) Note: static analysis tools complain about this "division before multiplication", however, it is intended.
         */
        uint256 CollNumerator = _collToAdd.mul(DECIMAL_PRECISION).add(lastCollError_Offset);

        assert(_debtToOffset <= _totalUSDDDeposits);
        if (_debtToOffset == _totalUSDDDeposits) {
            USDDLossPerUnitStaked = DECIMAL_PRECISION; // When the Pool depletes to 0, so does each deposit
            lastUSDDLossError_Offset = 0;
        } else {
            uint256 USDDLossNumerator = _debtToOffset.mul(DECIMAL_PRECISION).sub(
                lastUSDDLossError_Offset
            );
            /*
             * Add 1 to make error in quotient positive. We want "slightly too much" USDD loss,
             * which ensures the error in any given compoundedUSDDDeposit favors the Stability Pool.
             */
            USDDLossPerUnitStaked = (USDDLossNumerator.div(_totalUSDDDeposits)).add(1);
            lastUSDDLossError_Offset = (USDDLossPerUnitStaked.mul(_totalUSDDDeposits)).sub(
                USDDLossNumerator
            );
        }

        CollGainPerUnitStaked = CollNumerator.div(_totalUSDDDeposits);
        lastCollError_Offset = CollNumerator.sub(CollGainPerUnitStaked.mul(_totalUSDDDeposits));

        return (CollGainPerUnitStaked, USDDLossPerUnitStaked);
    }

    // Update the Stability Pool reward sum S and product P
    function _updateRewardSumAndProduct(
        uint256 _CollGainPerUnitStaked,
        uint256 _USDDLossPerUnitStaked
    ) internal {
        uint256 currentP = P;
        uint256 newP;

        assert(_USDDLossPerUnitStaked <= DECIMAL_PRECISION);
        /*
         * The newProductFactor is the factor by which to change all deposits, due to the depletion of Stability Pool USDD in the liquidation.
         * We make the product factor 0 if there was a pool-emptying. Otherwise, it is (1 - USDDLossPerUnitStaked)
         */
        uint256 newProductFactor = uint256(DECIMAL_PRECISION).sub(_USDDLossPerUnitStaked);

        uint128 currentScaleCached = currentScale;
        uint128 currentEpochCached = currentEpoch;
        uint256 currentS = epochToScaleToSum[currentEpochCached][currentScaleCached];

        /*
         * Calculate the new S first, before we update P.
         * The COLL gain for any given depositor from a liquidation depends on the value of their deposit
         * (and the value of totalDeposits) prior to the Stability being depleted by the debt in the liquidation.
         *
         * Since S corresponds to COLL gain, and P to deposit loss, we update S first.
         */
        uint256 marginalCollGain = _CollGainPerUnitStaked.mul(currentP);
        uint256 newS = currentS.add(marginalCollGain);
        epochToScaleToSum[currentEpochCached][currentScaleCached] = newS;
        emit S_Updated(newS, currentEpochCached, currentScaleCached);

        // If the Stability Pool was emptied, increment the epoch, and reset the scale and product P
        if (newProductFactor == 0) {
            currentEpoch = currentEpochCached.add(1);
            emit EpochUpdated(currentEpoch);
            currentScale = 0;
            emit ScaleUpdated(currentScale);
            newP = DECIMAL_PRECISION;

            // If multiplying P by a non-zero product factor would reduce P below the scale boundary, increment the scale
        } else if (currentP.mul(newProductFactor).div(DECIMAL_PRECISION) < SCALE_FACTOR) {
            newP = currentP.mul(newProductFactor).mul(SCALE_FACTOR).div(DECIMAL_PRECISION);
            currentScale = currentScaleCached.add(1);
            emit ScaleUpdated(currentScale);
        } else {
            newP = currentP.mul(newProductFactor).div(DECIMAL_PRECISION);
        }

        assert(newP > 0);
        P = newP;

        emit P_Updated(newP);
    }

    function _moveOffsetCollAndDebt(uint256 _collToAdd, uint256 _debtToOffset) internal {
        IActivePool activePoolCached = activePool;

        // Cancel the liquidated USDD debt with the USDD in the stability pool
        activePoolCached.decreaseUSDDDebt(_debtToOffset);
        _decreaseUSDD(_debtToOffset);

        // Burn the debt that was successfully offset
        usddToken.burn(address(this), _debtToOffset);

        activePoolCached.sendColl(address(this), collToken, _collToAdd);
        COLL = COLL.add(_collToAdd);
        emit StabilityPoolCollBalanceUpdated(COLL);
    }

    function _decreaseUSDD(uint256 _amount) internal {
        uint256 newTotalUSDDDeposits = totalUSDDDeposits.sub(_amount);
        totalUSDDDeposits = newTotalUSDDDeposits;
        emit StabilityPoolUSDDBalanceUpdated(newTotalUSDDDeposits);
    }

    // --- Reward calculator functions for depositor and front end ---

    /* Calculates the COLL gain earned by the deposit since its last snapshots were taken.
     * Given by the formula:  E = d0 * (S - S(0))/P(0)
     * where S(0) and P(0) are the depositor's snapshots of the sum S and product P, respectively.
     * d0 is the last recorded deposit value.
     */
    function getDepositorCollGain(address _depositor) public view override returns (uint256) {
        uint256 initialDeposit = deposits[_depositor].initialValue;

        if (initialDeposit == 0) {
            return 0;
        }

        Snapshots memory snapshots = depositSnapshots[_depositor];

        uint256 CollGain = _getCollGainFromSnapshots(initialDeposit, snapshots);
        return CollGain;
    }

    function _getCollGainFromSnapshots(uint256 initialDeposit, Snapshots memory snapshots)
        internal
        view
        returns (uint256)
    {
        /*
         * Grab the sum 'S' from the epoch at which the stake was made. The COLL gain may span up to one scale change.
         * If it does, the second portion of the COLL gain is scaled by 1e9.
         * If the gain spans no scale change, the second portion will be 0.
         */
        uint128 epochSnapshot = snapshots.epoch;
        uint128 scaleSnapshot = snapshots.scale;
        uint256 S_Snapshot = snapshots.S;
        uint256 P_Snapshot = snapshots.P;

        uint256 firstPortion = epochToScaleToSum[epochSnapshot][scaleSnapshot].sub(S_Snapshot);
        uint256 secondPortion = epochToScaleToSum[epochSnapshot][scaleSnapshot.add(1)].div(
            SCALE_FACTOR
        );

        uint256 CollGain = initialDeposit.mul(firstPortion.add(secondPortion)).div(P_Snapshot).div(
            DECIMAL_PRECISION
        );

        return CollGain;
    }

    /*
     * Calculate the DEFT gain earned by a deposit since its last snapshots were taken.
     * Given by the formula:  DEFT = d0 * (G - G(0))/P(0)
     * where G(0) and P(0) are the depositor's snapshots of the sum G and product P, respectively.
     * d0 is the last recorded deposit value.
     */
    function getDepositorDEFTGain(address _depositor) public view override returns (uint256) {
        uint256 initialDeposit = deposits[_depositor].initialValue;
        if (initialDeposit == 0) {
            return 0;
        }

        address frontEndTag = deposits[_depositor].frontEndTag;

        /*
         * If not tagged with a front end, the depositor gets a 100% cut of what their deposit earned.
         * Otherwise, their cut of the deposit's earnings is equal to the kickbackRate, set by the front end through
         * which they made their deposit.
         */
        uint256 kickbackRate = frontEndTag == address(0)
            ? DECIMAL_PRECISION
            : frontEnds[frontEndTag].kickbackRate;

        Snapshots memory snapshots = depositSnapshots[_depositor];

        uint256 DEFTGain = kickbackRate
            .mul(_getDEFTGainFromSnapshots(initialDeposit, snapshots))
            .div(DECIMAL_PRECISION);

        return DEFTGain;
    }

    /*
     * Return the DEFT gain earned by the front end. Given by the formula:  E = D0 * (G - G(0))/P(0)
     * where G(0) and P(0) are the depositor's snapshots of the sum G and product P, respectively.
     *
     * D0 is the last recorded value of the front end's total tagged deposits.
     */
    function getFrontEndDEFTGain(address _frontEnd) public view override returns (uint256) {
        uint256 frontEndStake = frontEndStakes[_frontEnd];
        if (frontEndStake == 0) {
            return 0;
        }

        uint256 kickbackRate = frontEnds[_frontEnd].kickbackRate;
        uint256 frontEndShare = uint256(DECIMAL_PRECISION).sub(kickbackRate);

        Snapshots memory snapshots = frontEndSnapshots[_frontEnd];

        uint256 DEFTGain = frontEndShare
            .mul(_getDEFTGainFromSnapshots(frontEndStake, snapshots))
            .div(DECIMAL_PRECISION);
        return DEFTGain;
    }

    function _getDEFTGainFromSnapshots(uint256 initialStake, Snapshots memory snapshots)
        internal
        view
        returns (uint256)
    {
        /*
         * Grab the sum 'G' from the epoch at which the stake was made. The DEFT gain may span up to one scale change.
         * If it does, the second portion of the DEFT gain is scaled by 1e9.
         * If the gain spans no scale change, the second portion will be 0.
         */
        uint128 epochSnapshot = snapshots.epoch;
        uint128 scaleSnapshot = snapshots.scale;
        uint256 G_Snapshot = snapshots.G;
        uint256 P_Snapshot = snapshots.P;

        uint256 firstPortion = epochToScaleToG[epochSnapshot][scaleSnapshot].sub(G_Snapshot);
        uint256 secondPortion = epochToScaleToG[epochSnapshot][scaleSnapshot.add(1)].div(
            SCALE_FACTOR
        );

        uint256 DEFTGain = initialStake.mul(firstPortion.add(secondPortion)).div(P_Snapshot).div(
            DECIMAL_PRECISION
        );

        return DEFTGain;
    }

    // --- Compounded deposit and compounded front end stake ---

    /*
     * Return the user's compounded deposit. Given by the formula:  d = d0 * P/P(0)
     * where P(0) is the depositor's snapshot of the product P, taken when they last updated their deposit.
     */
    function getCompoundedUSDDDeposit(address _depositor) public view override returns (uint256) {
        uint256 initialDeposit = deposits[_depositor].initialValue;
        if (initialDeposit == 0) {
            return 0;
        }

        Snapshots memory snapshots = depositSnapshots[_depositor];

        uint256 compoundedDeposit = _getCompoundedStakeFromSnapshots(initialDeposit, snapshots);
        return compoundedDeposit;
    }

    /*
     * Return the front end's compounded stake. Given by the formula:  D = D0 * P/P(0)
     * where P(0) is the depositor's snapshot of the product P, taken at the last time
     * when one of the front end's tagged deposits updated their deposit.
     *
     * The front end's compounded stake is equal to the sum of its depositors' compounded deposits.
     */
    function getCompoundedFrontEndStake(address _frontEnd) public view override returns (uint256) {
        uint256 frontEndStake = frontEndStakes[_frontEnd];
        if (frontEndStake == 0) {
            return 0;
        }

        Snapshots memory snapshots = frontEndSnapshots[_frontEnd];

        uint256 compoundedFrontEndStake = _getCompoundedStakeFromSnapshots(frontEndStake, snapshots);
        return compoundedFrontEndStake;
    }

    // Internal function, used to calculcate compounded deposits and compounded front end stakes.
    function _getCompoundedStakeFromSnapshots(uint256 initialStake, Snapshots memory snapshots)
        internal
        view
        returns (uint256)
    {
        uint256 snapshot_P = snapshots.P;
        uint128 scaleSnapshot = snapshots.scale;
        uint128 epochSnapshot = snapshots.epoch;

        // If stake was made before a pool-emptying event, then it has been fully cancelled with debt -- so, return 0
        if (epochSnapshot < currentEpoch) {
            return 0;
        }

        uint256 compoundedStake;
        uint128 scaleDiff = currentScale.sub(scaleSnapshot);

        /* Compute the compounded stake. If a scale change in P was made during the stake's lifetime,
         * account for it. If more than one scale change was made, then the stake has decreased by a factor of
         * at least 1e-9 -- so return 0.
         */
        if (scaleDiff == 0) {
            compoundedStake = initialStake.mul(P).div(snapshot_P);
        } else if (scaleDiff == 1) {
            compoundedStake = initialStake.mul(P).div(snapshot_P).div(SCALE_FACTOR);
        } else {
            // if scaleDiff >= 2
            compoundedStake = 0;
        }

        /*
         * If compounded deposit is less than a billionth of the initial deposit, return 0.
         *
         * NOTE: originally, this line was in place to stop rounding errors making the deposit too large. However, the error
         * corrections should ensure the error in P "favors the Pool", i.e. any given compounded deposit should slightly less
         * than it's theoretical value.
         *
         * Thus it's unclear whether this line is still really needed.
         */
        if (compoundedStake < initialStake.div(1e9)) {
            return 0;
        }

        return compoundedStake;
    }

    // --- Sender functions for USDD deposit, COLL gains and DEFT gains ---

    // Transfer the USDD tokens from the user to the Stability Pool's address, and update its recorded USDD
    function _sendUSDDtoStabilityPool(address _address, uint256 _amount) internal {
        usddToken.sendToPool(_address, address(this), _amount);
        uint256 newTotalUSDDDeposits = totalUSDDDeposits.add(_amount);
        totalUSDDDeposits = newTotalUSDDDeposits;
        emit StabilityPoolUSDDBalanceUpdated(newTotalUSDDDeposits);
    }

    function _sendCollGainToDepositor(uint256 _amount) internal {
        if (_amount == 0) {
            return;
        }
        uint256 newColl = COLL.sub(_amount);
        COLL = newColl;
        emit StabilityPoolCollBalanceUpdated(newColl);
        emit CollTokenSent(msg.sender, _amount);
        IERC20(collToken).safeTransfer(msg.sender, _amount);
    }

    // Send USDD to user and decrease USDD in Pool
    function _sendUSDDToDepositor(address _depositor, uint256 USDDWithdrawal) internal {
        if (USDDWithdrawal == 0) {
            return;
        }

        usddToken.returnFromPool(address(this), _depositor, USDDWithdrawal);
        _decreaseUSDD(USDDWithdrawal);
    }

    // --- External Front End functions ---

    // Front end makes a one-time selection of kickback rate upon registering
    function registerFrontEnd(uint256 _kickbackRate) external override {
        _requireFrontEndNotRegistered(msg.sender);
        _requireUserHasNoDeposit(msg.sender);
        _requireValidKickbackRate(_kickbackRate);

        frontEnds[msg.sender].kickbackRate = _kickbackRate;
        frontEnds[msg.sender].registered = true;

        emit FrontEndRegistered(msg.sender, _kickbackRate);
    }

    // --- Stability Pool Deposit Functionality ---

    function _setFrontEndTag(address _depositor, address _frontEndTag) internal {
        deposits[_depositor].frontEndTag = _frontEndTag;
        emit FrontEndTagSet(_depositor, _frontEndTag);
    }

    function _updateDepositAndSnapshots(address _depositor, uint256 _newValue) internal {
        deposits[_depositor].initialValue = _newValue;

        if (_newValue == 0) {
            delete deposits[_depositor].frontEndTag;
            delete depositSnapshots[_depositor];
            emit DepositSnapshotUpdated(_depositor, 0, 0, 0);
            return;
        }
        uint128 currentScaleCached = currentScale;
        uint128 currentEpochCached = currentEpoch;
        uint256 currentP = P;

        // Get S and G for the current epoch and current scale
        uint256 currentS = epochToScaleToSum[currentEpochCached][currentScaleCached];
        uint256 currentG = epochToScaleToG[currentEpochCached][currentScaleCached];

        // Record new snapshots of the latest running product P, sum S, and sum G, for the depositor
        depositSnapshots[_depositor].P = currentP;
        depositSnapshots[_depositor].S = currentS;
        depositSnapshots[_depositor].G = currentG;
        depositSnapshots[_depositor].scale = currentScaleCached;
        depositSnapshots[_depositor].epoch = currentEpochCached;

        emit DepositSnapshotUpdated(_depositor, currentP, currentS, currentG);
    }

    function _updateFrontEndStakeAndSnapshots(address _frontEnd, uint256 _newValue) internal {
        frontEndStakes[_frontEnd] = _newValue;

        if (_newValue == 0) {
            delete frontEndSnapshots[_frontEnd];
            emit FrontEndSnapshotUpdated(_frontEnd, 0, 0);
            return;
        }

        uint128 currentScaleCached = currentScale;
        uint128 currentEpochCached = currentEpoch;
        uint256 currentP = P;

        // Get G for the current epoch and current scale
        uint256 currentG = epochToScaleToG[currentEpochCached][currentScaleCached];

        // Record new snapshots of the latest running product P and sum G for the front end
        frontEndSnapshots[_frontEnd].P = currentP;
        frontEndSnapshots[_frontEnd].G = currentG;
        frontEndSnapshots[_frontEnd].scale = currentScaleCached;
        frontEndSnapshots[_frontEnd].epoch = currentEpochCached;

        emit FrontEndSnapshotUpdated(_frontEnd, currentP, currentG);
    }

    function _payOutDEFTGains(
        ICommunityIssuance _communityIssuance,
        address _depositor,
        address _frontEnd
    ) internal {
        // Pay out front end's DEFT gain
        if (_frontEnd != address(0)) {
            uint256 frontEndDEFTGain = getFrontEndDEFTGain(_frontEnd);
            _communityIssuance.sendDEFT(_frontEnd, frontEndDEFTGain);
            emit DEFTPaidToFrontEnd(_frontEnd, frontEndDEFTGain);
        }

        // Pay out depositor's DEFT gain
        uint256 depositorDEFTGain = getDepositorDEFTGain(_depositor);
        _communityIssuance.sendDEFT(_depositor, depositorDEFTGain);
        emit DEFTPaidToDepositor(_depositor, depositorDEFTGain);
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOrGw(address _borrower) internal view {
        require(
            msg.sender == _borrower || msg.sender == wETHGatewayAddress,
            "StabilityPool: Caller must be the borrower or gateway"
        );
    }

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == address(activePool), "StabilityPool: Caller is not ActivePool");
    }

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == address(troveManager), "StabilityPool: Caller is not TroveManager");
    }

    function _requireNoUnderCollateralizedTroves() internal {
        uint256 price = priceFeed.fetchPrice(collToken);
        address lowestTrove = sortedTroves.getLast();
        uint256 ICR = troveManager.getCurrentICR(lowestTrove, price);
        require(ICR >= MCR, "StabilityPool: Cannot withdraw while there are troves with ICR < MCR");
    }

    function _requireUserHasDeposit(uint256 _initialDeposit) internal pure {
        require(_initialDeposit > 0, "StabilityPool: User must have a non-zero deposit");
    }

    function _requireUserHasNoDeposit(address _address) internal view {
        uint256 initialDeposit = deposits[_address].initialValue;
        require(initialDeposit == 0, "StabilityPool: User must have no deposit");
    }

    function _requireNonZeroAmount(uint256 _amount) internal pure {
        require(_amount > 0, "StabilityPool: Amount must be non-zero");
    }

    function _requireUserHasTrove(address _depositor) internal view {
        require(
            troveManager.getTroveStatus(_depositor) == 1,
            "StabilityPool: caller must have an active trove to withdraw CollGain to"
        );
    }

    function _requireUserHasCollGain(address _depositor) internal view {
        uint256 CollGain = getDepositorCollGain(_depositor);
        require(CollGain > 0, "StabilityPool: caller must have non-zero COLL Gain");
    }

    function _requireFrontEndNotRegistered(address _address) internal view {
        require(
            !frontEnds[_address].registered,
            "StabilityPool: must not already be a registered front end"
        );
    }

    function _requireFrontEndIsRegisteredOrZero(address _address) internal view {
        require(
            frontEnds[_address].registered || _address == address(0),
            "StabilityPool: Tag must be a registered front end, or the zero address"
        );
    }

    function _requireValidKickbackRate(uint256 _kickbackRate) internal pure {
        require(
            _kickbackRate <= DECIMAL_PRECISION,
            "StabilityPool: Kickback rate must be in range [0,1]"
        );
    }
}
