// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolVault} from './PoolVault.sol';
import {IYieldAdapter, IYieldAdapterFactory} from './interfaces/IYieldAdapter.sol';

/**
 * @title PoolFactory
 * @notice Crea chanchitos y lleva el registro de todos.
 *
 * @dev Resuelve dos cosas que de otro modo necesitarían un servidor aparte:
 *
 *  1. LISTAR. Guarda un array de todos los vaults y expone paginación, así la
 *     app puede pedir "los últimos 20" con una sola llamada. Sin esto habría
 *     que indexar eventos o montar un subgraph sólo para poblar la búsqueda.
 *
 *  2. CÓDIGOS DE INVITACIÓN. El mapa `código → vault` vive acá. Un chanchito
 *     privado no aparece en el listado público, pero quien tiene el código
 *     llega igual. Sin esto haría falta una base de datos para los códigos.
 */
contract PoolFactory {
    /* --------------------------------- config -------------------------------- */

    address public immutable asset;
    IYieldAdapterFactory public immutable adapterFactory;
    address public immutable feeRecipient;
    /// @notice Comisión por salida anticipada, en basis points de lo resignado.
    uint256 public immutable exitFeeBps;

    /* --------------------------------- registro ------------------------------ */

    address[] public pools;
    mapping(address => bool) public isPool;
    /// @notice Código de invitación (6 caracteres) → chanchito privado.
    mapping(bytes6 => address) public poolByCode;
    /// @notice Chanchitos creados por cada cuenta.
    mapping(address => address[]) public poolsByCreator;

    /* --------------------------------- eventos ------------------------------- */

    event PoolCreated(
        address indexed pool,
        address indexed creator,
        address adapter,
        string name,
        bool isPrivate,
        bytes6 code
    );

    /* --------------------------------- errores ------------------------------- */

    error CodeTaken();
    error CodeRequired();
    error InvalidAdapterAsset();
    error FeeTooHigh();

    struct CreateParams {
        string name;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint16 capacity;
        /// @notice Hasta cuándo se puede entrar.
        uint64 joinDeadline;
        /// @notice Cuánto dura el ahorro, contado desde que se llena.
        uint64 duration;
        bool isPrivate;
        /// @dev Sólo para privados. Debe ser único.
        bytes6 code;
    }

    constructor(
        address asset_,
        address adapterFactory_,
        address feeRecipient_,
        uint256 exitFeeBps_
    ) {
        if (IYieldAdapterFactory(adapterFactory_).asset() != asset_) revert InvalidAdapterAsset();
        asset = asset_;
        adapterFactory = IYieldAdapterFactory(adapterFactory_);
        feeRecipient = feeRecipient_;
        if (exitFeeBps_ > 2_000) revert FeeTooHigh(); // tope duro del 20%
        exitFeeBps = exitFeeBps_;
    }

    function createPool(CreateParams calldata p) external returns (address) {
        if (p.isPrivate) {
            if (p.code == bytes6(0)) revert CodeRequired();
            if (poolByCode[p.code] != address(0)) revert CodeTaken();
        }

        // Orden obligado: el adapter nace suelto, el vault lo recibe en su
        // constructor, y recién ahí se atan. Ver `IYieldAdapter.bindVault`.
        address adapter = adapterFactory.createAdapter();

        PoolVault vault = new PoolVault(
            PoolVault.Config({
                asset: asset,
                adapter: adapter,
                creator: msg.sender,
                feeRecipient: feeRecipient,
                name: p.name,
                minDeposit: p.minDeposit,
                maxDeposit: p.maxDeposit,
                exitFeeBps: exitFeeBps,
                capacity: p.capacity,
                joinDeadline: p.joinDeadline,
                duration: p.duration,
                isPrivate: p.isPrivate
            })
        );

        IYieldAdapter(adapter).bindVault(address(vault));

        pools.push(address(vault));
        isPool[address(vault)] = true;
        poolsByCreator[msg.sender].push(address(vault));
        if (p.isPrivate) poolByCode[p.code] = address(vault);

        emit PoolCreated(address(vault), msg.sender, adapter, p.name, p.isPrivate, p.code);
        return address(vault);
    }

    /* ---------------------------------- lectura ------------------------------- */

    function poolsLength() external view returns (uint256) {
        return pools.length;
    }

    /**
     * @notice Página de chanchitos, del más nuevo al más viejo.
     * @dev Devolver el array entero se vuelve imposible cuando crecen; esto
     *      mantiene la lectura acotada.
     */
    function poolsPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = pools.length;
        if (offset >= total) return new address[](0);

        uint256 remaining = total - offset;
        uint256 count = remaining < limit ? remaining : limit;
        page = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            page[i] = pools[total - 1 - offset - i];
        }
    }

    function poolsOf(address creator) external view returns (address[] memory) {
        return poolsByCreator[creator];
    }
}
