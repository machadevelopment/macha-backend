import { describe, expect, test } from 'bun:test';
import { fetchWorkosUser } from './workos-users';

/**
 * CU-868kjkfdf. Lo que se fija aquí es el CONTRATO con WorkOS, que es donde el ticket
 * original se equivocaba: daba por hecho que el email venía en el JWT. No viene, y por
 * eso existe esta llamada. Si algún día el access token empezara a traerlo, este archivo
 * es el recordatorio de por qué hay una llamada de red en el camino del alta.
 */
describe('fetchWorkosUser', () => {
  test('sin WORKOS_API_KEY falla con un mensaje accionable, no con un 500 opaco', async () => {
    // env se evalúa en el import, y el entorno de test nunca setea la clave.
    expect(fetchWorkosUser('user_01')).rejects.toThrow(/WORKOS_API_KEY/);
  });

  test('el mensaje remite al README para que el error se pueda resolver solo', async () => {
    expect(fetchWorkosUser('user_01')).rejects.toThrow(/Arranque local/);
  });
});
