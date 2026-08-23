// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IYieldAdapter, IYieldAdapterFactory} from '../interfaces/IYieldAdapter.sol';

/**
 * @title MockYieldAdapter
 * @notice Adapter sin protocolo detrás: se queda con los fondos y nada más.
 *
 * Sirve para dos cosas concretas:
 *  1. Tests: el rendimiento se simula transfiriéndole tokens, así se puede
 *     probar la matemática de shares sin depender de una red.
 *  2. Demo: en testnet el rendimiento real de Aave es prácticamente cero, así
 *     que un chanchito con este adapter puede mostrar ganancia de verdad.
 *
 * Como `totalAssets()` es simplemente el saldo del contrato, para simular
 * rendimiento alcanza con mandarle tokens.
 */
contract MockYieldAdapter is IYieldAdapter {
    using SafeERC20 for IERC20;

    address public immutable override asset;
    address public override vault;
    /// @dev Quien pidió el adapter (la PoolFactory): el único que puede atarlo.
    address public immutable binder;
    uint256 public aprBps;

    error OnlyVault();
    error AlreadyBound();
    error OnlyBinder();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address asset_, uint256 aprBps_, address binder_) {
        asset = asset_;
        aprBps = aprBps_;
        binder = binder_;
    }

    function bindVault(address vault_) external override {
        if (msg.sender != binder) revert OnlyBinder();
        if (vault != address(0)) revert AlreadyBound();
        vault = vault_;
    }

    function deposit(uint256 amount) external override onlyVault {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount, address to) external override onlyVault returns (uint256) {
        uint256 available = IERC20(asset).balanceOf(address(this));
        uint256 sent = amount > available ? available : amount;
        IERC20(asset).safeTransfer(to, sent);
        return sent;
    }

    function withdrawAll(address to) external override onlyVault returns (uint256) {
        uint256 all = IERC20(asset).balanceOf(address(this));
        if (all > 0) IERC20(asset).safeTransfer(to, all);
        return all;
    }

    function totalAssets() external view override returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function currentAprBps() external view override returns (uint256) {
        return aprBps;
    }
}

contract MockYieldAdapterFactory is IYieldAdapterFactory {
    address public immutable override asset;
    uint256 public immutable aprBps;

    constructor(address asset_, uint256 aprBps_) {
        asset = asset_;
        aprBps = aprBps_;
    }

    function createAdapter() external override returns (address) {
        return address(new MockYieldAdapter(asset, aprBps, msg.sender));
    }
}
