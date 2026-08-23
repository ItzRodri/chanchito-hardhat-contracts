import { network } from 'hardhat';
import { hexToString } from 'viem';

/**
 * Prepara un escenario social real contra Sepolia:
 * registra un nombre para la cuenta de deploy y le manda una solicitud de
 * amistad a la wallet del teléfono, para poder probar el flujo de aceptar
 * desde la app.
 */

const REGISTRY = process.env.REGISTRY as `0x${string}`;
const APP_WALLET = process.env.APP_WALLET as `0x${string}`;
const name = (b: string) => hexToString(b as `0x${string}`).replace(/\0+$/, '');

async function main() {
  const { viem } = await network.connect();
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  const me = wallet.account.address;

  const social = await viem.getContractAt('SocialRegistry', REGISTRY);

  // 1 — nombre para la cuenta de consola
  const existing = name(await social.read.usernameOf([me]));
  if (!existing) {
    const h = await social.write.register(['juli']);
    await pub.waitForTransactionReceipt({ hash: h });
    console.log('registrado: @juli →', me);
  } else {
    console.log('ya registrado como @' + existing);
  }

  // 2 — verificar la búsqueda inversa, que es lo que usa la app
  const found = await social.read.addressOf(['0x6a756c69000000000000000000000000000000000000000000000000000000' + '00']);
  console.log('addressOf("juli") →', found);

  // 3 — solicitud de amistad al teléfono
  const already = await social.read.isFriend([me, APP_WALLET]);
  const pending = await social.read.hasIncomingRequest([APP_WALLET, me]);

  if (already) {
    console.log('ya son amigos');
  } else if (pending) {
    console.log('la solicitud ya estaba enviada, esperando que la acepten');
  } else {
    const h = await social.write.sendRequest([APP_WALLET]);
    await pub.waitForTransactionReceipt({ hash: h });
    console.log('solicitud enviada a', APP_WALLET);
  }

  const requests = await social.read.requestsFor([APP_WALLET]);
  console.log('\nsolicitudes pendientes en el teléfono:', requests.length);
  for (const r of requests) console.log('  · @' + name(await social.read.usernameOf([r])), r);
}

main().catch((e) => { console.error('FALLÓ:', e.shortMessage ?? e.message); process.exitCode = 1; });
