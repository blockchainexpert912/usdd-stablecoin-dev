// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/BaseMath.sol";
import "../Dependencies/SafeMath.sol";
import "../Dependencies/Ownable.sol";
import "../Dependencies/CheckContract.sol";
// import "../Dependencies/console.sol";
import "../Interfaces/IDEFTToken.sol";
import "../Interfaces/IDEFTStaking.sol";
import "../Interfaces/ITroveManager.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Dependencies/LiquityMath.sol";
import "../Interfaces/IUSDDToken.sol";
import "../Dependencies/IERC20.sol";
import "../LPRewards/Dependencies/SafeERC20.sol";

contract DEFTStaking is IDEFTStaking, Ownable, CheckContract, BaseMath {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    // --- Data ---
    string public constant NAME = "DEFTStaking";

    mapping(address => uint256) public stakes;
    uint256 public totalDEFTStaked;

    mapping(address => uint256) public F_COLLS; // Running sum of COLL fees per-DEFT-staked
    uint256 public F_USDD; // Running sum of DEFT fees per-DEFT-staked

    // User snapshots of F_COLL and F_USDD, taken at the point at which their latest deposit was made
    mapping(address => mapping(address => uint256)) public F_COLL_Snapshots;
    mapping(address => uint256) public F_USDD_Snapshots;

    IDEFTToken public deftToken;
    IUSDDToken public usddToken;

    address public activePoolAddress;

    address wETHGatewayAddress;

    address[] public collTokens;

    mapping(address => bool) public authorizedTroveManagers;
    mapping(address => bool) public authorizedBorrowerOperations;

    // --- Events ---

    event DEFTTokenAddressSet(address _deftTokenAddress);
    event USDDTokenAddressSet(address _usddTokenAddress);
    event TroveManagerAddressSet(address _troveManager);
    event BorrowerOperationsAddressSet(address _borrowerOperationsAddress);
    event ActivePoolAddressSet(address _activePoolAddress);

    event StakeChanged(address indexed staker, uint256 newStake);
    event StakingGainsWithdrawn(address indexed staker, uint256 USDDGain, uint256[] CollGains);
    event F_COLLUpdated(uint256 _F_COLL);
    event F_USDDUpdated(uint256 _F_USDD);
    event TotalDEFTStakedUpdated(uint256 _totalDEFTStaked);
    event CollTokenSent(address _account, address _collToken, uint256 _amount);
    event StakerSnapshotsUpdated(
        address _staker,
        address _collToken,
        uint256 _F_COLL,
        uint256 _F_USDD
    );

    // --- Functions ---

    function authorizeTroveManagers(address[] memory _troveManagers) public onlyOwner {
        for (uint256 i = 0; i < _troveManagers.length; i++) {
            address _address = _troveManagers[i];
            checkContract(_address);
            authorizedTroveManagers[_address] = true;
            emit TroveManagerAddressSet(_address);
        }
    }

    function authorizeBorrowerOperations(address[] memory _borrowerOperations) public onlyOwner {
        for (uint256 i = 0; i < _borrowerOperations.length; i++) {
            address _address = _borrowerOperations[i];
            checkContract(_address);
            authorizedBorrowerOperations[_address] = true;
            emit BorrowerOperationsAddressSet(_address);
        }
    }

    function setCollTokens(address[] memory _collTokens) public onlyOwner {
        for (uint256 i = 0; i < collTokens.length; i++) {
            address _address = _collTokens[i];
            checkContract(_address);
        }
        collTokens = _collTokens;
    }

    function setAddresses(
        address[] calldata _collTokens,
        address[] calldata _troveManagerAddresseses,
        address[] calldata _borrowerOperationsAddresseses,
        address _deftTokenAddress,
        address _usddTokenAddress,
        address _activePoolAddress,
        address _wETHGatewayAddress
    ) external override onlyOwner {
        checkContract(_wETHGatewayAddress);
        checkContract(_deftTokenAddress);
        checkContract(_usddTokenAddress);
        checkContract(_activePoolAddress);

        setCollTokens(_collTokens);
        authorizeTroveManagers(_troveManagerAddresseses);
        authorizeBorrowerOperations(_borrowerOperationsAddresseses);

        wETHGatewayAddress = _wETHGatewayAddress;
        deftToken = IDEFTToken(_deftTokenAddress);
        usddToken = IUSDDToken(_usddTokenAddress);
        activePoolAddress = _activePoolAddress;

        emit DEFTTokenAddressSet(_deftTokenAddress);
        emit DEFTTokenAddressSet(_usddTokenAddress);
        emit ActivePoolAddressSet(_activePoolAddress);

        _renounceOwnership();
    }

    function stake(address _staker, uint256 _DEFTamount) external override {
        _stake(_staker, _DEFTamount);
    }

    function stake(uint256 _DEFTamount) external override {
        _stake(msg.sender, _DEFTamount);
    }

    // If caller has a pre-existing stake, send any accumulated COLL and USDD gains to them.
    function _stake(address _staker, uint256 _DEFTamount) internal {
        _requireCallerIsStakerOrGw(_staker);
        _requireNonZeroAmount(_DEFTamount);

        uint256 currentStake = stakes[_staker];

        uint256 USDDGain;
        uint256[] memory CollGains = new uint256[](collTokens.length);
        // Grab any accumulated COLL and USDD gains from the current stake
        USDDGain = _getPendingUSDDGain(_staker);

        for (uint256 i = 0; i < collTokens.length; i++) {
            address _collToken = collTokens[i];
            CollGains[i] = _getPendingCollGain(_staker, _collToken);
            _updateUserSnapshots(_staker, _collToken);
        }

        uint256 newStake = currentStake.add(_DEFTamount);

        // Increase user’s stake and total DEFT staked
        stakes[_staker] = newStake;
        totalDEFTStaked = totalDEFTStaked.add(_DEFTamount);
        emit TotalDEFTStakedUpdated(totalDEFTStaked);

        // Transfer DEFT from caller to this contract
        deftToken.transferFrom(_staker, address(this), _DEFTamount);

        emit StakeChanged(_staker, newStake);
        emit StakingGainsWithdrawn(_staker, USDDGain, CollGains);
        usddToken.transfer(_staker, USDDGain);
        for (uint256 i = 0; i < collTokens.length; i++) {
            uint256 collGain = CollGains[i];
            address collToken = collTokens[i];
            _sendCollGainToUser(collToken, collGain);
        }
    }

    function unstake(address _staker, uint256 _DEFTamount) external override {
        _unstake(_staker, _DEFTamount);
    }

    function unstake(uint256 _DEFTamount) external override {
        _unstake(msg.sender, _DEFTamount);
    }

    // Unstake the DEFT and send the it back to the caller, along with their accumulated USDD & COLL gains.
    // If requested amount > stake, send their entire stake.
    function _unstake(address _staker, uint256 _DEFTamount) internal {
        _requireCallerIsStakerOrGw(_staker);
        uint256 currentStake = stakes[_staker];
        _requireUserHasStake(currentStake);

        // Grab any accumulated COLL and USDD gains from the current stake
        uint256 USDDGain = _getPendingUSDDGain(_staker);
        uint256[] memory CollGains = new uint256[](collTokens.length);
        for (uint256 i = 0; i < collTokens.length; i++) {
            address _collToken = collTokens[i];
            CollGains[i] = _getPendingCollGain(_staker, _collToken);
            _updateUserSnapshots(_staker, _collToken);
        }

        if (_DEFTamount > 0) {
            uint256 DEFTToWithdraw = LiquityMath._min(_DEFTamount, currentStake);

            uint256 newStake = currentStake.sub(DEFTToWithdraw);

            // Decrease user's stake and total DEFT staked
            stakes[_staker] = newStake;
            totalDEFTStaked = totalDEFTStaked.sub(DEFTToWithdraw);
            emit TotalDEFTStakedUpdated(totalDEFTStaked);

            // Transfer unstaked DEFT to user
            deftToken.transfer(_staker, DEFTToWithdraw);

            emit StakeChanged(_staker, newStake);
        }

        emit StakingGainsWithdrawn(_staker, USDDGain, CollGains);
        // Send accumulated USDD and COLL gains to the caller
        usddToken.transfer(_staker, USDDGain);
        for (uint256 i = 0; i < collTokens.length; i++) {
            uint256 collGain = CollGains[i];
            address collToken = collTokens[i];
            _sendCollGainToUser(collToken, collGain);
        }
    }

    // --- Reward-per-unit-staked increase functions. Called by Liquity core contracts ---

    function increaseF_COLL(address _collToken, uint256 _CollFee) external override {
        _requireCallerIsTroveManager(_collToken);
        uint256 COLLFeePerDEFTStaked;

        if (totalDEFTStaked > 0) {
            COLLFeePerDEFTStaked = _CollFee.mul(DECIMAL_PRECISION).div(totalDEFTStaked);
        }
        F_COLLS[_collToken] = F_COLLS[_collToken].add(COLLFeePerDEFTStaked);
        emit F_COLLUpdated(F_COLLS[_collToken]);
    }

    function increaseF_USDD(uint256 _USDDFee) external override {
        _requireCallerIsBorrowerOperations();
        uint256 USDDFeePerDEFTStaked;

        if (totalDEFTStaked > 0) {
            USDDFeePerDEFTStaked = _USDDFee.mul(DECIMAL_PRECISION).div(totalDEFTStaked);
        }

        F_USDD = F_USDD.add(USDDFeePerDEFTStaked);
        emit F_USDDUpdated(F_USDD);
    }

    // --- Pending reward functions ---

    function getPendingCollGain(address _user, address _collToken)
        external
        view
        override
        returns (uint256)
    {
        return _getPendingCollGain(_user, _collToken);
    }

    function _getPendingCollGain(address _user, address _collToken) internal view returns (uint256) {
        uint256 F_Coll_Snapshot = F_COLL_Snapshots[_user][_collToken];
        uint256 COLLGain = stakes[_user].mul(F_COLLS[_collToken].sub(F_Coll_Snapshot)).div(
            DECIMAL_PRECISION
        );
        return COLLGain;
    }

    function getPendingUSDDGain(address _user) external view override returns (uint256) {
        return _getPendingUSDDGain(_user);
    }

    function _getPendingUSDDGain(address _user) internal view returns (uint256) {
        uint256 F_USDD_Snapshot = F_USDD_Snapshots[_user];
        uint256 USDDGain = stakes[_user].mul(F_USDD.sub(F_USDD_Snapshot)).div(DECIMAL_PRECISION);
        return USDDGain;
    }

    // --- Internal helper functions ---

    function _updateUserSnapshots(address _user, address _collToken) internal {
        F_COLL_Snapshots[_user][_collToken] = F_COLLS[_collToken];
        F_USDD_Snapshots[_user] = F_USDD;
        emit StakerSnapshotsUpdated(_user, _collToken, F_COLLS[_collToken], F_USDD);
    }

    function _sendCollGainToUser(address _collToken, uint256 CollGain) internal {
        IERC20(_collToken).safeTransfer(msg.sender, CollGain);
        emit CollTokenSent(msg.sender, _collToken, CollGain);
    }

    // --- 'require' functions ---

    function _requireCallerIsStakerOrGw(address _staker) internal view {
        require(
            msg.sender == _staker || msg.sender == wETHGatewayAddress,
            "DEFTStaking: Caller must be the staker or gateway"
        );
    }

    function _requireCallerIsTroveManager(address _collToken) internal view {
        require(authorizedTroveManagers[msg.sender], "DEFTStaking: caller is not TroveM");
        require(
            ITroveManager(msg.sender).collToken() == _collToken,
            "DEFTStaking: TroveM coll token mismatch"
        );
    }

    function _requireCallerIsBorrowerOperations() internal view {
        require(authorizedBorrowerOperations[msg.sender], "DEFTStaking: caller is not BorrowerOps");
    }

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "DEFTStaking: caller is not ActivePool");
    }

    function _requireUserHasStake(uint256 currentStake) internal pure {
        require(currentStake > 0, "DEFTStaking: User must have a non-zero stake");
    }

    function _requireNonZeroAmount(uint256 _amount) internal pure {
        require(_amount > 0, "DEFTStaking: Amount must be non-zero");
    }
}
