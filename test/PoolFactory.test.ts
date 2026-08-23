import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { stringToHex } from 'viem';

const USDT = (whole: number) => BigInt(whole) * 1_000_000n;
const DAY = 86_400;

/** Un código de invitación de 6 caracteres, como el que genera la app. */
const code = (text: string) => stringToHex(text, { size: 6 });

describe('PoolFactory', async () => {
  const { viem, networkHelpers } = await network.connect();

  let usdt: any, factory: any;
  let deployer: any, otra: any, fees: any;

  function params(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Viaje a Salta',
      minDeposit: USDT(50),
      maxDeposit: USDT(200),
      capacity: 5,
      joinDeadline: 0n, // se completa abajo
      duration: 0n,
      isPrivate: false,
      code: code('\0\0\0\0\0\0'),
      ...overrides,
    };
  }

  async function create(overrides: Record<string, unknown> = {}) {
    const now = BigInt(await networkHelpers.time.latest());
    await factory.write.createPool([
      {
        ...params(overrides),
        joinDeadline: now + BigInt(7 * DAY),
        duration: BigInt(120 * DAY),
      },
    ]);
  }

  beforeEach(async () => {
    [deployer, otra, fees] = await viem.getWalletClients();
    usdt = await viem.deployContract('MockUSDT');
    const adapterFactory = await viem.deployContract('MockYieldAdapterFactory', [
      usdt.address,
      450n,
    ]);
    factory = await viem.deployContract('PoolFactory', [
      usdt.address,
      adapterFactory.address,
      fees.account.address,
      1000n, // 10% de comisión sobre lo resignado
    ]);
  });

  it('crea un chanchito y lo registra', async () => {
    await create();

    assert.equal(await factory.read.poolsLength(), 1n);
    const [address] = await factory.read.poolsPage([0n, 10n]);
    assert.equal(await factory.read.isPool([address]), true);

    const vault = await viem.getContractAt('PoolVault', address);
    const summary = await vault.read.summary();
    assert.equal(summary.name, 'Viaje a Salta');
    assert.equal(summary.capacity, 5);
    assert.equal(summary.filled, 0);
    assert.equal(summary.goal, USDT(1000), 'meta = máximo × cupos');
    assert.equal(summary.aprBps, 450n);
  });

  it('ata el adapter al vault que le corresponde', async () => {
    await create();
    const [address] = await factory.read.poolsPage([0n, 10n]);
    const vault = await viem.getContractAt('PoolVault', address);
    const adapter = await viem.getContractAt('MockYieldAdapter', await vault.read.adapter());

    assert.equal(
      (await adapter.read.vault()).toLowerCase(),
      address.toLowerCase(),
      'cada adapter pertenece a un solo vault',
    );
  });

  it('lista del más nuevo al más viejo, y pagina', async () => {
    await create({ name: 'Primero' });
    await create({ name: 'Segundo' });
    await create({ name: 'Tercero' });

    const page = await factory.read.poolsPage([0n, 2n]);
    assert.equal(page.length, 2);

    const first = await viem.getContractAt('PoolVault', page[0]);
    assert.equal(await first.read.name(), 'Tercero', 'el más nuevo primero');

    const second = await factory.read.poolsPage([2n, 2n]);
    assert.equal(second.length, 1, 'la última página trae lo que queda');

    assert.equal((await factory.read.poolsPage([99n, 5n])).length, 0, 'fuera de rango: vacío');
  });

  describe('códigos de invitación', () => {
    it('resuelve un código a su chanchito privado', async () => {
      await create({ name: 'Privado', isPrivate: true, code: code('ABC123') });

      const address = await factory.read.poolByCode([code('ABC123')]);
      const vault = await viem.getContractAt('PoolVault', address);
      assert.equal(await vault.read.name(), 'Privado');
      assert.equal(await vault.read.isPrivate(), true);
    });

    it('un código desconocido no resuelve nada', async () => {
      const address = await factory.read.poolByCode([code('NADAAA')]);
      assert.equal(BigInt(address), 0n);
    });

    it('no permite repetir un código', async () => {
      await create({ isPrivate: true, code: code('ABC123') });
      await assert.rejects(
        create({ isPrivate: true, code: code('ABC123') }),
        'el segundo con el mismo código debe fallar',
      );
    });

    it('un privado exige código', async () => {
      await assert.rejects(create({ isPrivate: true, code: code('\0\0\0\0\0\0') }));
    });
  });

  it('rechaza configuraciones imposibles', async () => {
    await assert.rejects(create({ capacity: 1 }), 'menos de 2 cupos');
    await assert.rejects(create({ capacity: 21 }), 'más del tope de cupos');
    await assert.rejects(
      create({ minDeposit: USDT(200), maxDeposit: USDT(50) }),
      'máximo menor que el mínimo',
    );
  });

  it('no permite una comisión abusiva', async () => {
    const adapterFactory = await viem.deployContract('MockYieldAdapterFactory', [usdt.address, 450n]);
    await assert.rejects(
      viem.deployContract('PoolFactory', [
        usdt.address,
        adapterFactory.address,
        fees.account.address,
        2500n, // 25%
      ]),
      'hay un tope duro del 20%',
    );
  });

  it('guarda quién creó cada chanchito', async () => {
    await create({ name: 'Mío' });
    const mine = await factory.read.poolsOf([deployer.account.address]);
    assert.equal(mine.length, 1);
    assert.equal((await factory.read.poolsOf([otra.account.address])).length, 0);
  });
});
