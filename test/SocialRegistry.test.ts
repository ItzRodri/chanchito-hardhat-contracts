import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { stringToHex, hexToString } from 'viem';

const name = (s: string) => stringToHex(s, { size: 32 });
const read = (b: string) => hexToString(b as `0x${string}`).replace(/\0+$/, '');

describe('SocialRegistry', async () => {
  const { viem } = await network.connect();
  let registry: any, meli: any, juli: any, tomi: any;

  beforeEach(async () => {
    [meli, juli, tomi] = await viem.getWalletClients();
    registry = await viem.deployContract('SocialRegistry');
  });

  const as = (who: any) => ({ account: who.account });

  describe('nombres', () => {
    it('reserva un nombre y lo resuelve en los dos sentidos', async () => {
      await registry.write.register(['meli'], as(meli));

      assert.equal(read(await registry.read.usernameOf([meli.account.address])), 'meli');
      assert.equal(
        (await registry.read.addressOf([name('meli')])).toLowerCase(),
        meli.account.address.toLowerCase(),
      );
    });

    it('normaliza a minúsculas: "Meli" y "meli" son el mismo nombre', async () => {
      await registry.write.register(['MeLi'], as(meli));
      assert.equal(read(await registry.read.usernameOf([meli.account.address])), 'meli');

      // Y por eso el de al lado no puede tomar la variante en mayúsculas.
      await assert.rejects(registry.write.register(['MELI'], as(juli)));
    });

    it('no permite repetir un nombre', async () => {
      await registry.write.register(['meli'], as(meli));
      await assert.rejects(registry.write.register(['meli'], as(juli)));
    });

    it('no permite cambiar el propio', async () => {
      await registry.write.register(['meli'], as(meli));
      await assert.rejects(registry.write.register(['meli2'], as(meli)));
    });

    it('rechaza nombres inválidos', async () => {
      await assert.rejects(registry.write.register(['ab'], as(meli)), 'muy corto');
      await assert.rejects(registry.write.register(['a'.repeat(17)], as(meli)), 'muy largo');
      await assert.rejects(registry.write.register(['con espacio'], as(meli)), 'espacios');
      await assert.rejects(registry.write.register(['hola!'], as(meli)), 'símbolos');
      await assert.rejects(registry.write.register(['ñandu'], as(meli)), 'no ascii');
    });

    it('acepta guion bajo y números', async () => {
      await registry.write.register(['meli_99'], as(meli));
      assert.equal(read(await registry.read.usernameOf([meli.account.address])), 'meli_99');
    });
  });

  describe('solicitudes', () => {
    it('llega, se acepta y quedan amigos de los dos lados', async () => {
      await registry.write.sendRequest([juli.account.address], as(meli));

      const pending = await registry.read.requestsFor([juli.account.address]);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].toLowerCase(), meli.account.address.toLowerCase());

      await registry.write.acceptRequest([meli.account.address], as(juli));

      assert.equal(await registry.read.isFriend([meli.account.address, juli.account.address]), true);
      assert.equal(await registry.read.isFriend([juli.account.address, meli.account.address]), true);
      assert.equal(await registry.read.friendCountOf([meli.account.address]), 1n);
      assert.equal((await registry.read.requestsFor([juli.account.address])).length, 0);
    });

    it('si los dos se mandan solicitud, quedan amigos sin aceptar', async () => {
      await registry.write.sendRequest([juli.account.address], as(meli));
      await registry.write.sendRequest([meli.account.address], as(juli));

      assert.equal(await registry.read.isFriend([meli.account.address, juli.account.address]), true);
      assert.equal((await registry.read.requestsFor([meli.account.address])).length, 0);
    });

    it('rechazar borra la solicitud sin crear amistad', async () => {
      await registry.write.sendRequest([juli.account.address], as(meli));
      await registry.write.rejectRequest([meli.account.address], as(juli));

      assert.equal((await registry.read.requestsFor([juli.account.address])).length, 0);
      assert.equal(await registry.read.isFriend([meli.account.address, juli.account.address]), false);
    });

    it('no se puede agregar a uno mismo ni duplicar la solicitud', async () => {
      await assert.rejects(registry.write.sendRequest([meli.account.address], as(meli)));
      await registry.write.sendRequest([juli.account.address], as(meli));
      await assert.rejects(registry.write.sendRequest([juli.account.address], as(meli)));
    });

    it('aceptar algo que no existe falla', async () => {
      await assert.rejects(registry.write.acceptRequest([juli.account.address], as(meli)));
    });
  });

  describe('quitar', () => {
    it('quita de las dos listas: la amistad es mutua', async () => {
      await registry.write.sendRequest([juli.account.address], as(meli));
      await registry.write.acceptRequest([meli.account.address], as(juli));

      await registry.write.removeFriend([juli.account.address], as(meli));

      assert.equal(await registry.read.isFriend([meli.account.address, juli.account.address]), false);
      assert.equal(await registry.read.isFriend([juli.account.address, meli.account.address]), false);
      assert.equal(await registry.read.friendCountOf([meli.account.address]), 0n);
      assert.equal(await registry.read.friendCountOf([juli.account.address]), 0n);
    });

    it('después de quitar se puede volver a agregar', async () => {
      await registry.write.sendRequest([juli.account.address], as(meli));
      await registry.write.acceptRequest([meli.account.address], as(juli));
      await registry.write.removeFriend([juli.account.address], as(meli));

      await registry.write.sendRequest([juli.account.address], as(meli));
      await registry.write.acceptRequest([meli.account.address], as(juli));
      assert.equal(await registry.read.friendCountOf([meli.account.address]), 1n);
    });
  });

  it('LA CLAVE: cruza los participantes de un chanchito contra tus amigos', async () => {
    // Ésta es la consulta que vuelve real el filtro "dónde están mis amigos".
    await registry.write.sendRequest([juli.account.address], as(meli));
    await registry.write.acceptRequest([meli.account.address], as(juli));

    const participants = [juli.account.address, tomi.account.address];
    const flags = await registry.read.filterFriends([meli.account.address, participants]);

    assert.deepEqual([...flags], [true, false], 'Juli es amiga, Tomi no');
  });

  it('trae varios nombres de una sola llamada', async () => {
    await registry.write.register(['meli'], as(meli));
    await registry.write.register(['juli'], as(juli));

    const names = await registry.read.usernamesOf([
      [meli.account.address, juli.account.address, tomi.account.address],
    ]);
    assert.equal(read(names[0]), 'meli');
    assert.equal(read(names[1]), 'juli');
    assert.equal(read(names[2]), '', 'sin registrar devuelve vacío');
  });
});
