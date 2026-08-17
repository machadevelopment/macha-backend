import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { setupTestDatabase, ownerConnection, appConnection } from './setup';
import * as schema from '@/db/schema';
import { localeDeContenido } from '@/lib/content-locale';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CU-868krvuct — EL REPORTE SE ESCRIBE EN EL IDIOMA DE QUIEN LO PIDE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Macha generó un reporte con la plataforma en español y salió en inglés.
 *
 * El diagnóstico del ticket apuntaba al prompt, y ahí NO estaba el problema: el prompt lleva
 * el idioma desde siempre (`report-prompt.ts` tiene las directivas en los dos idiomas). El
 * problema era de dónde salía el valor — de `companies.locale`, que se fija una sola vez en
 * el registro y hoy no se puede editar desde ninguna pantalla, mientras que el selector de
 * idioma del producto resultó ser **solo una cookie del navegador** que nunca llegaba al
 * servidor.
 *
 * Va en integración y no en unitarios por dos razones que un mock no puede contestar:
 *
 *   1. La preferencia se guarda en `users`, y hay que comprobar que **`macha_app` de verdad
 *      puede escribir esa fila**. Es el rol restringido con el que corre la app; un
 *      `REVOKE` de más convertiría el arreglo en un 500 que ningún unitario vería.
 *   2. El orden de precedencia (usuario sobre empresa) solo significa algo con las dos
 *      filas existiendo de verdad.
 */
describe('idioma del contenido generado', () => {
  let owner: ReturnType<typeof ownerConnection>;
  let app: ReturnType<typeof appConnection>;

  const empresa = randomUUID();
  const usuarioEs = randomUUID();
  const usuarioEn = randomUUID();
  const fantasma = randomUUID();

  beforeAll(async () => {
    await setupTestDatabase();
    owner = ownerConnection();
    app = appConnection();

    // La empresa quedó en INGLÉS, como quedó la de Macha el día que se registró.
    await owner`
      insert into companies (id, workos_org_id, name, industry, base_currency, locale)
      values (${empresa}, ${'org_' + empresa}, 'Idioma SA', 'retail', 'GTQ', 'en')
    `;
    await owner`
      insert into users (id, workos_user_id, email, locale)
      values (${usuarioEs}, ${'wos_' + usuarioEs}, ${usuarioEs + '@test.local'}, 'es')
    `;
    await owner`
      insert into users (id, workos_user_id, email, locale)
      values (${usuarioEn}, ${'wos_' + usuarioEn}, ${usuarioEn + '@test.local'}, 'en')
    `;
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  const db = () => drizzle(owner, { schema }) as never;

  test('gana el idioma del USUARIO, no el de la empresa', async () => {
    /*
     * ESTE es el bug reportado, en una línea: la empresa está en inglés y el usuario lee en
     * español. Antes se devolvía 'en' y el reporte salía en inglés con la plataforma en
     * español. Es exactamente lo que Macha vio.
     */
    expect(await localeDeContenido(db(), empresa, usuarioEs)).toBe('es');
  });

  test('y si el usuario lee en inglés, en inglés — no es "siempre español"', async () => {
    // El contraste que impide que el arreglo sea "quemarlo en español". La preferencia se
    // respeta en las dos direcciones.
    expect(await localeDeContenido(db(), empresa, usuarioEn)).toBe('en');
  });

  test('sin usuario cae al de la empresa en vez de fallar', async () => {
    // Un reporte en el idioma equivocado es un defecto; un reporte que no se genera es una
    // caída. Ante una fila que no está, se degrada.
    expect(await localeDeContenido(db(), empresa, fantasma)).toBe('en');
  });

  test('macha_app PUEDE guardar la preferencia del usuario', async () => {
    /*
     * Lo que hace `PUT /me/locale`, con el rol restringido con el que corre la app de
     * verdad. Si `users` estuviera en la lista de REVOKE —no lo está, pero es la clase de
     * cosa que cambia sin que nadie lo note— el endpoint daría 500 y el selector volvería a
     * ser decorativo, que es el estado del que venimos.
     */
    const appDb = drizzle(app, { schema }) as never;

    await (appDb as unknown as ReturnType<typeof drizzle>)
      .update(schema.users)
      .set({ locale: 'en' })
      .where(eq(schema.users.id, usuarioEs));

    expect(await localeDeContenido(db(), empresa, usuarioEs)).toBe('en');

    // Se deja como estaba: los tests de arriba no dependen del orden, pero el siguiente que
    // alguien agregue no tiene por qué heredar el estado de éste.
    await (appDb as unknown as ReturnType<typeof drizzle>)
      .update(schema.users)
      .set({ locale: 'es' })
      .where(eq(schema.users.id, usuarioEs));
  });
});
