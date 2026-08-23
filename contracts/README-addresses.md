# Direcciones de Aave v3 en Sepolia

Sacadas de `@bgd-labs/aave-address-book` (fuente oficial). Sepolia es un
despliegue de prueba mantenido por BGD Labs: **pueden redeployarlo**, así que
conviene releerlas de ahí antes de un deploy importante en vez de confiar en
esta copia.

| Qué | Dirección |
| --- | --- |
| Chain ID | `11155111` |
| Pool | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| Protocol Data Provider | `0x3e9708d80f7B3e43118013075F7e95CE3AB31F31` |
| Faucet (para conseguir USDT de prueba) | `0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D` |
| USDT (subyacente) | `0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0` |
| aUSDT | `0xAF0F6e8b0Dc5c913bbF4d14c22B4E78Dd14310B6` |

USDT tiene **6 decimales**: `$1,50` se escribe `1500000`.

> El USDT tiene que ser exactamente ése. Cualquier otro "USDT de Sepolia" no es
> un reserve de este mercado y `supply()` revierte. Se consigue del faucet de
> Aave de arriba — no de sepoliafaucet.com, que da ETH para el gas.
