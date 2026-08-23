// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';

import {IYieldAdapter} from './interfaces/IYieldAdapter.sol';

/**
 * @title PoolVault
 * @notice Un chanchito: varias personas ponen plata para una meta común, la
 *         plata genera rendimiento mientras esperan, y al vencimiento cada uno
 *         retira su parte más la ganancia.
 *
 * @dev CONTABILIDAD POR PARTICIPACIONES ("shares"), no por montos.
 *
 * Es la decisión central del contrato y de ella sale gratis la regla de
 * negocio más importante de Chanchito:
 *
 *   "Si salís antes, recuperás tu capital completo pero perdés la ganancia
 *    generada. Esa ganancia se reparte entre quienes se quedan."
 *
 * Con shares no hay que repartir nada a mano ni iterar participantes. Cuando
 * alguien sale, se le queman sus shares y se le devuelve sólo su capital; la
 * ganancia que resigna se queda en el vault. Como el total de shares bajó pero
 * los fondos no, **el valor de cada share que queda sube solo**. El reparto es
 * una consecuencia aritmética, no un bucle.
 *
 * Guardar montos en vez de shares obligaría a recorrer a todos los
 * participantes en cada salida, con un costo de gas que crece con el grupo y
 * con errores de redondeo acumulándose en cada reparto.
 */
