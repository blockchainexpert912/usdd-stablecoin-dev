// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IDefaultPool.sol";
import "./Interfaces/IActivePool.sol";
import "./Interfaces/ITroveManager.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
// import "./Dependencies/console.sol";
import "./LPRewards/Dependencies/SafeERC20.sol";
import "./Dependencies/IERC20.sol";

/*
 * The Default Pool holds the ETH and USDD debt (but not USDD tokens) from liquidations that have been redistributed
 * to active troves but not yet "applied", i.e. not yet recorded on a recipient active trove's struct.
 *
 * When a trove makes an operation that applies its pending ETH and USDD debt, its pending ETH and USDD debt is moved
 * from the Default Pool to the Active Pool.
 */
contract DefaultPool is Ownable, CheckContract, IDefaultPool {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    string public constant NAME = "DefaultPool";

    address public activePoolAddress;
    uint256 internal USDDDebt; // debt
    mapping(address => uint256) balances;
    mapping(address => bool) public authorizedTroveManagers;

    event TroveManagerAddressSet(address _newTroveManagerAddress);
    event DefaultPoolUSDDDebtUpdated(uint256 _USDDDebt);
    event DefaultPoolETHBalanceUpdated(uint256 _ETH);

    // --- Dependency setters ---
    function authorizeTroveManagers(address[] memory _troveManagers) public onlyOwner {
        for (uint256 i = 0; i < _troveManagers.length; i++) {
            address _address = _troveManagers[i];
            checkContract(_address);
            authorizedTroveManagers[_address] = true;
            IERC20(ITroveManager(_address).collToken()).approve(
                activePoolAddress,
                type(uint256).max
            );
            emit TroveManagerAddressSet(_address);
        }
    }

    function setAddresses(address[] calldata _troveManagerAddresses, address _activePoolAddress)
        external
        onlyOwner
    {
        checkContract(_activePoolAddress);
        activePoolAddress = _activePoolAddress;
        authorizeTroveManagers(_troveManagerAddresses);

        emit ActivePoolAddressChanged(_activePoolAddress);

        _renounceOwnership();
    }

    // --- Getters for public variables. Required by IPool interface ---

    /*
     * Returns the ETH state variable.
     *
     *Not necessarily equal to the the contract's raw ETH balance - ether can be forcibly sent to contracts.
     */
    function getColl(address _collToken) external view override returns (uint256) {
        return balances[_collToken];
    }

    function getUSDDDebt() external view override returns (uint256) {
        return USDDDebt;
    }

    // --- Pool functionality ---

    function sendToActivePool(address _collToken, uint256 _amount) external override {
        _requireCallerIsTroveManager(_collToken);
        address activePool = activePoolAddress; // cache to save an SLOAD
        balances[_collToken] = balances[_collToken].sub(_amount);
        emit DefaultPoolBalanceUpdated(_collToken, _amount);
        emit CollTokenSent(activePool, _collToken, _amount);
        IActivePool(activePool).receiveColl(_collToken, _amount);
    }

    function receiveColl(address _collToken, uint256 _amount) external override {
        _requireCallerIsTroveManager(_collToken);
        IERC20(_collToken).safeTransferFrom(msg.sender, address(this), _amount);
        balances[_collToken] = balances[_collToken].add(_amount);
        emit DefaultPoolBalanceUpdated(_collToken, balances[_collToken]);
    }

    function increaseUSDDDebt(uint256 _amount) external override {
        _requireCallerIsTroveManager();
        USDDDebt = USDDDebt.add(_amount);
        emit DefaultPoolUSDDDebtUpdated(USDDDebt);
    }

    function decreaseUSDDDebt(uint256 _amount) external override {
        _requireCallerIsTroveManager();
        USDDDebt = USDDDebt.sub(_amount);
        emit DefaultPoolUSDDDebtUpdated(USDDDebt);
    }

    // --- 'require' functions ---

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "DefaultPool: Caller is not the ActivePool");
    }

    function _requireCallerIsTroveManager(address _collToken) internal view {
        require(
            authorizedTroveManagers[msg.sender] &&
                ITroveManager(msg.sender).collToken() == _collToken,
            "DefaultPool: Caller is not the TroveManager"
        );
    }

    function _requireCallerIsTroveManager() internal view {
        require(authorizedTroveManagers[msg.sender], "DefaultPool: Caller is not the TroveManager");
    }
}
