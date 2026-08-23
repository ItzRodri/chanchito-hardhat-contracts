import type { HardhatUserConfig } from 'hardhat/config';
import { configVariable } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],
  solidity: {
    profiles: {
      // `viaIR` hace falta por el struct `Summary` del vault: devolver 14
      // campos en una sola llamada satura la pila del codegen viejo.
      default: {
        version: '0.8.28',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
      production: {
        version: '0.8.28',
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  networks: {
    hardhat: { type: 'edr-simulated', chainType: 'l1' },
    sepolia: {
      type: 'http',
      chainType: 'l1',
      url: configVariable('SEPOLIA_RPC_URL'),
      accounts: [configVariable('SEPOLIA_PRIVATE_KEY')],
    },
  },
};

export default config;
