import { network } from 'hardhat';
import { formatUnits } from 'viem';

const DATA_PROVIDER = '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31';

const ASSETS = {
  DAI: { address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357' as `0x${string}`, decimals: 18 },
  LINK: { address: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5' as `0x${string}`, decimals: 18 },
  USDC: { address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8' as `0x${string}`, decimals: 6 },
  WBTC: { address: '0x29f2D40B0605204364af54EC677bD022dA425d03' as `0x${string}`, decimals: 8 },
  WETH: { address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c' as `0x${string}`, decimals: 18 },
  USDT: { address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as `0x${string}`, decimals: 6 },
  AAVE: { address: '0x88541670E55cC00bEEFD87eB59EDd1b7C511AC9a' as `0x${string}`, decimals: 18 },
  EURS: { address: '0x6d906e526a4e2Ca02097BA9d0caA3c382F52278E' as `0x${string}`, decimals: 2 },
  GHO: { address: '0xc4bF5CbDaBE595361438F8c6a187bDc330539c60' as `0x${string}`, decimals: 18 },
};

const abi = [
  { type: 'function', name: 'getReserveCaps', inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getReserveData', inputs: [{ type: 'address' }],
    outputs: [
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint40' },
    ], stateMutability: 'view' },
] as const;

async function main() {
  const { viem } = await network.connect();
  const pub = await viem.getPublicClient();
  console.log('activo    depositado /         tope   estado      APR');
  for (const [name, a] of Object.entries(ASSETS)) {
    try {
      const caps = await pub.readContract({ address: DATA_PROVIDER, abi, functionName: 'getReserveCaps', args: [a.address] });
      const data = await pub.readContract({ address: DATA_PROVIDER, abi, functionName: 'getReserveData', args: [a.address] });
      const supplied = Number(formatUnits(data[2] as bigint, a.decimals));
      const cap = Number((caps as any)[1]);
      const apr = Number(data[5] as bigint) / 1e25;
      const free = cap === 0 ? Infinity : cap - supplied;
      const state = free > 100 ? '>> HAY LUGAR' : 'lleno';
      console.log(`${name.padEnd(8)} ${supplied.toFixed(0).padStart(12)} / ${(cap === 0 ? 'sin tope' : cap.toFixed(0)).padStart(12)}  ${state.padEnd(12)} ${apr.toFixed(2)}%`);
    } catch {
      console.log(`${name.padEnd(8)} no se pudo leer`);
    }
  }
}
main().catch(console.error);
