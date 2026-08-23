import { network } from 'hardhat';
import { formatUnits } from 'viem';

const FACTORY = '0x6057180c135760421085621d24c4ef53d4eb65be';
const APP = '0xE9C325C8f318cC62F550A0E95A1b99D91b318D79';
const USDT = '0xd077a400968890eacc75cdc901f0356c943e4fdb';
const erc20 = [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;
const u = (v: bigint) => `$${formatUnits(v, 6)}`;

async function main() {
  const { viem } = await network.connect();
  const pub = await viem.getPublicClient();
  const factory = await viem.getContractAt('PoolFactory', FACTORY);
  const pools = await factory.read.poolsPage([0n, 10n]);

  console.log('saldo USDT de la wallet de la app:', u(await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [APP] })));
  console.log('');

  for (const address of pools) {
    const vault = await viem.getContractAt('PoolVault', address);
    const s = await vault.read.summary();
    const shares = await vault.read.sharesOf([APP]);
    const mark = shares > 0n ? ' ← estoy adentro' : '';
    if (s.filled > 0 || shares > 0n) {
      console.log(`${s.name}`);
      console.log(`   ${address}`);
      console.log(`   juntado ${u(s.totalAssets)} de ${u(s.goal)} · ${s.filled}/${s.capacity} cupos${mark}`);
      if (shares > 0n) {
        console.log(`   mi capital: ${u(await vault.read.principalOf([APP]))} · vale hoy ${u(await vault.read.valueOf([APP]))}`);
        console.log(`   participantes: ${(await vault.read.participantsList()).join(', ')}`);
      }
    }
  }
}
main().catch(console.error);
