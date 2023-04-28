// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IBorrowerOperations.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
// import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import "./LPRewards/Dependencies/SafeERC20.sol";

contract CollSurplusPool is Ownable, CheckContract, ICollSurplusPool {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    string public constant NAME = "CollSurplusPool";

    address public activePoolAddress;

    // deposited ether tracker
    mapping(address => uint256) internal COLLS;
    // Collateral surplus claimable by trove owners
    mapping(address => mapping(address => uint256)) internal balances;

    address[] public collTokens;

    mapping(address => bool) private _authorizedTroveManagers;
    mapping(address => bool) private _authorizedBorrowerOperations;

    // --- Events ---

    event BorrowerOperationsAddressSet(address _newBorrowerOperationsAddress);
    event TroveManagerAddressSet(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);

    event CollBalanceUpdated(address indexed _account, address _collToken, uint256 _newBalance);
    event CollSent(address _to, address _collToken, uint256 _amount);

    // --- Contract setters ---

    function authorizeTroveManagers(address[] memory _troveManagers) public onlyOwner {
        for (uint256 i = 0; i < _troveManagers.length; i++) {
            address _address = _troveManagers[i];
            checkContract(_address);
            _authorizedTroveManagers[_address] = true;
            emit TroveManagerAddressSet(_address);
        }
    }

    function authorizeBorrowerOperations(address[] memory _borrowerOperations) public onlyOwner {
        for (uint256 i = 0; i < _borrowerOperations.length; i++) {
            address _address = _borrowerOperations[i];
            checkContract(_address);
            _authorizedBorrowerOperations[_address] = true;
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
        address[] calldata _troveManagerAddresses,
        address[] calldata _borrowerOperationsAddresses,
        address _activePoolAddress
    ) external override onlyOwner {
        checkContract(_activePoolAddress);

        activePoolAddress = _activePoolAddress;
        setCollTokens(_collTokens);
        authorizeTroveManagers(_troveManagerAddresses);
        authorizeBorrowerOperations(_borrowerOperationsAddresses);

        emit ActivePoolAddressChanged(_activePoolAddress);

        _renounceOwnership();
    }

    /* Returns the ETH state variable at ActivePool address.
       Not necessarily equal to the raw ether balance - ether can be forcibly sent to contracts. */
    function getColl(address _collToken) external view override returns (uint256) {
        return COLLS[_collToken];
    }

    function getCollateral(address _account, address _collToken)
        external
        view
        override
        returns (uint256)
    {
        return balances[_account][_collToken];
    }

    // --- Pool functionality ---

    function accountSurplus(
        address _account,
        address _collToken,
        uint256 _amount
    ) external override {
        _requireCallerIsTroveManager(_collToken);

        uint256 newAmount = balances[_account][_collToken].add(_amount);
        balances[_account][_collToken] = newAmount;

        emit CollBalanceUpdated(_account, _collToken, newAmount);
    }

    function claimColl(
        address _account,
        address _to,
        address _collToken
    ) external override {
        _requireCallerIsBorrowerOperations(_collToken);
        uint256 claimableColl = balances[_account][_collToken];
        require(claimableColl > 0, "CollSurplusPool: No collateral available to claim");

        balances[_account][_collToken] = 0;
        emit CollBalanceUpdated(_account, _collToken, 0);

        COLLS[_collToken] = COLLS[_collToken].sub(claimableColl);
        emit CollSent(_account, _collToken, claimableColl);
        IERC20(_collToken).safeTransfer(_to, claimableColl);
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperations(address _collToken) internal view {
        require(
            _authorizedBorrowerOperations[msg.sender],
            "CollSurplusPool: Caller is not Borrower Operations"
        );
        require(
            IBorrowerOperations(msg.sender).collToken() == _collToken,
            "CollSurplusPool: Caller coll token mismatch"
        );
    }

    function _requireCallerIsTroveManager(address _collToken) internal view {
        require(_authorizedTroveManagers[msg.sender], "CollSurplusPool: Caller is not TroveManager");
        require(
            ITroveManager(msg.sender).collToken() == _collToken,
            "CollSurplusPool: Caller coll token mismatch"
        );
    }

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "CollSurplusPool: Caller is not Active Pool");
    }

    function receiveColl(address _collToken, uint256 _amount) external override {
        _requireCallerIsTroveManager(_collToken);
        IERC20(_collToken).safeTransferFrom(msg.sender, address(this), _amount);
        COLLS[_collToken] = COLLS[_collToken].add(_amount);
    }
}
