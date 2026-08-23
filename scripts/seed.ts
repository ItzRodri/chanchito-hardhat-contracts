import { network } from 'hardhat';
import { parseUnits, stringToHex } from 'viem';

/**
 * Crea chanchitos de ejemplo en la cadena para que la app no arranque vacía.
 * Los nombres siguen las categorías que la app infiere en `contracts.ts`.
 */

const FACTORY = process.env.FACTORY as `0x${string}`;
const usdt = (n: number) => parseUnits(String(n), 6);
const DAY = 86_400n;

const POOLS = [
  { name: 'Viaje a Salta',       min: 50,  max: 200, capacity: 5, joinDays: 6n,  months: 4n,  private: false, code: '' },
  { name: 'Fondo emergencia',    min: 100, max: 500, capacity: 5, joinDays: 12n, months: 6n,  private: false, code: '' },
  { name: 'Notebook nueva',      min: 80,  max: 300, capacity: 5, joinDays: 9n,  months: 5n,  private: false, code: '' },
  { name: 'Alquiler del depto',  min: 200, max: 800, capacity: 6, joinDays: 15n, months: 8n,  private: false, code: '' },
  { name: 'Bici para el laburo', min: 40,  max: 150, capacity: 4, joinDays: 7n,  months: 3n,  private: false, code: '' },
  { name: 'Cumple sorpresa',     min: 20,  max: 100, capacity: 4, joinDays: 10n, months: 3n,  private: true,  code: 'ABC123' },
  { name: 'Asado del viernes',   min: 10,  max: 50,  capacity: 2, joinDays: 9n,  months: 2n,  private: false, code: '' },
];

async function main() {
  const { viem } = await network.connect();
  const pub = await viem.getPublicClient();
  const factory = await viem.getContractAt('PoolFactory', FACTORY);

  const existing = await factory.read.poolsLength();
  console.log('chanchitos ya existentes:', existing);
  if (existing > 0n) {
    console.log('ya hay datos, no siembro de nuevo');
    return;
  }

  for (const p of POOLS) {
    const now = (await pub.getBlock()).timestamp;
    const hash = await factory.write.createPool([
      {
        name: p.name,
        minDeposit: usdt(p.min),
        maxDeposit: usdt(p.max),
        capacity: p.capacity,
        joinDeadline: now + p.joinDays * DAY,
        duration: p.months * 30n * DAY,
        isPrivate: p.private,
        code: p.private ? stringToHex(p.code, { size: 6 }) : '0x000000000000',
      },
    ]);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(
      `  ${receipt.status === 'success' ? '✓' : '✗'} ${p.name}${p.private ? ` (privado, código ${p.code})` : ''}`,
    );
  }

  const total = await factory.read.poolsLength();
  console.log('\ntotal en la cadena:', total);
  const page = await factory.read.poolsPage([0n, 10n]);
  console.log('direcciones:', page.length);
}

main().catch((e) => { console.error('FALLÓ:', e.shortMessage ?? e.message); process.exitCode = 1; });
