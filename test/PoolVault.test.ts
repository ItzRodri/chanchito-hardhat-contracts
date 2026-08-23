import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';

/**
 * La prueba que importa es `exitEarly`: verificar que la ganancia que resigna
 * quien sale queda efectivamente para los que se quedan, sin repartirla a mano.
 */

const USDT = (whole: number) => BigInt(whole) * 1_000_000n;
const EXIT_FEE_BPS = 1000n; // 10%
const APR_BPS = 450n;

const DAY = 86_400;

/**
 * El vault redondea hacia abajo por el "+1" que protege del inflation attack.
 * La diferencia máxima es 1 unidad = 0,000001 USDT. Lo que importa no es que
 * el número sea exacto sino que el redondeo **siempre favorezca al chanchito**,
 * nunca a quien retira: eso se verifica en su propio test más abajo.
 */
const DUST = 1n;

function assertNear(actual: bigint, expected: bigint, message: string) {
  const diff = actual > expected ? actual - expected : expected - actual;
  assert.ok(
    diff <= DUST,
    `${message}\n  esperado ~${expected}\n  obtenido  ${actual}\n  diferencia ${diff}`,
  );
}

describe('PoolVault', async () => {
  const { viem, networkHelpers } = await network.connect();

  let usdt: any, factory: any, vault: any, adapter: any;
  let deployer: any, ana: any, beto: any, caro: any, fees: any;

  async function setup(capacity = 2) {
    [deployer, ana, beto, caro, fees] = await viem.getWalletClients();

    usdt = await viem.deployContract('MockUSDT');
    const adapterFactory = await viem.deployContract('MockYieldAdapterFactory', [
      usdt.address,
      APR_BPS,
    ]);
    factory = await viem.deployContract('PoolFactory', [
      usdt.address,
      adapterFactory.address,
      fees.account.address,
      EXIT_FEE_BPS,
    ]);

    const now = BigInt(await networkHelpers.time.latest());
    await factory.write.createPool([
      {
        name: 'Viaje a Salta',
        minDeposit: USDT(50),
        maxDeposit: USDT(200),
        capacity,
        joinDeadline: now + BigInt(7 * DAY),
        duration: BigInt(120 * DAY),
        isPrivate: false,
        code: '0x000000000000',
      },
    ]);

    const [vaultAddress] = await factory.read.poolsPage([0n, 10n]);
    vault = await viem.getContractAt('PoolVault', vaultAddress);
    adapter = await viem.getContractAt('MockYieldAdapter', await vault.read.adapter());

    for (const who of [ana, beto, caro]) {
      await usdt.write.mint([who.account.address, USDT(1000)]);
    }
  }

  async function join(who: any, whole: number) {
    await usdt.write.approve([vault.address, USDT(whole)], { account: who.account });
    await vault.write.join([USDT(whole)], { account: who.account });
  }

  /** Simula rendimiento mandándole tokens al adapter. */
  async function accrue(whole: number) {
    await usdt.write.mint([adapter.address, USDT(whole)]);
  }

  beforeEach(async () => {
    await setup();
  });

  it('acredita shares al entrar y guarda el capital', async () => {
    await join(ana, 100);

    assert.equal(await vault.read.principalOf([ana.account.address]), USDT(100));
    assert.equal(await vault.read.totalAssets(), USDT(100));
    assert.equal(await vault.read.valueOf([ana.account.address]), USDT(100));
  });

  it('reparte el rendimiento en proporción a lo puesto', async () => {
    await join(ana, 100);
    await join(beto, 200); // se llena y se activa
    await accrue(30); // $30 de ganancia sobre $300

    // Ana puso 1/3 → le tocan $10. Beto puso 2/3 → le tocan $20.
    assertNear(await vault.read.valueOf([ana.account.address]), USDT(110), 'Ana');
    assertNear(await vault.read.valueOf([beto.account.address]), USDT(220), 'Beto');
  });

  it('rechaza montos fuera del rango y a quien ya está adentro', async () => {
    await usdt.write.approve([vault.address, USDT(1000)], { account: ana.account });
    await assert.rejects(vault.write.join([USDT(10)], { account: ana.account }));
    await assert.rejects(vault.write.join([USDT(500)], { account: ana.account }));

    await join(ana, 100);
    await assert.rejects(vault.write.join([USDT(100)], { account: ana.account }));
  });

  describe('salida anticipada', () => {
    it('devuelve el capital completo y resigna la ganancia', async () => {
      await join(ana, 100);
      await join(beto, 100);
      await accrue(20); // $10 para cada uno

      const before = await usdt.read.balanceOf([ana.account.address]);
      await vault.write.exitEarly({ account: ana.account });
      const after = await usdt.read.balanceOf([ana.account.address]);

      // Recupera exactamente lo que puso: ni un centavo menos, ni la ganancia.
      assert.equal(after - before, USDT(100));
    });

    it('la comisión es un 10% de lo resignado, nunca del capital', async () => {
      await join(ana, 100);
      await join(beto, 100);
      await accrue(20); // $10 para cada uno

      const [principal, forfeited, fee] = await vault.read.previewExit([ana.account.address]);
      assert.equal(principal, USDT(100), 'capital intacto, sin redondeo');
      assertNear(forfeited, USDT(10), 'resigna su ganancia');
      assertNear(fee, USDT(1), '10% de los $10 resignados');

      await vault.write.exitEarly({ account: ana.account });
      assertNear(await usdt.read.balanceOf([fees.account.address]), USDT(1), 'cobrado');
    });

    it('LA REGLA: lo resignado va a quienes se quedan, menos la comisión', async () => {
      await join(ana, 100);
      await join(beto, 100);
      await accrue(20);

      const betoBefore = await vault.read.valueOf([beto.account.address]);
      assertNear(betoBefore, USDT(110), 'Beto antes');

      await vault.write.exitEarly({ account: ana.account });

      // Ana resignó $10. El 10% ($1) queda de comisión; los $9 van a Beto.
      const betoAfter = await vault.read.valueOf([beto.account.address]);
      assertNear(betoAfter - betoBefore, USDT(9), 'lo que ganó Beto');
    });

    it('EL REPARTO ES EN PARTES IGUALES, no proporcional a lo puesto', async () => {
      // Beto pone el doble que Caro. Con reparto proporcional le tocaría el
      // doble de lo que deja Ana; en partes iguales les toca lo mismo.
      await setup(3);
      await join(ana, 90);
      await join(beto, 200);
      await join(caro, 100);
      await accrue(39); // el chanchito ya está lleno y activo

      const betoBefore = await vault.read.valueOf([beto.account.address]);
      const caroBefore = await vault.read.valueOf([caro.account.address]);

      await vault.write.exitEarly({ account: ana.account });

      const betoGain = (await vault.read.valueOf([beto.account.address])) - betoBefore;
      const caroGain = (await vault.read.valueOf([caro.account.address])) - caroBefore;

      assertNear(betoGain, caroGain, 'a los dos les toca exactamente lo mismo');
      assert.ok(betoGain > 0n, 'y algo les tocó');
    });

    it('el que se va también resigna lo que le tocó de salidas anteriores', async () => {
      await setup(3);
      await join(ana, 100);
      await join(beto, 100);
      await join(caro, 100);
      await accrue(30);

      await vault.write.exitEarly({ account: ana.account }); // Beto y Caro reciben
      const betoBonus = await vault.read.bonusOf([beto.account.address]);
      assert.ok(betoBonus > 0n, 'a Beto le tocó algo');

      // Si ahora se va Beto, recupera su capital pero pierde ese bono también.
      const before = await usdt.read.balanceOf([beto.account.address]);
      await vault.write.exitEarly({ account: beto.account });
      assertNear(
        (await usdt.read.balanceOf([beto.account.address])) - before,
        USDT(100),
        'sólo su capital',
      );
      assert.equal(await vault.read.bonusOf([beto.account.address]), 0n);
    });

    it('no cobra comisión si todavía no hubo ganancia', async () => {
      await join(ana, 100);
      const [principal, forfeited, fee] = await vault.read.previewExit([ana.account.address]);

      assert.equal(principal, USDT(100));
      assert.equal(forfeited, 0n);
      assert.equal(fee, 0n, 'sin ganancia no hay de dónde cobrar');
    });

    it('el redondeo nunca favorece al que retira', async () => {
      await join(ana, 100);
      await join(beto, 200);
      await accrue(37); // un monto que no divide redondo

      const total = await vault.read.totalAssets();
      const anaValue = await vault.read.valueOf([ana.account.address]);
      const betoValue = await vault.read.valueOf([beto.account.address]);

      // La suma de las partes nunca puede superar el total: si lo superara,
      // el último en retirar se quedaría sin fondos.
      assert.ok(
        anaValue + betoValue <= total,
        `las partes (${anaValue + betoValue}) superan el total (${total})`,
      );
    });

    it('el cupo NO se reabre una vez que el chanchito arrancó', async () => {
      await join(ana, 100);
      await join(beto, 100); // se llena y arranca
      assert.equal(await vault.read.participantCount(), 2n);

      await vault.write.exitEarly({ account: ana.account });
      assert.equal(await vault.read.participantCount(), 1n);

      // Sigue activo y generando: nadie más puede entrar a mitad de camino.
      assert.equal(await vault.read.status(), 1, 'sigue Active');
      await assert.rejects(
        join(caro, 100),
        'una vez que arrancó, el grupo queda cerrado',
      );
    });

    it('antes de arrancar, salirse sí libera el cupo', async () => {
      await join(ana, 100);
      assert.equal(await vault.read.participantCount(), 1n);

      await vault.write.exitEarly({ account: ana.account });
      assert.equal(await vault.read.participantCount(), 0n);

      // Todavía no arrancó, así que el lugar vuelve a estar disponible.
      await join(caro, 100);
      assert.equal(await vault.read.participantCount(), 1n);
    });
  });

  describe('el rendimiento arranca cuando se llena', () => {
    it('con cupos libres, la plata queda quieta y no genera', async () => {
      await join(ana, 100);

      assert.equal(await vault.read.status(), 0, 'sigue Open');
      assert.equal(await vault.read.activatedAt(), 0n, 'no arrancó el reloj');
      assert.equal(await vault.read.maturity(), 0n, 'no hay vencimiento todavía');
      // La plata está en el vault, no en el adapter.
      assert.equal(await usdt.read.balanceOf([vault.address]), USDT(100));
      assert.equal(await usdt.read.balanceOf([adapter.address]), 0n);
    });

    it('al entrar el último se activa: la plata sale a generar y arranca el plazo', async () => {
      await join(ana, 100);
      await join(beto, 100); // capacidad 2 → se llena

      assert.equal(await vault.read.status(), 1, 'pasó a Active');
      const activatedAt = await vault.read.activatedAt();
      assert.ok(activatedAt > 0n, 'quedó registrado cuándo se llenó');
      assert.equal(
        await vault.read.maturity(),
        activatedAt + BigInt(120 * DAY),
        'el vencimiento se cuenta desde que se llenó, no desde que se creó',
      );

      // Y recién ahora los fondos están en el protocolo.
      assert.equal(await usdt.read.balanceOf([vault.address]), 0n);
      assert.equal(await usdt.read.balanceOf([adapter.address]), USDT(200));
    });

    it('el plazo NO corre mientras faltan cupos', async () => {
      await join(ana, 100);
      // Pasan 5 días con Ana sola adentro (la inscripción cierra a los 7).
      await networkHelpers.time.increase(5 * DAY);

      await join(beto, 100);
      const activatedAt = await vault.read.activatedAt();
      const maturity = await vault.read.maturity();

      // Los 120 días se cuentan desde ahora, no desde hace dos meses.
      assert.equal(maturity - activatedAt, BigInt(120 * DAY));
    });

    it('si no se llena, cada uno recupera su plata completa y sin comisión', async () => {
      await join(ana, 100);
      await networkHelpers.time.increase(8 * DAY); // vence la inscripción

      assert.equal(await vault.read.failedToFill(), true);

      const [principal, forfeited, fee] = await vault.read.previewExit([ana.account.address]);
      assert.equal(principal, USDT(100), 'todo su capital');
      assert.equal(forfeited, 0n, 'no había ganancia que resignar');
      assert.equal(fee, 0n, 'y por lo tanto no hay comisión');

      const before = await usdt.read.balanceOf([ana.account.address]);
      await vault.write.exitEarly({ account: ana.account });
      assert.equal(await usdt.read.balanceOf([ana.account.address]) - before, USDT(100));
    });
  });

  describe('cierre', () => {
    it('no deja cerrar un chanchito que nunca se llenó', async () => {
      await join(ana, 100);
      await assert.rejects(vault.write.close(), 'sin llenarse no hay nada que cerrar');
    });

    it('no deja cerrar antes del vencimiento', async () => {
      await join(ana, 100);
      await join(beto, 100);
      await assert.rejects(vault.write.close());
    });

    it('reparte capital + ganancia al vencer', async () => {
      await join(ana, 100);
      await join(beto, 200);
      await accrue(30);

      await networkHelpers.time.increase(121 * DAY);

      const anaBefore = await usdt.read.balanceOf([ana.account.address]);
      const betoBefore = await usdt.read.balanceOf([beto.account.address]);
      await vault.write.close();

      assertNear(await usdt.read.balanceOf([ana.account.address]) - anaBefore, USDT(110), 'Ana cobra');
      assertNear(await usdt.read.balanceOf([beto.account.address]) - betoBefore, USDT(220), 'Beto cobra');
      assert.equal(await vault.read.totalAssets(), 0n, 'no queda nada trabado');
    });

    it('el atajo de demo sólo lo puede usar quien lo creó', async () => {
      await join(ana, 100);
      await join(beto, 100);
      await assert.rejects(vault.write.forceCloseForDemo({ account: ana.account }));

      await vault.write.forceCloseForDemo({ account: deployer.account });
      assert.equal(await vault.read.status(), 2); // Closed
    });

    it('no se puede cerrar dos veces', async () => {
      await join(ana, 100);
      await join(beto, 100);
      await vault.write.forceCloseForDemo({ account: deployer.account });
      await assert.rejects(vault.write.forceCloseForDemo({ account: deployer.account }));
    });
  });
});
