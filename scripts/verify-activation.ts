import { network } from 'hardhat';
import { createWalletClient, formatUnits, http, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Verifica en Sepolia real la regla central: la plata queda quieta hasta que
 * se llenan los cupos, y recién ahí arranca el plazo y el rendimiento.
 *
 * Usa "Asado del viernes", que tiene 2 cupos para poder llenarlo en vivo.
 */

const FACTORY = process.env.FACTORY as `0x${string}`;
const USDT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0';
const FAUCET = '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D';

const erc20 = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const;
const faucetAbi = [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }] as const;

const u = (v: bigint) => `$${formatUnits(v, 6)}`;
const STATUS = ['Open', 'Active', 'Closed'];

async function main() {
  const { viem } = await network.connect();
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  const me = wallet.account.address;

  const factory = await viem.getContractAt('PoolFactory', FACTORY);
  const all = await factory.read.poolsPage([0n, 10n]);

  // "Asado del viernes" es el más nuevo.
  const vault = await viem.getContractAt('PoolVault', all[0]);
  console.log('chanchito:', await vault.read.name(), '·', all[0]);

  const adapter = await vault.read.adapter();

  const bal = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [me] });
  if (bal < parseUnits('60', 6)) {
    const h = await wallet.writeContract({ address: FAUCET, abi: faucetAbi, functionName: 'mint', args: [USDT, me, parseUnits('1000', 6)] });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  async function report(label: string) {
    const s = await vault.read.summary();
    const inVault = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [all[0]] });
    const inAdapter = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [adapter] });
    console.log(`\n${label}`);
    console.log(`  estado:        ${STATUS[s.status]}`);
    console.log(`  cupos:         ${s.filled}/${s.capacity}`);
    console.log(`  plata quieta:  ${u(inVault)}   (en el vault)`);
    console.log(`  generando:     ${u(inAdapter)}   (en el protocolo)`);
    console.log(`  activatedAt:   ${s.activatedAt}`);
    console.log(`  vencimiento:   ${s.maturity}`);
    return s;
  }

  await report('ANTES DE ENTRAR');

  // --- primer depósito: falta un cupo ---
  const amount = parseUnits('20', 6);
  let h: `0x${string}`;

  const alreadyIn = (await vault.read.sharesOf([me])) > 0n;
  if (!alreadyIn) {
    h = await wallet.writeContract({ address: USDT, abi: erc20, functionName: 'approve', args: [all[0], amount * 2n] });
    await pub.waitForTransactionReceipt({ hash: h });
    h = await vault.write.join([amount]);
    await pub.waitForTransactionReceipt({ hash: h });
  } else {
    console.log('\n(ya estaba adentro de una corrida anterior)');
  }
  const half = await report('TRAS EL PRIMER DEPÓSITO (falta 1 cupo)');

  if (half.status !== 0 || half.activatedAt !== 0n) throw new Error('❌ se activó antes de tiempo');
  console.log('  ✅ la plata está quieta y el plazo no arrancó');

  // --- segundo depósito desde otra cuenta: se llena ---
  // En una red real sólo hay la cuenta del .env, así que se crea una segunda
  // al vuelo y se la financia para que pueda firmar su propio depósito.
  const secondAccount = privateKeyToAccount(generatePrivateKey());
  const second = createWalletClient({
    account: secondAccount,
    chain: wallet.chain,
    transport: http(process.env.SEPOLIA_RPC_URL),
  });
  console.log('\nsegunda cuenta:', secondAccount.address);

  h = await wallet.sendTransaction({ to: secondAccount.address, value: parseUnits('0.005', 18) });
  await pub.waitForTransactionReceipt({ hash: h });
  h = await wallet.writeContract({ address: FAUCET, abi: faucetAbi, functionName: 'mint', args: [USDT, second.account.address, parseUnits('100', 6)] });
  await pub.waitForTransactionReceipt({ hash: h });

  h = await second.writeContract({ address: USDT, abi: erc20, functionName: 'approve', args: [all[0], amount], chain: null, account: second.account });
  await pub.waitForTransactionReceipt({ hash: h });
  h = await second.writeContract({ address: all[0], abi: vault.abi, functionName: 'join', args: [amount], chain: null, account: second.account });
  await pub.waitForTransactionReceipt({ hash: h });

  const full = await report('TRAS EL SEGUNDO DEPÓSITO (lleno)');

  if (full.status !== 1) throw new Error('❌ no se activó al llenarse');
  if (full.activatedAt === 0n) throw new Error('❌ no quedó registrado cuándo arrancó');
  if (full.maturity !== full.activatedAt + full.duration) throw new Error('❌ el vencimiento no se cuenta desde la activación');

  console.log('  ✅ se activó: la plata salió a generar y el plazo arrancó ahora');
  console.log(`\n✅ REGLA VERIFICADA EN SEPOLIA: vencimiento = activación + duración`);
}

main().catch((e) => { console.error('FALLÓ:', e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
