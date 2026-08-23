// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IYieldAdapter, IYieldAdapterFactory} from '../interfaces/IYieldAdapter.sol';

/// @dev Sólo lo que se usa de Aave v3, para no arrastrar todo el paquete.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IAaveProtocolDataProvider {
    function getReserveData(
        address asset
    )
        external
        view
        returns (
            uint256 unbacked,
            uint256 accruedToTreasuryScaled,
            uint256 totalAToken,
            uint256 totalStableDebt,
            uint256 totalVariableDebt,
            uint256 liquidityRate,
            uint256 variableBorrowRate,
            uint256 stableBorrowRate,
            uint256 averageStableBorrowRate,
            uint256 liquidityIndex,
            uint256 variableBorrowIndex,
            uint40 lastUpdateTimestamp
        );
}

/**
 * @title AaveAdapter
 * @notice Pone los fondos del vault a generar interés en Aave v3.
 *
 * @dev El aToken (aUSDT) es "rebasing": el saldo del contrato crece solo a
 *      medida que se acumula el interés, sin que haya transferencias. Por eso
 *      `totalAssets()` es simplemente el saldo de aTokens — y por eso el vault
 *      lleva shares en vez de montos: si guardara montos, esa acumulación
 *      no tendría a quién atribuirse.
 */
contract AaveAdapter is IYieldAdapter {
    using SafeERC20 for IERC20;

    address public immutable override asset;
    address public override vault;
    /// @dev Quien pidió el adapter (la PoolFactory): el único que puede atarlo.
    address public immutable binder;
    IAavePool public immutable pool;
    IERC20 public immutable aToken;
    IAaveProtocolDataProvider public immutable dataProvider;

    /// @dev Aave expresa las tasas en RAY (1e27) y son anuales. 1e23 = 1 bp.
    uint256 private constant RAY_PER_BPS = 1e23;

    error OnlyVault();
    error AlreadyBound();
    error OnlyBinder();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(
        address asset_,
        address pool_,
        address aToken_,
        address dataProvider_,
        address binder_
    ) {
        asset = asset_;
        pool = IAavePool(pool_);
        aToken = IERC20(aToken_);
        dataProvider = IAaveProtocolDataProvider(dataProvider_);
        binder = binder_;
    }

    function bindVault(address vault_) external override {
        if (msg.sender != binder) revert OnlyBinder();
        if (vault != address(0)) revert AlreadyBound();
        vault = vault_;
    }

    function deposit(uint256 amount) external override onlyVault {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(asset).forceApprove(address(pool), amount);
        pool.supply(asset, amount, address(this), 0);
    }

    function withdraw(uint256 amount, address to) external override onlyVault returns (uint256) {
        return pool.withdraw(asset, amount, to);
    }

    function withdrawAll(address to) external override onlyVault returns (uint256) {
        uint256 balance = aToken.balanceOf(address(this));
        if (balance == 0) return 0;
        return pool.withdraw(asset, type(uint256).max, to);
    }

    /// @dev El saldo de aTokens ya incluye el interés acumulado, 1:1 con el subyacente.
    function totalAssets() external view override returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    function currentAprBps() external view override returns (uint256) {
        (, , , , , uint256 liquidityRate, , , , , , ) = dataProvider.getReserveData(asset);
        return liquidityRate / RAY_PER_BPS;
    }
}

contract AaveAdapterFactory is IYieldAdapterFactory {
    address public immutable override asset;
    address public immutable pool;
    address public immutable aToken;
    address public immutable dataProvider;

    constructor(address asset_, address pool_, address aToken_, address dataProvider_) {
        asset = asset_;
        pool = pool_;
        aToken = aToken_;
        dataProvider = dataProvider_;
    }

    function createAdapter() external override returns (address) {
        return address(new AaveAdapter(asset, pool, aToken, dataProvider, msg.sender));
    }
}
