// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title SocialRegistry
 * @notice Nombres de usuario y amistades, on-chain.
 *
 * @dev Existe por una razón concreta de producto: nadie va a tipear una
 *      dirección de 42 caracteres para agregar a un amigo. Con nombres, se
 *      busca "juli" y listo.
 *
 *      Y desbloquea la función que hoy es decorativa: los participantes de cada
 *      chanchito ya están en la cadena, así que cruzando esa lista contra tus
 *      amigos, el filtro "dónde están mis amigos" pasa a ser verdad.
 *
 *      Dos advertencias honestas sobre guardar esto en una cadena pública:
 *      la lista de amigos de cualquiera es legible por cualquiera, y los
 *      nombres son un espacio ocupable — el primero que llega se lo queda.
 */
contract SocialRegistry {
    /* -------------------------------- nombres -------------------------------- */

    /// @notice Nombre de cada cuenta, normalizado a minúsculas.
    mapping(address => bytes32) public usernameOf;
    /// @notice Búsqueda inversa: nombre → cuenta.
    mapping(bytes32 => address) public addressOf;

    /* ------------------------------- amistades ------------------------------- */

    mapping(address => mapping(address => bool)) public isFriend;
    mapping(address => address[]) private _friends;

    /// @notice Solicitudes que le llegaron a cada cuenta.
    mapping(address => mapping(address => bool)) public hasIncomingRequest;
    mapping(address => address[]) private _incoming;

    /* --------------------------------- eventos ------------------------------- */

    event Registered(address indexed account, bytes32 username);
    event RequestSent(address indexed from, address indexed to);
    event RequestAccepted(address indexed a, address indexed b);
    event RequestRejected(address indexed from, address indexed to);
    event FriendRemoved(address indexed a, address indexed b);

    /* --------------------------------- errores ------------------------------- */

    error UsernameTaken();
    error InvalidUsername();
    error AlreadyRegistered();
    error CannotFriendYourself();
    error AlreadyFriends();
    error RequestAlreadySent();
    error NoSuchRequest();
    error NotFriends();
    error NotRegistered();

    /* -------------------------------- registro ------------------------------- */

    /**
     * @notice Reserva un nombre para quien llama.
     * @dev Sólo una vez por cuenta: permitir el cambio obligaría a liberar el
     *      nombre viejo y abre la puerta a robar identidades ya conocidas.
     */
    function register(string calldata username) external {
        if (usernameOf[msg.sender] != bytes32(0)) revert AlreadyRegistered();

        bytes32 name = _normalize(username);
        if (addressOf[name] != address(0)) revert UsernameTaken();

        usernameOf[msg.sender] = name;
        addressOf[name] = msg.sender;

        emit Registered(msg.sender, name);
    }

    /**
     * @dev Valida y normaliza: 3 a 16 caracteres, sólo `a-z`, `0-9` y `_`.
     *      Las mayúsculas se bajan, para que "Juli" y "juli" no sean dos
     *      cuentas distintas que se puedan confundir.
     */
    function _normalize(string calldata input) internal pure returns (bytes32) {
        bytes memory raw = bytes(input);
        if (raw.length < 3 || raw.length > 16) revert InvalidUsername();

        bytes memory out = new bytes(raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];

            if (c >= 0x41 && c <= 0x5A) {
                c = bytes1(uint8(c) + 32); // A-Z → a-z
            }

            bool ok = (c >= 0x61 && c <= 0x7A) || // a-z
                (c >= 0x30 && c <= 0x39) || // 0-9
                c == 0x5F; // _
            if (!ok) revert InvalidUsername();

            out[i] = c;
        }
        return bytes32(bytes(out));
    }

    /* ------------------------------- solicitudes ----------------------------- */

    function sendRequest(address to) external {
        if (to == msg.sender) revert CannotFriendYourself();
        if (isFriend[msg.sender][to]) revert AlreadyFriends();
        if (hasIncomingRequest[to][msg.sender]) revert RequestAlreadySent();

        // Si la otra persona ya te había mandado solicitud, se aceptan solas.
        if (hasIncomingRequest[msg.sender][to]) {
            _removeIncoming(msg.sender, to);
            _link(msg.sender, to);
            emit RequestAccepted(msg.sender, to);
            return;
        }

        hasIncomingRequest[to][msg.sender] = true;
        _incoming[to].push(msg.sender);
        emit RequestSent(msg.sender, to);
    }

    function acceptRequest(address from) external {
        if (!hasIncomingRequest[msg.sender][from]) revert NoSuchRequest();

        _removeIncoming(msg.sender, from);
        _link(msg.sender, from);

        emit RequestAccepted(msg.sender, from);
    }

    function rejectRequest(address from) external {
        if (!hasIncomingRequest[msg.sender][from]) revert NoSuchRequest();

        _removeIncoming(msg.sender, from);
        emit RequestRejected(from, msg.sender);
    }

    /// @notice Quitar a alguien lo saca de las dos listas: la amistad es mutua.
    function removeFriend(address who) external {
        if (!isFriend[msg.sender][who]) revert NotFriends();

        _unlink(msg.sender, who);
        emit FriendRemoved(msg.sender, who);
    }

    /* --------------------------------- lectura ------------------------------- */

    function friendsOf(address account) external view returns (address[] memory) {
        return _friends[account];
    }

    function friendCountOf(address account) external view returns (uint256) {
        return _friends[account].length;
    }

    function requestsFor(address account) external view returns (address[] memory) {
        return _incoming[account];
    }

    /// @notice Nombres de varias cuentas de una sola llamada, para las listas.
    function usernamesOf(
        address[] calldata accounts
    ) external view returns (bytes32[] memory names) {
        names = new bytes32[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) names[i] = usernameOf[accounts[i]];
    }

    /**
     * @notice Cuáles de `candidates` son amigos de `account`.
     * @dev Pensado para cruzar los participantes de un chanchito contra tu
     *      lista sin traerte ambas al teléfono.
     */
    function filterFriends(
        address account,
        address[] calldata candidates
    ) external view returns (bool[] memory result) {
        result = new bool[](candidates.length);
        for (uint256 i = 0; i < candidates.length; i++) {
            result[i] = isFriend[account][candidates[i]];
        }
    }

    /* --------------------------------- interno ------------------------------- */

    function _link(address a, address b) internal {
        isFriend[a][b] = true;
        isFriend[b][a] = true;
        _friends[a].push(b);
        _friends[b].push(a);
    }

    function _unlink(address a, address b) internal {
        isFriend[a][b] = false;
        isFriend[b][a] = false;
        _removeFrom(_friends[a], b);
        _removeFrom(_friends[b], a);
    }

    function _removeIncoming(address owner, address from) internal {
        hasIncomingRequest[owner][from] = false;
        _removeFrom(_incoming[owner], from);
    }

    function _removeFrom(address[] storage list, address value) internal {
        uint256 length = list.length;
        for (uint256 i = 0; i < length; i++) {
            if (list[i] == value) {
                list[i] = list[length - 1];
                list.pop();
                return;
            }
        }
    }
}
