// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IYieldAdapter
 * @notice Frontera entre el vault y el protocolo que genera el rendimiento.
 *
 * El vault no sabe qué hay del otro lado: puede ser Aave, otro protocolo, o un
 * mock. Existe un adapter por vault, así que no hace falta contabilidad por
 * dueño acá adentro: todo lo que tiene el adapter es del vault que lo creó.
 */
interface IYieldAdapter {
    /// @notice El token que se deposita (USDT).
    function asset() external view returns (address);

    /// @notice El vault dueño de este adapter. Es el único que puede operar.
    function vault() external view returns (address);

    /**
     * @notice Ata el adapter a su vault. Sólo se puede una vez.
     * @dev Existe porque el vault necesita la dirección del adapter en su
     *      constructor y el adapter necesita la del vault: alguien tiene que ir
     *      primero. La fábrica crea el adapter suelto, deploya el vault, y
     *      recién ahí los ata.
     */
    function bindVault(address vault_) external;

    /// @notice Toma `amount` del vault y lo pone a generar rendimiento.
    function deposit(uint256 amount) external;

    /// @notice Saca `amount` y lo manda a `to`. Devuelve lo efectivamente sacado.
    function withdraw(uint256 amount, address to) external returns (uint256);

    /// @notice Saca todo. Se usa al cerrar el chanchito.
    function withdrawAll(address to) external returns (uint256);

    /// @notice Cuánto vale hoy lo depositado, con el rendimiento acumulado.
    function totalAssets() external view returns (uint256);

    /// @notice Tasa anual vigente en basis points (450 = 4,50%).
    function currentAprBps() external view returns (uint256);
}

/**
 * @notice Crea un adapter por vault. Cambiando la implementación de esta
 * fábrica, la misma PoolFactory sirve para Aave, para un mock, o para lo que
 * venga después.
 */
interface IYieldAdapterFactory {
    /// @notice Crea un adapter todavía sin atar. Ver `IYieldAdapter.bindVault`.
    function createAdapter() external returns (address);

    function asset() external view returns (address);
}
