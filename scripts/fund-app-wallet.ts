import { network } from 'hardhat';
import { parseEther, parseUnits, formatEther, formatUnits, isAddress, getAddress } from 'viem';

/**
 * Financia la wallet que generó la app en el teléfono.
 *
 * Hace falta hasta que exista el gasless: sin paymaster, esa wallet paga su
 * propio gas, así que necesita ETH además del USDT que va al chanchito.
 */

const APP_WALLET = process.env.APP_WALLET as `0x${string}`;
const FAUCET = '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D';
const USDT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0';

const faucetAbi = [{ type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }] as const;
const erc20Abi = [{ type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;

async function main() {
  if (!isAddress(APP_WALLET)) throw new Error(`dirección inválida: ${APP_WALLET}`);
  const to = getAddress(APP_WALLET);
  console.log('dirección válida y con checksum correcto:', to);

  const { viem } = await network.connect();
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  // 1 — ETH para el gas
  const ethBefore = await pub.getBalance({ address: to });
  console.log('ETH antes:', formatEther(ethBefore));
  if (ethBefore < parseEther('0.005')) {
    const hash = await wallet.sendTransaction({ to, value: parseEther('0.01') });
    await pub.waitForTransactionReceipt({ hash });
    console.log('  enviados 0,01 ETH →', hash);
  } else {
    console.log('  ya tiene suficiente');
  }

  // 2 — USDT para depositar
  const usdtBefore = await pub.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [to] });
  console.log('USDT antes:', formatUnits(usdtBefore, 6));
  if (usdtBefore < parseUnits('100', 6)) {
    const hash = await wallet.writeContract({
      address: FAUCET,
      abi: faucetAbi,
      functionName: 'mint',
      args: [USDT, to, parseUnits('1000', 6)],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log('  minteados 1000 USDT →', hash);
  } else {
    console.log('  ya tiene suficiente');
  }

  console.log('\n--- saldos finales de la wallet de la app ---');
  console.log('ETH: ', formatEther(await pub.getBalance({ address: to })));
  console.log('USDT:', formatUnits(await pub.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [to] }), 6));
}

main().catch((e) => { console.error('FALLÓ:', e.shortMessage ?? e.message); process.exitCode = 1; });
