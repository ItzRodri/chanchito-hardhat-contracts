# Desplegado en Sepolia (chain 11155111)

Cuenta de deploy: `0x22F75Ede8C9A8EE4747F91F9D4a54CebF3BF814e`

## Fábricas

| Fábrica | Dirección | Rendimiento | Uso |
| --- | --- | --- | --- |
| Demo (USDT) | `0x9a71064c0d783b4590056746105146334ae36963` | Simulado | **La que usa la app** |
| Aave (USDT) | `0xae9bf7430e63427b9a6b3fdd73800d2e005ad633` | Aave v3 | Inutilizable hoy: tope de USDT agotado |
| Aave (LINK) | `0x9f807ef4ef4df053eb6df7d142c5a74dda584846` | Aave v3 | Prueba de que el adapter funciona |

## Por qué la app usa la fábrica de demo

El mercado de Aave en Sepolia tiene los topes de depósito agotados para los tres
stablecoins:

| Activo | Depositado | Tope | |
| --- | --- | --- | --- |
| USDT | 4.064.446.113 | 2.000.000.000 | LLENO |
| USDC | 4.198.206.289 | 2.000.000.000 | LLENO |
| DAI | 5.084.451.940 | 2.000.000.000 | LLENO |

`supply()` revierte con el error `51` (SUPPLY_CAP_EXCEEDED). No es un problema
del contrato: la testnet está saturada. El faucet de GHO también está agotado
(`FACILITATOR_BUCKET_CAPACITY_EXCEEDED`).

## El AaveAdapter sí está verificado

Contra Aave v3 real, usando LINK (que no tiene tope):

- Chanchito: `0x7411B6D4bB99c49B696CebD7E84FadfD298Db8a9`
- Depósito de 50 LINK → el adapter quedó con 50 aLINK
  tx `0x262dd1e93d8de5db3e4254f3687ec7662893ab05916ad667433c48b6f091838a`
- El interés se acumuló solo: `50.000000` → `50.000220962746562049`
- APR leído de Aave: 232,27%
- Salida anticipada: recuperó el capital completo
  tx `0x6db43664da6f29795101fa483ec9f4486d006dd1011feda9281fe2b828bebcac`

Y confirmó la regla del negocio contra datos reales: como lo resignado
(`0,00022`) era menor que la comisión fija (2), la comisión se topeó ahí en vez
de descontar del capital.

## Si Aave libera cupo

Cambiar `EXPO_PUBLIC_POOL_FACTORY_ADDRESS` en la app a la fábrica de Aave. No
hay que tocar código: es la misma interfaz.
