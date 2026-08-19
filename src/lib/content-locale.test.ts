import { describe, expect, test } from 'bun:test';
import { localeDeContenido } from './content-locale';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL IDIOMA DEL CONTENIDO GENERADO — CU-868ku6pp9
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Jose lo reportó con la plataforma ENTERA en inglés: el reporte a demanda salió en español.
 *
 * La causa está anotada a propósito en el frontend (`lib/i18n/persist-locale.ts`): el
 * `PUT /me/locale` del selector se traga sus fallos para no trabar la interfaz, así que la
 * cookie y `users.locale` pueden quedar desincronizados en silencio y para siempre.
 *
 * Reintentar el PUT no arregla la clase de bug —siempre puede fallar la última vez—. Lo que
 * lo arregla es que la petición lleve el idioma que la pantalla muestra, y que verlo distinto
 * al guardado sea suficiente para corregir el guardado. Estos tests fijan ese contrato.
 *
 * Se usa un doble de `db` a mano y no Postgres: lo que hay que verificar es la DECISIÓN (qué
 * idioma sale, y si escribe o no), no que Drizzle sepa hacer un UPDATE.
 */

const EMPRESA = 'company-1';
const USUARIO = 'user-1';

/** Doble mínimo de `DB`: devuelve lo que se le diga y anota si se escribió. */
function dobleDeDb(opts: { userLocale?: 'es' | 'en' | null; companyLocale?: 'es' | 'en' }) {
  const escrituras: Array<'es' | 'en'> = [];
  let tabla = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          // Primera consulta = users, segunda = companies. Es el orden del módulo.
          tabla++;
          if (tabla === 1) {
            return opts.userLocale === undefined ? [] : [{ locale: opts.userLocale }];
          }
          return opts.companyLocale ? [{ locale: opts.companyLocale }] : [];
        },
      }),
    }),
    update: () => ({
      set: (v: { locale: 'es' | 'en' }) => ({
        where: () => {
          escrituras.push(v.locale);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: db as never, escrituras };
}

describe('el idioma que la pantalla muestra gana', () => {
  /** EL CASO DEL REPORTE DE JOSE: interfaz en inglés, `users.locale` quedó en español. */
  test('interfaz en inglés + users.locale en español → el contenido sale en INGLÉS', async () => {
    const { db } = dobleDeDb({ userLocale: 'es' });
    expect(await localeDeContenido(db, EMPRESA, USUARIO, 'en')).toBe('en');
  });

  test('y de paso CORRIGE users.locale, para que el correo también se entere', async () => {
    /*
     * Persistirlo es lo que mantiene las tres superficies de acuerdo. El correo de "tu reporte
     * está listo" se manda desde un worker que no tiene ninguna cookie a la vista: si solo se
     * arreglara la respuesta de esta petición, el reporte saldría en inglés y su correo en
     * español.
     */
    const { db, escrituras } = dobleDeDb({ userLocale: 'es' });
    await localeDeContenido(db, EMPRESA, USUARIO, 'en');
    expect(escrituras).toEqual(['en']);
  });

  test('si ya coinciden, NO escribe', async () => {
    // Un UPDATE por cada reporte generado ensucia el `updated_at` de la fila a cambio de nada.
    const { db, escrituras } = dobleDeDb({ userLocale: 'en' });
    expect(await localeDeContenido(db, EMPRESA, USUARIO, 'en')).toBe('en');
    expect(escrituras).toEqual([]);
  });

  test('un fallo al persistir NO tumba la generación del contenido', async () => {
    /*
     * El orden importa: primero se responde bien, después se intenta guardar. Que no se pueda
     * guardar la preferencia es un defecto que se auto-corrige en la siguiente petición; que no
     * se genere el reporte es una caída.
     */
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ locale: 'es' }] }) }),
      update: () => ({
        set: () => ({ where: () => Promise.reject(new Error('conexión caída')) }),
      }),
    } as never;
    expect(await localeDeContenido(db, EMPRESA, USUARIO, 'en')).toBe('en');
  });
});

describe('un valor que no es es/en se ignora', () => {
  /*
   * `visible` viene del cliente. No es un dato de seguridad —el peor caso de mentir es recibir
   * tu propio reporte en el otro idioma— pero un valor basura no puede filtrarse a un prompt
   * ni escribirse en la base.
   */
  for (const basura of ['fr', 'ES', '', 'es-GT', 'null', '../../etc']) {
    test(`"${basura}" no se usa ni se persiste`, async () => {
      const { db, escrituras } = dobleDeDb({ userLocale: 'es' });
      expect(await localeDeContenido(db, EMPRESA, USUARIO, basura)).toBe('es');
      expect(escrituras).toEqual([]);
    });
  }

  test('undefined y null caen al comportamiento de antes', async () => {
    const a = dobleDeDb({ userLocale: 'en' });
    expect(await localeDeContenido(a.db, EMPRESA, USUARIO, undefined)).toBe('en');
    const b = dobleDeDb({ userLocale: 'en' });
    expect(await localeDeContenido(b.db, EMPRESA, USUARIO, null)).toBe('en');
  });
});

describe('la cadena de respaldo que ya existía (CU-868krvuct)', () => {
  test('sin idioma visible, manda users.locale', async () => {
    const { db } = dobleDeDb({ userLocale: 'en', companyLocale: 'es' });
    expect(await localeDeContenido(db, EMPRESA, USUARIO)).toBe('en');
  });

  test('sin users.locale, cae al de la empresa', async () => {
    const { db } = dobleDeDb({ userLocale: null, companyLocale: 'en' });
    expect(await localeDeContenido(db, EMPRESA, USUARIO)).toBe('en');
  });

  test('sin usuario en la base tampoco falla: cae al de la empresa', async () => {
    // Una fila borrada o una carrera. Un reporte en el idioma equivocado es un defecto; uno
    // que no se genera es una caída.
    const { db } = dobleDeDb({ companyLocale: 'en' });
    expect(await localeDeContenido(db, EMPRESA, USUARIO)).toBe('en');
  });

  test('sin nada, español', async () => {
    const { db } = dobleDeDb({ userLocale: null });
    expect(await localeDeContenido(db, EMPRESA, USUARIO)).toBe('es');
  });
});
