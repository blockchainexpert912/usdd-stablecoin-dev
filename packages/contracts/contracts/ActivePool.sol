// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IActivePool.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IBorrowerOperations.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
// import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import "./LPRewards/Dependencies/SafeERC20.sol";

/*
 * The Active Pool holds the ETH collateral and USDD debt (but not USDD tokens) for all active troves.
 *
 * When a trove is liquidated, it's ETH and USDD debt are transferred from the Active Pool, to either the
 * Stability Pool, the Default Pool, or both, depending on the liquidation conditions.
 *
 */
contract ActivePool is Ownable, CheckContract, IActivePool {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    string public constant NAME = "ActivePool";

    address public stabilityPoolAddress;
    address public defaultPoolAddress;
    mapping(address => uint256) balances;
    uint256 internal USDDDebt;

    mapping(address => bool) public authorizedTroveManagers;
    mapping(address => bool) public authorizedBorrowerOperations;

    // --- Events ---

    event BorrowerOperationsAddressSet(address _newBorrowerOperationsAddress);
    event TroveManagerAddressSet(address _newTroveManagerAddress);
    event ActivePoolUSDDDebtUpdated(uint256 _USDDDebt);
    event ActivePoolBalanceUpdated(address _collToken, uint256 _amount);

    // --- Contract setters ---

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

    function setAddresses(
        address[] calldata _troveManagerAddresses,
        address[] calldata _borrowerOperationsAddresses,
        address _stabilityPoolAddress,
        address _defaultPoolAddress
    ) external onlyOwner {
        checkContract(_stabilityPoolAddress);
        checkContract(_defaultPoolAddress);

        authorizeTroveManagers(_troveManagerAddresses);
        authorizeBorrowerOperations(_borrowerOperationsAddresses);

        stabilityPoolAddress = _stabilityPoolAddress;
        defaultPoolAddress = _defaultPoolAddress;

        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);

        _renounceOwnership();
    }

    /*
     * Returns the ETH state variable.
     *
     *Not necessarily equal to the the contract's raw ETH balance - ether can be forcibly sent to contracts.
     */
    function getColl(address _collToken) external view override returns (uint256) {
        return balances[_collToken];
    }

    // --- Getters for public variables. Required by IPool interface ---

    function getUSDDDebt() external view override returns (uint256) {
        return USDDDebt;
    }

    // --- Pool functionality ---

    function sendColl(
        address _account,
        address _collToken,
        uint256 _amount
    ) external override {
        _requireCallerIsBOorTroveMorSP(_collToken);
        balances[_collToken] = balances[_collToken].sub(_amount);

        emit ActivePoolBalanceUpdated(_collToken, _amount);

        emit CollTokenSent(_account, _collToken, _amount);

        IERC20(_collToken).safeTransfer(_account, _amount);
    }

    function receiveColl(address _collToken, uint256 _amount) external override {
        _requireCallerIsBorrowerOperationsOrDefaultPool(_collToken);
        IERC20(_collToken).safeTransferFrom(msg.sender, address(this), _amount);
        balances[_collToken] = balances[_collToken].add(_amount);
        emit ActivePoolBalanceUpdated(_collToken, balances[_collToken]);
    }

    function increaseUSDDDebt(uint256 _amount) external override {
        _requireCallerIsBOorTroveM();
        USDDDebt = USDDDebt.add(_amount);
        ActivePoolUSDDDebtUpdated(USDDDebt);
    }

    function decreaseUSDDDebt(uint256 _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        USDDDebt = USDDDebt.sub(_amount);
        ActivePoolUSDDDebtUpdated(USDDDebt);
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperationsOrDefaultPool(address _collToken) internal view {
        require(
            (authorizedBorrowerOperations[msg.sender] &&
                IBorrowerOperations(msg.sender).collToken() == _collToken) ||
                msg.sender == defaultPoolAddress,
            "ActivePool: Caller is neither BO nor Default Pool"
        );
    }

    function _requireCallerIsBOorTroveMorSP(address _collToken) internal view {
        require(
            (authorizedBorrowerOperations[msg.sender] &&
                IBorrowerOperations(msg.sender).collToken() == _collToken) ||
                (authorizedTroveManagers[msg.sender] &&
                    ITroveManager(msg.sender).collToken() == _collToken) ||
                msg.sender == stabilityPoolAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool"
        );
    }

    function _requireCallerIsBOorTroveMorSP() internal view {
        require(
            authorizedBorrowerOperations[msg.sender] ||
                authorizedTroveManagers[msg.sender] ||
                msg.sender == stabilityPoolAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool"
        );
    }

    function _requireCallerIsBOorTroveM() internal view {
        require(
            authorizedBorrowerOperations[msg.sender] || authorizedTroveManagers[msg.sender],
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager"
        );
    }
}
