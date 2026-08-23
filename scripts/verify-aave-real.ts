import { network } from 'hardhat';
import { parseUnits, formatUnits } from 'viem';

/**
 * Prueba real del AaveAdapter contra Aave v3 en Sepolia.
 *
 * Se usa GHO en vez de USDT porque el tope de depósitos de USDT en Sepolia
 * está agotado (hay el doble de lo permitido). LINK no tiene tope, así que
 * sirve para demostrar que el adapter habla bien con Aave — que es lo que se
 * quiere verificar acá, no qué token se usa.
 */

const FAUCET = '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D';
const GHO = '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5';
const A_GHO = '0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24';
const POOL = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951';
const DATA_PROVIDER = '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31';

const faucetAbi = [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }] as const;
const erc20Abi = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const;

const gho = (v: bigint) => `${Number(formatUnits(v, 18)).toFixed(4)} LINK`;

async function main() {
  const { viem } = await network.connect();
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  const me = wallet.account.address;

  // 1 — GHO del faucet
  let balance = await pub.readContract({ address: GHO, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  if (balance < parseUnits('100', 18)) {
    console.log('pidiendo LINK al faucet…');
    const h = await wallet.writeContract({ address: FAUCET, abi: faucetAbi, functionName: 'mint', args: [GHO, me, parseUnits('1000', 18)] });
    await pub.waitForTransactionReceipt({ hash: h });
    balance = await pub.readContract({ address: GHO, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  }
  console.log('1. saldo LINK:', gho(balance));

  // 2 — fábrica sobre Aave (se reusa si ya existe, para no gastar gas de más)
  const existing = process.env.LINK_FACTORY as `0x${string}` | undefined;
  const factory = existing
    ? await viem.getContractAt('PoolFactory', existing)
    : await viem.deployContract('PoolFactory', [
        GHO,
        (await viem.deployContract('AaveAdapterFactory', [GHO, POOL, A_GHO, DATA_PROVIDER])).address,
        me,
        parseUnits('2', 18),
      ]);
  console.log('2. fábrica:', factory.address);

  // La hora tiene que salir de la cadena, no del reloj local.
  const now = (await pub.getBlock()).timestamp;
  await factory.write.createPool([{
    name: 'Prueba Aave LINK',
    minDeposit: parseUnits('10', 18),
    maxDeposit: parseUnits('200', 18),
    capacity: 3,
    joinDeadline: now + 7n * 86400n,
    maturity: now + 120n * 86400n,
    isPrivate: false,
    code: '0x000000000000',
  }]);

  const [poolAddress] = await factory.read.poolsPage([0n, 1n]);
  const vault = await viem.getContractAt('PoolVault', poolAddress);
  const adapter = await vault.read.adapter();
  console.log('   chanchito:', poolAddress);
  console.log('   adapter:  ', adapter);

  // 3 — depositar de verdad
  const amount = parseUnits('50', 18);
  const ap = await wallet.writeContract({ address: GHO, abi: erc20Abi, functionName: 'approve', args: [poolAddress, amount] });
  await pub.waitForTransactionReceipt({ hash: ap });

  console.log('3. depositando', gho(amount), '→ el adapter debería llamar a Aave…');
  const joinHash = await vault.write.join([amount]);
  const receipt = await pub.waitForTransactionReceipt({ hash: joinHash });
  console.log('   tx:', joinHash);
  console.log('   gas:', receipt.gasUsed);

  // 4 — ¿los fondos están en Aave?
  const aTokens = await pub.readContract({ address: A_GHO, abi: erc20Abi, functionName: 'balanceOf', args: [adapter] });
  const totalAssets = await vault.read.totalAssets();
  const mine = await vault.read.valueOf([me]);
  const summary = await vault.read.summary();

  console.log('4. aLINK en poder del adapter:', gho(aTokens));
  console.log('   totalAssets del vault:    ', gho(totalAssets));
  console.log('   mi participación vale:    ', gho(mine));
  console.log('   APR leído de Aave:        ', Number(summary.aprBps) / 100, '%');

  // 5 — salir y recuperar
  console.log('5. probando la salida anticipada…');
  const before = await pub.readContract({ address: GHO, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  const exitHash = await vault.write.exitEarly();
  await pub.waitForTransactionReceipt({ hash: exitHash });
  const after = await pub.readContract({ address: GHO, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  console.log('   recuperado:', gho(after - before));

  console.log('');
  if (aTokens > 0n && after > before) {
    console.log('✅ AaveAdapter VERIFICADO contra Aave v3 real: depositó, generó aTokens y devolvió el capital.');
  } else {
    console.log('❌ algo no cerró');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FALLÓ:', e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
