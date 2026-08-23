import { network } from 'hardhat';
import { parseUnits } from 'viem';

/**
 * Deploy a Sepolia.
 *
 *   npx hardhat run scripts/deploy.ts --network sepolia
 *
 * Deploya dos fábricas de chanchitos:
 *
 *  - una sobre Aave, que es la real;
 *  - una sobre el adapter mock, para la demo.
 *
 * La segunda existe por un motivo concreto: en Sepolia el rendimiento de Aave
 * es prácticamente cero, así que un chanchito real mostraría "+$0,00" en
 * pantalla. Con la fábrica mock se le puede mandar USDT al adapter y ver la
 * ganancia moverse de verdad.
 */

const AAVE_SEPOLIA = {
  pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  dataProvider: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
  usdt: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
  aUsdt: '0xAF0F6e8b0Dc5c913bbF4d14c22B4E78Dd14310B6',
} as const;

/** Comisión sobre la ganancia resignada al salir antes: 10%. */
const EXIT_FEE_BPS = 1000n;
/** Tasa que reporta el adapter de demo, sólo cosmética. */
const DEMO_APR_BPS = 450n;

async function main() {
  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const feeRecipient = deployer.account.address;

  console.log('Deployando con', deployer.account.address);

  // --- fábrica real, sobre Aave ---
  const aaveAdapterFactory = await viem.deployContract('AaveAdapterFactory', [
    AAVE_SEPOLIA.usdt,
    AAVE_SEPOLIA.pool,
    AAVE_SEPOLIA.aUsdt,
    AAVE_SEPOLIA.dataProvider,
  ]);
  const aaveFactory = await viem.deployContract('PoolFactory', [
    AAVE_SEPOLIA.usdt,
    aaveAdapterFactory.address,
    feeRecipient,
    EXIT_FEE_BPS,
  ]);

  // --- fábrica de demo, sin protocolo detrás ---
  const mockAdapterFactory = await viem.deployContract('MockYieldAdapterFactory', [
    AAVE_SEPOLIA.usdt,
    DEMO_APR_BPS,
  ]);
  const demoFactory = await viem.deployContract('PoolFactory', [
    AAVE_SEPOLIA.usdt,
    mockAdapterFactory.address,
    feeRecipient,
    EXIT_FEE_BPS,
  ]);

  // --- registro social: nombres y amistades ---
  const social = await viem.deployContract('SocialRegistry');

  console.log('\n--- Pegar en el .env de la app ---\n');
  console.log(`EXPO_PUBLIC_CHAIN_ID=11155111`);
  console.log(`EXPO_PUBLIC_USDT_ADDRESS=${AAVE_SEPOLIA.usdt}`);
  console.log(`EXPO_PUBLIC_POOL_FACTORY_ADDRESS=${aaveFactory.address}`);
  console.log(`EXPO_PUBLIC_DEMO_FACTORY_ADDRESS=${demoFactory.address}`);
  console.log(`EXPO_PUBLIC_SOCIAL_REGISTRY_ADDRESS=${social.address}`);
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
