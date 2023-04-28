// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IUSDDToken.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/IDEFTStaking.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/IERC20.sol";
import "./LPRewards/Dependencies/SafeERC20.sol";

// import "hardhat/console.sol";

contract BorrowerOperations is LiquityBase, Ownable, CheckContract, IBorrowerOperations {
    using SafeERC20 for IERC20;

    string public constant NAME = "BorrowerOperations";

    // --- Connected contract declarations ---

    address public override collToken;

    ITroveManager public troveManager;

    address wETHGatewayAddress;

    address stabilityPoolAddress;

    address gasPoolAddress;

    ICollSurplusPool collSurplusPool;

    IDEFTStaking public deftStaking;
    address public deftStakingAddress;

    IUSDDToken public usddToken;

    // A doubly linked list of Troves, sorted by their collateral ratios
    ISortedTroves public sortedTroves;

    /* --- Variable container structs  ---

    Used to hold, return and assign variables inside a function, in order to avoid the error:
    "CompilerError: Stack too deep". */

    struct LocalVariables_adjustTrove {
        uint256 price;
        uint256 collChange;
        uint256 netDebtChange;
        bool isCollIncrease;
        uint256 debt;
        uint256 coll;
        uint256 oldICR;
        uint256 newICR;
        uint256 newTCR;
        uint256 USDDFee;
        uint256 newDebt;
        uint256 newColl;
        uint256 stake;
    }

    struct LocalVariables_openTrove {
        uint256 price;
        uint256 USDDFee;
        uint256 netDebt;
        uint256 compositeDebt;
        uint256 ICR;
        uint256 NICR;
        uint256 stake;
        uint256 arrayIndex;
    }

    struct ContractsCache {
        ITroveManager troveManager;
        IActivePool activePool;
        IUSDDToken usddToken;
    }

    enum BorrowerOperation {
        openTrove,
        closeTrove,
        adjustTrove
    }

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event GasPoolAddressChanged(address _gasPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address _newPriceFeedAddress);
    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event USDDTokenAddressChanged(address _usddTokenAddress);
    event DEFTStakingAddressChanged(address _deftStakingAddress);

    event TroveCreated(address indexed _borrower, uint256 arrayIndex);
    event TroveUpdated(
        address indexed _borrower,
        uint256 _debt,
        uint256 _coll,
        uint256 stake,
        BorrowerOperation operation
    );
    event USDDBorrowingFeePaid(address indexed _borrower, uint256 _USDDFee);

    // --- Dependency setters ---

    function setAddresses(
        address _collTokenAddress,
        address _wETHGatewayAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _gasPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _sortedTrovesAddress,
        address _usddTokenAddress,
        address _deftStakingAddress
    ) external override onlyOwner {
        // This makes impossible to open a trove with zero withdrawn USDD
        assert(MIN_NET_DEBT > 0);
        checkContract(_collTokenAddress);
        checkContract(_wETHGatewayAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_gasPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_priceFeedAddress);
        checkContract(_sortedTrovesAddress);
        checkContract(_usddTokenAddress);
        checkContract(_deftStakingAddress);

        collToken = _collTokenAddress;
        wETHGatewayAddress = wETHGatewayAddress;
        troveManager = ITroveManager(_troveManagerAddress);
        activePool = IActivePool(_activePoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        stabilityPoolAddress = _stabilityPoolAddress;
        gasPoolAddress = _gasPoolAddress;
        collSurplusPool = ICollSurplusPool(_collSurplusPoolAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        usddToken = IUSDDToken(_usddTokenAddress);
        deftStakingAddress = _deftStakingAddress;
        deftStaking = IDEFTStaking(_deftStakingAddress);

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit GasPoolAddressChanged(_gasPoolAddress);
        emit CollSurplusPoolAddressChanged(_collSurplusPoolAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit USDDTokenAddressChanged(_usddTokenAddress);
        emit DEFTStakingAddressChanged(_deftStakingAddress);

        IERC20(collToken).approve(_activePoolAddress, type(uint256).max);
        _renounceOwnership();
    }

    // --- Borrower Trove Operations ---

    function openTrove(
        uint256 _maxFeePercentage,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _openTrove(msg.sender, _maxFeePercentage, _collAmount, _USDDAmount, _upperHint, _lowerHint);
    }

    function openTrove(
        address _onBehalfOf,
        uint256 _maxFeePercentage,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _openTrove(_onBehalfOf, _maxFeePercentage, _collAmount, _USDDAmount, _upperHint, _lowerHint);
    }

    function _openTrove(
        address _onBehalfOf,
        uint256 _maxFeePercentage,
        uint256 _collAmount,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) internal {
        ContractsCache memory contractsCache = ContractsCache(troveManager, activePool, usddToken);
        LocalVariables_openTrove memory vars;

        vars.price = priceFeed.fetchPrice(collToken);
        bool isRecoveryMode = _checkRecoveryMode(collToken, vars.price);

        _requireValidMaxFeePercentage(_maxFeePercentage, isRecoveryMode);
        _requireTroveisNotActive(contractsCache.troveManager, _onBehalfOf);

        vars.USDDFee;
        vars.netDebt = _USDDAmount;

        if (!isRecoveryMode) {
            vars.USDDFee = _triggerBorrowingFee(
                contractsCache.troveManager,
                contractsCache.usddToken,
                _USDDAmount,
                _maxFeePercentage
            );
            vars.netDebt = vars.netDebt.add(vars.USDDFee);
        }
        _requireAtLeastMinNetDebt(vars.netDebt);

        // ICR is based on the composite debt, i.e. the requested USDD amount + USDD borrowing fee + USDD gas comp.
        vars.compositeDebt = _getCompositeDebt(vars.netDebt);
        assert(vars.compositeDebt > 0);

        vars.ICR = LiquityMath._computeCR(_collAmount, vars.compositeDebt, vars.price);
        vars.NICR = LiquityMath._computeNominalCR(_collAmount, vars.compositeDebt);

        if (isRecoveryMode) {
            _requireICRisAboveCCR(vars.ICR);
        } else {
            _requireICRisAboveMCR(vars.ICR);
            uint256 newTCR = _getNewTCRFromTroveChange(
                _collAmount,
                true,
                vars.compositeDebt,
                true,
                vars.price
            ); // bools: coll increase, debt increase
            _requireNewTCRisAboveCCR(newTCR);
        }

        // Set the trove struct's properties
        contractsCache.troveManager.setTroveStatus(_onBehalfOf, 1);
        contractsCache.troveManager.increaseTroveColl(_onBehalfOf, _collAmount);
        contractsCache.troveManager.increaseTroveDebt(_onBehalfOf, vars.compositeDebt);

        contractsCache.troveManager.updateTroveRewardSnapshots(_onBehalfOf);
        vars.stake = contractsCache.troveManager.updateStakeAndTotalStakes(_onBehalfOf);

        sortedTroves.insert(_onBehalfOf, vars.NICR, _upperHint, _lowerHint);
        vars.arrayIndex = contractsCache.troveManager.addTroveOwnerToArray(_onBehalfOf);
        emit TroveCreated(_onBehalfOf, vars.arrayIndex);
        // Move the ether to the Active Pool, and mint the USDDAmount to the borrower
        _activePoolAddColl(contractsCache.activePool, _collAmount);
        _withdrawUSDD(
            contractsCache.activePool,
            contractsCache.usddToken,
            _onBehalfOf,
            _USDDAmount,
            vars.netDebt
        );
        // Move the USDD gas compensation to the Gas Pool
        _withdrawUSDD(
            contractsCache.activePool,
            contractsCache.usddToken,
            gasPoolAddress,
            USDD_GAS_COMPENSATION,
            USDD_GAS_COMPENSATION
        );

        emit TroveUpdated(
            _onBehalfOf,
            vars.compositeDebt,
            _collAmount,
            vars.stake,
            BorrowerOperation.openTrove
        );
        emit USDDBorrowingFeePaid(_onBehalfOf, vars.USDDFee);
    }

    // Send ETH as collateral to a trove
    function addColl(
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, _collAmount, 0, 0, false, _upperHint, _lowerHint, 0);
    }

    // Send ETH as collateral to a trove. Called by only the Stability Pool.
    function moveCollGainToTrove(
        address _borrower,
        uint256 _collAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _requireCallerIsStabilityPool();
        _adjustTrove(_borrower, _collAmount, 0, 0, false, _upperHint, _lowerHint, 0);
    }

    // Withdraw ETH collateral from a trove
    function withdrawColl(
        uint256 _collWithdrawal,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, 0, _collWithdrawal, 0, false, _upperHint, _lowerHint, 0);
    }

    // Withdraw USDD tokens from a trove: mint new USDD tokens to the owner, and increase the trove's debt accordingly
    function withdrawUSDD(
        uint256 _maxFeePercentage,
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, 0, 0, _USDDAmount, true, _upperHint, _lowerHint, _maxFeePercentage);
    }

    // Repay USDD tokens to a Trove: Burn the repaid USDD tokens, and reduce the trove's debt accordingly
    function repayUSDD(
        uint256 _USDDAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, 0, 0, _USDDAmount, false, _upperHint, _lowerHint, 0);
    }

    function adjustTrove(
        uint256 _maxFeePercentage,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _USDDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(
            msg.sender,
            _collDeposited,
            _collWithdrawal,
            _USDDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _maxFeePercentage
        );
    }

    function adjustTrove(
        address _onBehalfOf,
        uint256 _maxFeePercentage,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _USDDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(
            _onBehalfOf,
            _collDeposited,
            _collWithdrawal,
            _USDDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _maxFeePercentage
        );
    }

    /*
     * _adjustTrove(): Alongside a debt change, this function can perform either a collateral top-up or a collateral withdrawal.
     *
     * It therefore expects either a positive msg.value, or a positive _collWithdrawal argument.
     *
     * If both are positive, it will revert.
     */
    function _adjustTrove(
        address _onBehalfOf,
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _USDDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        uint256 _maxFeePercentage
    ) internal {
        _requireCallerIsBorrowerOrGwOrSP(_onBehalfOf);

        // Confirm pure ETH transfer from the Stability Pool to a trove
        if (msg.sender == stabilityPoolAddress) {
            assert(_collDeposited > 0 && _USDDChange == 0);
        }

        ContractsCache memory contractsCache = ContractsCache(troveManager, activePool, usddToken);
        LocalVariables_adjustTrove memory vars;

        vars.price = priceFeed.fetchPrice(collToken);
        bool isRecoveryMode = _checkRecoveryMode(collToken, vars.price);

        if (_isDebtIncrease) {
            _requireValidMaxFeePercentage(_maxFeePercentage, isRecoveryMode);
            _requireNonZeroDebtChange(_USDDChange);
        }
        _requireSingularCollChange(_collDeposited, _collWithdrawal);
        _requireNonZeroAdjustment(_collDeposited, _collWithdrawal, _USDDChange);
        _requireTroveisActive(contractsCache.troveManager, _onBehalfOf);

        contractsCache.troveManager.applyPendingRewards(_onBehalfOf);

        // Get the collChange based on whether or not ETH was sent in the transaction
        (vars.collChange, vars.isCollIncrease) = _getCollChange(_collDeposited, _collWithdrawal);

        vars.netDebtChange = _USDDChange;

        // If the adjustment incorporates a debt increase and system is in Normal Mode, then trigger a borrowing fee
        if (_isDebtIncrease && !isRecoveryMode) {
            vars.USDDFee = _triggerBorrowingFee(
                contractsCache.troveManager,
                contractsCache.usddToken,
                _USDDChange,
                _maxFeePercentage
            );
            vars.netDebtChange = vars.netDebtChange.add(vars.USDDFee); // The raw debt change includes the fee
        }

        vars.debt = contractsCache.troveManager.getTroveDebt(_onBehalfOf);
        vars.coll = contractsCache.troveManager.getTroveColl(_onBehalfOf);

        // Get the trove's old ICR before the adjustment, and what its new ICR will be after the adjustment
        vars.oldICR = LiquityMath._computeCR(vars.coll, vars.debt, vars.price);
        vars.newICR = _getNewICRFromTroveChange(
            vars.coll,
            vars.debt,
            vars.collChange,
            vars.isCollIncrease,
            vars.netDebtChange,
            _isDebtIncrease,
            vars.price
        );
        assert(_collWithdrawal <= vars.coll);

        // Check the adjustment satisfies all conditions for the current system mode
        _requireValidAdjustmentInCurrentMode(isRecoveryMode, _collWithdrawal, _isDebtIncrease, vars);

        // When the adjustment is a debt repayment, check it's a valid amount and that the caller has enough USDD
        if (!_isDebtIncrease && _USDDChange > 0) {
            _requireAtLeastMinNetDebt(_getNetDebt(vars.debt).sub(vars.netDebtChange));
            _requireValidUSDDRepayment(vars.debt, vars.netDebtChange);
            _requireSufficientUSDDBalance(contractsCache.usddToken, _onBehalfOf, vars.netDebtChange);
        }

        (vars.newColl, vars.newDebt) = _updateTroveFromAdjustment(
            contractsCache.troveManager,
            _onBehalfOf,
            vars.collChange,
            vars.isCollIncrease,
            vars.netDebtChange,
            _isDebtIncrease
        );
        vars.stake = contractsCache.troveManager.updateStakeAndTotalStakes(_onBehalfOf);

        // Re-insert trove in to the sorted list
        uint256 newNICR = _getNewNominalICRFromTroveChange(
            vars.coll,
            vars.debt,
            vars.collChange,
            vars.isCollIncrease,
            vars.netDebtChange,
            _isDebtIncrease
        );
        sortedTroves.reInsert(_onBehalfOf, newNICR, _upperHint, _lowerHint);

        emit TroveUpdated(
            _onBehalfOf,
            vars.newDebt,
            vars.newColl,
            vars.stake,
            BorrowerOperation.adjustTrove
        );
        emit USDDBorrowingFeePaid(msg.sender, vars.USDDFee);

        // Use the unmodified _USDDChange here, as we don't send the fee to the user
        _moveTokensAndCollfromAdjustment(
            contractsCache.activePool,
            contractsCache.usddToken,
            msg.sender,
            vars.collChange,
            vars.isCollIncrease,
            _USDDChange,
            _isDebtIncrease,
            vars.netDebtChange
        );
    }

    function closeTrove(address _onBehalfOf) external override {
        _closeTrove(_onBehalfOf);
    }

    function closeTrove() external override {
        _closeTrove(msg.sender);
    }

    function _closeTrove(address _onBehalfOf) internal {
        _requireCallerIsBorrowerOrGw(_onBehalfOf);
        ITroveManager troveManagerCached = troveManager;
        IActivePool activePoolCached = activePool;
        IUSDDToken usddTokenCached = usddToken;

        _requireTroveisActive(troveManagerCached, msg.sender);
        uint256 price = priceFeed.fetchPrice(collToken);
        _requireNotInRecoveryMode(price);

        troveManagerCached.applyPendingRewards(msg.sender);

        uint256 coll = troveManagerCached.getTroveColl(msg.sender);
        uint256 debt = troveManagerCached.getTroveDebt(msg.sender);

        _requireSufficientUSDDBalance(usddTokenCached, msg.sender, debt.sub(USDD_GAS_COMPENSATION));

        uint256 newTCR = _getNewTCRFromTroveChange(coll, false, debt, false, price);
        _requireNewTCRisAboveCCR(newTCR);

        troveManagerCached.removeStake(msg.sender);
        troveManagerCached.closeTrove(msg.sender);

        emit TroveUpdated(msg.sender, 0, 0, 0, BorrowerOperation.closeTrove);

        // Burn the repaid USDD from the user's balance and the gas compensation from the Gas Pool
        _repayUSDD(activePoolCached, usddTokenCached, msg.sender, debt.sub(USDD_GAS_COMPENSATION));
        _repayUSDD(activePoolCached, usddTokenCached, gasPoolAddress, USDD_GAS_COMPENSATION);

        // Send the collateral back to the user
        activePoolCached.sendColl(msg.sender, collToken, coll);
    }

    function claimCollateral(address _onBehalfOf) external override {
        _claimCollateral(_onBehalfOf);
    }

    function claimCollateral() external override {
        _claimCollateral(msg.sender);
    }

    /**
     * Claim remaining collateral from a redemption or from a liquidation with ICR > MCR in Recovery Mode
     */
    function _claimCollateral(address _onBehalfOf) internal {
        _requireCallerIsBorrowerOrGw(_onBehalfOf);
        // send ETH from CollSurplus Pool to owner
        collSurplusPool.claimColl(_onBehalfOf, msg.sender, collToken);
    }

    // --- Helper functions ---

    function _triggerBorrowingFee(
        ITroveManager _troveManager,
        IUSDDToken _usddToken,
        uint256 _USDDAmount,
        uint256 _maxFeePercentage
    ) internal returns (uint256) {
        _troveManager.decayBaseRateFromBorrowing(); // decay the baseRate state variable
        uint256 USDDFee = _troveManager.getBorrowingFee(_USDDAmount);

        _requireUserAcceptsFee(USDDFee, _USDDAmount, _maxFeePercentage);

        // Send fee to DEFT staking contract
        deftStaking.increaseF_USDD(USDDFee);
        _usddToken.mint(deftStakingAddress, USDDFee);

        return USDDFee;
    }

    function _getUSDValue(uint256 _coll, uint256 _price) internal pure returns (uint256) {
        uint256 usdValue = _price.mul(_coll).div(DECIMAL_PRECISION);

        return usdValue;
    }

    function _getCollChange(uint256 _collReceived, uint256 _requestedCollWithdrawal)
        internal
        pure
        returns (uint256 collChange, bool isCollIncrease)
    {
        if (_collReceived != 0) {
            collChange = _collReceived;
            isCollIncrease = true;
        } else {
            collChange = _requestedCollWithdrawal;
        }
    }

    // Update trove's coll and debt based on whether they increase or decrease
    function _updateTroveFromAdjustment(
        ITroveManager _troveManager,
        address _borrower,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease
    ) internal returns (uint256, uint256) {
        uint256 newColl = (_isCollIncrease)
            ? _troveManager.increaseTroveColl(_borrower, _collChange)
            : _troveManager.decreaseTroveColl(_borrower, _collChange);
        uint256 newDebt = (_isDebtIncrease)
            ? _troveManager.increaseTroveDebt(_borrower, _debtChange)
            : _troveManager.decreaseTroveDebt(_borrower, _debtChange);

        return (newColl, newDebt);
    }

    function _moveTokensAndCollfromAdjustment(
        IActivePool _activePool,
        IUSDDToken _usddToken,
        address _borrower,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _USDDChange,
        bool _isDebtIncrease,
        uint256 _netDebtChange
    ) internal {
        if (_isDebtIncrease) {
            _withdrawUSDD(_activePool, _usddToken, _borrower, _USDDChange, _netDebtChange);
        } else {
            _repayUSDD(_activePool, _usddToken, _borrower, _USDDChange);
        }

        if (_isCollIncrease) {
            _activePoolAddColl(_activePool, _collChange);
        } else {
            _activePool.sendColl(_borrower, collToken, _collChange);
        }
    }

    // Send ETH to Active Pool and increase its recorded ETH balance
    function _activePoolAddColl(IActivePool _activePool, uint256 _amount) internal {
        IERC20(collToken).safeTransferFrom(msg.sender, address(this), _amount);
        _activePool.receiveColl(collToken, _amount);
    }

    // Issue the specified amount of USDD to _account and increases the total active debt (_netDebtIncrease potentially includes a USDDFee)
    function _withdrawUSDD(
        IActivePool _activePool,
        IUSDDToken _usddToken,
        address _account,
        uint256 _USDDAmount,
        uint256 _netDebtIncrease
    ) internal {
        _activePool.increaseUSDDDebt(_netDebtIncrease);
        _usddToken.mint(_account, _USDDAmount);
    }

    // Burn the specified amount of USDD from _account and decreases the total active debt
    function _repayUSDD(
        IActivePool _activePool,
        IUSDDToken _usddToken,
        address _account,
        uint256 _USDD
    ) internal {
        _activePool.decreaseUSDDDebt(_USDD);
        _usddToken.burn(_account, _USDD);
    }

    // --- 'Require' wrapper functions ---

    function _requireSingularCollChange(uint256 _collDeposited, uint256 _collWithdrawal)
        internal
        pure
    {
        require(
            _collDeposited == 0 || _collWithdrawal == 0,
            "BorrowerOperations: Cannot withdraw and add coll"
        );
    }

    function _requireCallerIsBorrower(address _borrower) internal view {
        require(
            msg.sender == _borrower,
            "BorrowerOps: Caller must be the borrower for a withdrawal"
        );
    }

    function _requireCallerIsBorrowerOrGw(address _borrower) internal view {
        require(
            msg.sender == _borrower || msg.sender == wETHGatewayAddress,
            "BorrowerOps: Caller must be the borrower or gateway"
        );
    }

    function _requireCallerIsBorrowerOrGwOrSP(address _borrower) internal view {
        require(
            msg.sender == _borrower ||
                msg.sender == wETHGatewayAddress ||
                msg.sender == stabilityPoolAddress,
            "BorrowerOps: Caller must be the borrower or gateway or stabilityPool"
        );
    }

    function _requireNonZeroAdjustment(
        uint256 _collDeposited,
        uint256 _collWithdrawal,
        uint256 _USDDChange
    ) internal pure {
        require(
            _collDeposited != 0 || _collWithdrawal != 0 || _USDDChange != 0,
            "BorrowerOps: There must be either a collateral change or a debt change"
        );
    }

    function _requireTroveisActive(ITroveManager _troveManager, address _borrower) internal view {
        uint256 status = _troveManager.getTroveStatus(_borrower);
        require(status == 1, "BorrowerOps: Trove does not exist or is closed");
    }

    function _requireTroveisNotActive(ITroveManager _troveManager, address _borrower) internal view {
        uint256 status = _troveManager.getTroveStatus(_borrower);
        require(status != 1, "BorrowerOps: Trove is active");
    }

    function _requireNonZeroDebtChange(uint256 _USDDChange) internal pure {
        require(_USDDChange > 0, "BorrowerOps: Debt increase requires non-zero debtChange");
    }

    function _requireNotInRecoveryMode(uint256 _price) internal view {
        require(
            !_checkRecoveryMode(collToken, _price),
            "BorrowerOps: Operation not permitted during Recovery Mode"
        );
    }

    function _requireNoCollWithdrawal(uint256 _collWithdrawal) internal pure {
        require(
            _collWithdrawal == 0,
            "BorrowerOps: Collateral withdrawal not permitted Recovery Mode"
        );
    }

    function _requireValidAdjustmentInCurrentMode(
        bool _isRecoveryMode,
        uint256 _collWithdrawal,
        bool _isDebtIncrease,
        LocalVariables_adjustTrove memory _vars
    ) internal view {
        /*
         *In Recovery Mode, only allow:
         *
         * - Pure collateral top-up
         * - Pure debt repayment
         * - Collateral top-up with debt repayment
         * - A debt increase combined with a collateral top-up which makes the ICR >= 150% and improves the ICR (and by extension improves the TCR).
         *
         * In Normal Mode, ensure:
         *
         * - The new ICR is above MCR
         * - The adjustment won't pull the TCR below CCR
         */
        if (_isRecoveryMode) {
            _requireNoCollWithdrawal(_collWithdrawal);
            if (_isDebtIncrease) {
                _requireICRisAboveCCR(_vars.newICR);
                _requireNewICRisAboveOldICR(_vars.newICR, _vars.oldICR);
            }
        } else {
            // if Normal Mode
            _requireICRisAboveMCR(_vars.newICR);
            _vars.newTCR = _getNewTCRFromTroveChange(
                _vars.collChange,
                _vars.isCollIncrease,
                _vars.netDebtChange,
                _isDebtIncrease,
                _vars.price
            );
            _requireNewTCRisAboveCCR(_vars.newTCR);
        }
    }

    function _requireICRisAboveMCR(uint256 _newICR) internal pure {
        require(
            _newICR >= MCR,
            "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
        );
    }

    function _requireICRisAboveCCR(uint256 _newICR) internal pure {
        require(_newICR >= CCR, "BorrowerOps: Operation must leave trove with ICR >= CCR");
    }

    function _requireNewICRisAboveOldICR(uint256 _newICR, uint256 _oldICR) internal pure {
        require(
            _newICR >= _oldICR,
            "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode"
        );
    }

    function _requireNewTCRisAboveCCR(uint256 _newTCR) internal pure {
        require(
            _newTCR >= CCR,
            "BorrowerOps: An operation that would result in TCR < CCR is not permitted"
        );
    }

    function _requireAtLeastMinNetDebt(uint256 _netDebt) internal pure {
        require(
            _netDebt >= MIN_NET_DEBT,
            "BorrowerOps: Trove's net debt must be greater than minimum"
        );
    }

    function _requireValidUSDDRepayment(uint256 _currentDebt, uint256 _debtRepayment) internal pure {
        require(
            _debtRepayment <= _currentDebt.sub(USDD_GAS_COMPENSATION),
            "BorrowerOps: Amount repaid must not be larger than the Trove's debt"
        );
    }

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "BorrowerOps: Caller is not Stability Pool");
    }

    function _requireSufficientUSDDBalance(
        IUSDDToken _usddToken,
        address _borrower,
        uint256 _debtRepayment
    ) internal view {
        require(
            _usddToken.balanceOf(_borrower) >= _debtRepayment,
            "BorrowerOps: Caller doesnt have enough USDD to make repayment"
        );
    }

    function _requireValidMaxFeePercentage(uint256 _maxFeePercentage, bool _isRecoveryMode)
        internal
        pure
    {
        if (_isRecoveryMode) {
            require(
                _maxFeePercentage <= DECIMAL_PRECISION,
                "Max fee percentage must less than or equal to 100%"
            );
        } else {
            require(
                _maxFeePercentage >= BORROWING_FEE_FLOOR && _maxFeePercentage <= DECIMAL_PRECISION,
                "Max fee percentage must be between 0.5% and 100%"
            );
        }
    }

    // --- ICR and TCR getters ---

    // Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewNominalICRFromTroveChange(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease
    ) internal pure returns (uint256) {
        (uint256 newColl, uint256 newDebt) = _getNewTroveAmounts(
            _coll,
            _debt,
            _collChange,
            _isCollIncrease,
            _debtChange,
            _isDebtIncrease
        );

        uint256 newNICR = LiquityMath._computeNominalCR(newColl, newDebt);
        return newNICR;
    }

    // Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewICRFromTroveChange(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease,
        uint256 _price
    ) internal pure returns (uint256) {
        (uint256 newColl, uint256 newDebt) = _getNewTroveAmounts(
            _coll,
            _debt,
            _collChange,
            _isCollIncrease,
            _debtChange,
            _isDebtIncrease
        );

        uint256 newICR = LiquityMath._computeCR(newColl, newDebt, _price);
        return newICR;
    }

    function _getNewTroveAmounts(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease
    ) internal pure returns (uint256, uint256) {
        uint256 newColl = _coll;
        uint256 newDebt = _debt;

        newColl = _isCollIncrease ? _coll.add(_collChange) : _coll.sub(_collChange);
        newDebt = _isDebtIncrease ? _debt.add(_debtChange) : _debt.sub(_debtChange);

        return (newColl, newDebt);
    }

    function _getNewTCRFromTroveChange(
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease,
        uint256 _price
    ) internal view returns (uint256) {
        uint256 totalColl = getEntireSystemColl(collToken);
        uint256 totalDebt = getEntireSystemDebt();

        totalColl = _isCollIncrease ? totalColl.add(_collChange) : totalColl.sub(_collChange);
        totalDebt = _isDebtIncrease ? totalDebt.add(_debtChange) : totalDebt.sub(_debtChange);

        uint256 newTCR = LiquityMath._computeCR(totalColl, totalDebt, _price);
        return newTCR;
    }

    function getCompositeDebt(uint256 _debt) external pure override returns (uint256) {
        return _getCompositeDebt(_debt);
    }
}
