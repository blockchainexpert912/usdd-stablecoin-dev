// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface IDEFTStaking {
    // --- Events --

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

    function setAddresses(
        address[] calldata _collTokens,
        address[] calldata _troveManagerAddresses,
        address[] calldata _borrowerOperationsAddresses,
        address _wETHGatewayAddress,
        address _deftTokenAddress,
        address _usddTokenAddress,
        address _activePoolAddress
    ) external;

    function stake(address _staker, uint256 _DEFTamount) external;

    function stake(uint256 _DEFTamount) external;

    function unstake(address _staker, uint256 _DEFTamount) external;

    function unstake(uint256 _DEFTamount) external;

    function increaseF_COLL(address _collToken, uint256 _ETHFee) external;

    function increaseF_USDD(uint256 _DEFTFee) external;

    function getPendingCollGain(address _user, address _collToken) external view returns (uint256);

    function getPendingUSDDGain(address _user) external view returns (uint256);
}