contract PoolVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**
     * @dev EL RENDIMIENTO EMPIEZA CUANDO SE LLENA, NO CUANDO DEPOSITÁS.
     *
     * Mientras faltan cupos, la plata queda quieta en este contrato: no se
     * manda al protocolo de rendimiento y el plazo no corre. Al entrar el
     * último participante se activa todo de una: los fondos van a generar
     * interés y recién ahí arranca el reloj del vencimiento.
     *
     * Es lo justo para el grupo. Si el plazo corriera desde la creación, el
     * primero en entrar esperaría meses de más y el último de menos, y los
     * primeros generarían rendimiento sobre un grupo incompleto.
     */
    enum Status {
        Open,   // faltan cupos: la plata está quieta acá
        Active, // se llenó: generando rendimiento, el plazo corre
        Closed  // repartido
    }

    /* --------------------------------- config -------------------------------- */

    IERC20 public immutable asset;
    IYieldAdapter public immutable adapter;
    address public immutable creator;
    address public immutable feeRecipient;

    string public name;
    uint256 public immutable minDeposit;
    uint256 public immutable maxDeposit;
    /**
     * @notice Comisión sobre la ganancia resignada, en basis points.
     * @dev 1000 = 10%. Cubre el gas y el sostenimiento de la plataforma.
     *      Sale SIEMPRE de lo resignado, nunca del capital de nadie.
     */
    uint256 public immutable exitFeeBps;
    uint16 public immutable capacity;
    /// @notice Hasta cuándo se puede entrar. Si no se llena, nadie pierde nada.
    uint64 public immutable joinDeadline;
    /// @notice Cuánto dura el ahorro. Se cuenta desde que se llena, no desde hoy.
    uint64 public immutable duration;
    bool public immutable isPrivate;

    /// @dev El cierre recorre participantes; el tope acota el gas.
    uint16 public constant MAX_CAPACITY = 20;

    /* --------------------------------- estado -------------------------------- */

    Status public status;
    /// @notice Cuándo se llenó y arrancó el reloj. 0 si todavía no pasó.
    uint64 public activatedAt;
    /// @notice Cuándo se puede cerrar. 0 hasta que se active.
    uint64 public maturity;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    /// @notice Lo que puso cada uno. Es lo que se le devuelve si sale antes.
    mapping(address => uint256) public principalOf;
    address[] public participants;

    /**
     * @notice Lo que le tocó a cada uno del reparto de las salidas.
     *
     * @dev Va aparte de las participaciones a propósito. El valor de una
     *      participación se reparte PROPORCIONAL a lo que cada uno puso —así
     *      funciona el rendimiento normal—, pero lo que deja quien se va se
     *      reparte EN PARTES IGUALES entre los que se quedan. Son dos reglas
     *      distintas y por eso necesitan dos contabilidades.
     */
    mapping(address => uint256) public bonusOf;

    /**
     * @notice Suma de todos los `bonusOf` pendientes.
     * @dev Se descuenta de `totalAssets()` para que ese dinero no se cuente dos
     *      veces: ya tiene dueño asignado y no debe inflar el valor de las
     *      participaciones.
     */
    uint256 public reservedBonus;

    /* --------------------------------- eventos ------------------------------- */

    event Joined(address indexed account, uint256 amount, uint256 shares);
    /// @notice Se llenó: la plata pasa a generar y el plazo empieza a correr.
    event Activated(uint64 at, uint64 maturity, uint256 totalDeposited);
    event ExitedEarly(
        address indexed account,
        uint256 principalReturned,
        uint256 yieldForfeited,
        uint256 fee
    );
    /// @notice Lo resignado por quien se fue, repartido en partes iguales.
    event BonusShared(uint256 totalShared, uint256 perParticipant, uint256 among);
    event PoolClosed(uint256 totalDistributed);
    event Payout(address indexed account, uint256 amount);
    /// @dev Se emite sólo cuando se cierra antes de tiempo con el atajo de demo.
    event ForceClosedForDemo(address indexed by);

    /* --------------------------------- errores ------------------------------- */

    error NotOpen();
    error JoinClosed();
    error PoolFull();
    error AlreadyJoined();
    error AmountOutOfRange();
    error NotAParticipant();
    error AlreadyClosed();
    error NotMatureYet();
    error NotActiveYet();
    error OnlyCreator();
    error CapacityTooLarge();
    error InvalidConfig();

    struct Config {
        address asset;
        address adapter;
        address creator;
        address feeRecipient;
        string name;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint256 exitFeeBps;
        uint16 capacity;
        uint64 joinDeadline;
        uint64 duration;
        bool isPrivate;
    }

    constructor(Config memory c) {
        if (c.capacity > MAX_CAPACITY || c.capacity < 2) revert CapacityTooLarge();
        if (c.minDeposit == 0 || c.maxDeposit < c.minDeposit) revert InvalidConfig();
        if (c.joinDeadline <= block.timestamp || c.duration == 0) revert InvalidConfig();

        asset = IERC20(c.asset);
        adapter = IYieldAdapter(c.adapter);
        creator = c.creator;
        feeRecipient = c.feeRecipient;
        name = c.name;
        minDeposit = c.minDeposit;
        maxDeposit = c.maxDeposit;
        exitFeeBps = c.exitFeeBps;
        capacity = c.capacity;
        joinDeadline = c.joinDeadline;
        duration = c.duration;
        isPrivate = c.isPrivate;
        status = Status.Open;
    }

    /* ------------------------------- conversiones ---------------------------- */

    /**
     * @notice Lo que vale hoy todo lo depositado, con rendimiento incluido.
     * @dev Antes de activarse los fondos están en este contrato; después, en
     *      el adapter. Por eso hay que mirar en el lugar correcto.
     */
    function totalAssets() public view returns (uint256) {
        uint256 raw = status == Status.Open
            ? asset.balanceOf(address(this))
            : adapter.totalAssets();
        // Lo ya repartido tiene dueño: no infla el valor de las participaciones.
        return raw > reservedBonus ? raw - reservedBonus : 0;
    }

    /**
     * @dev El `+ 1` de ambos lados es la mitigación estándar contra el
     *      "inflation attack": sin él, el primero en entrar podría donar fondos
     *      al vault para que el siguiente reciba cero shares por redondeo.
     */
    function _toShares(uint256 assets_) internal view returns (uint256) {
        return Math.mulDiv(assets_, totalShares + 1, totalAssets() + 1);
    }

    function _toAssets(uint256 shares_) internal view returns (uint256) {
        return Math.mulDiv(shares_, totalAssets() + 1, totalShares + 1);
    }

    /// @notice Cuánto vale hoy lo de `account`: su parte más lo que le tocó de las salidas.
    function valueOf(address account) public view returns (uint256) {
        return _toAssets(sharesOf[account]) + bonusOf[account];
    }

    /* ---------------------------------- entrar -------------------------------- */

    function join(uint256 amount) external nonReentrant {
        if (status != Status.Open) revert NotOpen();
        if (block.timestamp >= joinDeadline) revert JoinClosed();
        if (participants.length >= capacity) revert PoolFull();
        if (sharesOf[msg.sender] != 0) revert AlreadyJoined();
        if (amount < minDeposit || amount > maxDeposit) revert AmountOutOfRange();

        // Se calcula ANTES de mover los fondos: si no, el depósito propio
        // diluiría su propio precio.
        uint256 shares = _toShares(amount);

        totalShares += shares;
        sharesOf[msg.sender] = shares;
        principalOf[msg.sender] = amount;
        participants.push(msg.sender);

        // La plata se queda ACÁ, quieta. No va al protocolo todavía.
        asset.safeTransferFrom(msg.sender, address(this), amount);

        emit Joined(msg.sender, amount, shares);

        // Con el último cupo arranca todo.
        if (participants.length == capacity) _activate();
    }

    /**
     * @dev Se llenó: los fondos pasan a generar rendimiento y el reloj del
     *      vencimiento arranca en este momento, no en la creación.
     */
    function _activate() internal {
        uint256 pot = asset.balanceOf(address(this));

        activatedAt = uint64(block.timestamp);
        maturity = uint64(block.timestamp) + duration;
        status = Status.Active;

        asset.forceApprove(address(adapter), pot);
        adapter.deposit(pot);

        emit Activated(activatedAt, maturity, pot);
    }

    /* ------------------------------ salida anticipada ------------------------- */

    /**
     * @notice Qué pasaría si `account` saliera ahora.
     * @return principalReturned lo que recupera (su capital)
     * @return yieldForfeited    la ganancia que resigna
     * @return fee               la comisión, que sale de esa ganancia
     */
    function previewExit(
        address account
    ) public view returns (uint256 principalReturned, uint256 yieldForfeited, uint256 fee) {
        uint256 shares = sharesOf[account];
        if (shares == 0) return (0, 0, 0);

        // Se resigna todo: la ganancia de la participación y lo que le hubiera
        // tocado de salidas anteriores.
        uint256 value = _toAssets(shares) + bonusOf[account];
        uint256 principal = principalOf[account];

        // El capital nunca se pierde. Si por lo que sea el valor bajó, se
        // devuelve lo que hay.
        principalReturned = value < principal ? value : principal;
        yieldForfeited = value - principalReturned;

        // La comisión es un porcentaje de lo resignado, nunca del capital.
        fee = (yieldForfeited * exitFeeBps) / 10_000;
    }

    function exitEarly() external nonReentrant {
        if (status == Status.Closed) revert AlreadyClosed();
        uint256 shares = sharesOf[msg.sender];
        if (shares == 0) revert NotAParticipant();

        (uint256 principalReturned, uint256 yieldForfeited, uint256 fee) = previewExit(msg.sender);
        bool wasActive = status == Status.Active;

        // Estado primero, movimientos después.
        uint256 ownBonus = bonusOf[msg.sender];
        reservedBonus -= ownBonus;
        bonusOf[msg.sender] = 0;

        totalShares -= shares;
        sharesOf[msg.sender] = 0;
        principalOf[msg.sender] = 0;
        _removeParticipant(msg.sender);

        // Lo resignado, menos la comisión, se reparte EN PARTES IGUALES entre
        // los que se quedan: no importa cuánto puso cada uno.
        uint256 toShare = yieldForfeited - fee;
        uint256 leftoverDust = _shareEqually(toShare);

        // Si todavía no se activó, la plata está acá y no hay nada que sacar
        // del protocolo. Y como no hubo rendimiento, se devuelve todo entero.
        uint256 toFees = fee + leftoverDust;
        if (wasActive) adapter.withdraw(principalReturned + toFees, address(this));

        asset.safeTransfer(msg.sender, principalReturned);
        if (toFees > 0) asset.safeTransfer(feeRecipient, toFees);

        // Si se va el último de un chanchito YA ACTIVO, no queda nadie a quien
        // beneficiar con lo resignado y el chanchito se termina.
        //
        // Antes de arrancar es distinto: que se vaya el único inscripto no
        // cierra nada. El chanchito sigue abierto esperando a que se sume otro.
        if (wasActive && totalShares == 0) {
            uint256 leftover = adapter.withdrawAll(address(this));
            if (leftover > 0) asset.safeTransfer(feeRecipient, leftover);
            status = Status.Closed;
        }

        emit ExitedEarly(msg.sender, principalReturned, yieldForfeited, fee);
    }

    /**
     * @dev Reparte `amount` en partes iguales entre los participantes que
     *      quedan y devuelve el resto que no se pudo dividir.
     *
     *      Es un bucle sobre los participantes, y está bien que lo sea: el
     *      chanchito tiene un tope de {MAX_CAPACITY}, así que el costo está
     *      acotado y no crece con el uso.
     */
    function _shareEqually(uint256 amount) internal returns (uint256 dust) {
        uint256 count = participants.length;
        if (amount == 0) return 0;
        if (count == 0) return amount; // no queda nadie: va todo a comisión

        uint256 per = amount / count;
        if (per == 0) return amount;

        for (uint256 i = 0; i < count; i++) {
            bonusOf[participants[i]] += per;
        }
        reservedBonus += per * count;

        emit BonusShared(per * count, per, count);
        return amount - (per * count);
    }

    /* ---------------------------------- cierre -------------------------------- */

    /// @notice Cierra el chanchito y reparte. Cualquiera puede llamarla al vencer.
    function close() external nonReentrant {
        if (status != Status.Active) revert NotActiveYet();
        if (block.timestamp < maturity) revert NotMatureYet();
        _close();
    }

    /**
     * @notice ATAJO DE DEMO — cierra antes del vencimiento.
     * @dev Existe sólo para poder mostrar el flujo completo sin esperar meses.
     *      Emite su propio evento para que quede rastro de que no fue un cierre
     *      normal. **Sacar antes de producción.**
     */
    function forceCloseForDemo() external nonReentrant {
        if (msg.sender != creator) revert OnlyCreator();
        if (status != Status.Active) revert NotActiveYet();
        emit ForceClosedForDemo(msg.sender);
        _close();
    }

    function _close() internal {
        if (status == Status.Closed) revert AlreadyClosed();
        status = Status.Closed;

        uint256 total = adapter.withdrawAll(address(this));
        uint256 shares_ = totalShares;
        if (shares_ == 0) {
            if (total > 0) asset.safeTransfer(feeRecipient, total);
            emit PoolClosed(0);
            return;
        }

        // Lo repartido por salidas ya tiene dueño: se paga aparte, en partes
        // iguales, y no entra en el reparto proporcional.
        uint256 shareable = total > reservedBonus ? total - reservedBonus : 0;

        uint256 distributed;
        uint256 count = participants.length;
        for (uint256 i = 0; i < count; i++) {
            address p = participants[i];
            uint256 s = sharesOf[p];
            if (s == 0) continue;

            uint256 amount = Math.mulDiv(s, shareable, shares_) + bonusOf[p];
            sharesOf[p] = 0;
            bonusOf[p] = 0;
            distributed += amount;
            asset.safeTransfer(p, amount);
            emit Payout(p, amount);
        }
        totalShares = 0;
        reservedBonus = 0;

        // El polvo del redondeo no se deja trabado.
        uint256 dust = total - distributed;
        if (dust > 0) asset.safeTransfer(feeRecipient, dust);

        emit PoolClosed(distributed);
    }

    /* ---------------------------------- lectura ------------------------------- */

    struct Summary {
        string name;
        address asset;
        Status status;
        uint256 totalAssets;
        uint256 totalShares;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint256 goal;
        uint16 capacity;
        uint16 filled;
        uint64 joinDeadline;
        /// @dev 0 hasta que se llena: el plazo no arranca antes.
        uint64 maturity;
        uint64 activatedAt;
        uint64 duration;
        uint256 aprBps;
        bool isPrivate;
    }

    /// @notice Todo lo que la app necesita de un chanchito, en una sola llamada.
    function summary() external view returns (Summary memory) {
        return
            Summary({
                name: name,
                asset: address(asset),
                status: status,
                totalAssets: totalAssets(),
                totalShares: totalShares,
                minDeposit: minDeposit,
                maxDeposit: maxDeposit,
                goal: maxDeposit * capacity,
                capacity: capacity,
                filled: uint16(participants.length),
                joinDeadline: joinDeadline,
                maturity: maturity,
                activatedAt: activatedAt,
                duration: duration,
                aprBps: adapter.currentAprBps(),
                isPrivate: isPrivate
            });
    }

    /**
     * @notice El chanchito no llegó a llenarse y venció el plazo de entrada.
     * @dev En ese caso nunca generó nada y cada uno puede sacar su plata
     *      completa con `exitEarly()`, sin comisión.
     */
    function failedToFill() external view returns (bool) {
        return status == Status.Open && block.timestamp >= joinDeadline;
    }

    function participantsList() external view returns (address[] memory) {
        return participants;
    }

    function participantCount() external view returns (uint256) {
        return participants.length;
    }

    /* ---------------------------------- interno ------------------------------- */

    function _removeParticipant(address account) internal {
        uint256 count = participants.length;
        for (uint256 i = 0; i < count; i++) {
            if (participants[i] == account) {
                participants[i] = participants[count - 1];
                participants.pop();
                return;
            }
        }
    }
}
