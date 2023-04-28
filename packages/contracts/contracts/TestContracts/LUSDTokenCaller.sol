// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IUSDDToken.sol";

contract USDDTokenCaller {
    IUSDDToken USDD;

    function setUSDD(IUSDDToken _USDD) external {
        USDD = _USDD;
    }

    function usddMint(address _account, uint256 _amount) external {
        USDD.mint(_account, _amount);
    }

    function usddBurn(address _account, uint256 _amount) external {
        USDD.burn(_account, _amount);
    }

    function usddSendToPool(
        address _sender,
        address _poolAddress,
        uint256 _amount
    ) external {
        USDD.sendToPool(_sender, _poolAddress, _amount);
    }

    function usddReturnFromPool(
        address _poolAddress,
        address _receiver,
        uint256 _amount
    ) external {
        USDD.returnFromPool(_poolAddress, _receiver, _amount);
    }
}
