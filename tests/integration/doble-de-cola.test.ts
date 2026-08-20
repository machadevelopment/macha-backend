import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { crearDobleDeCola } from './doble-de-cola';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * EL DOBLE DE LA COLA TIENE QUE EXPORTAR LO MISMO QUE LA COLA
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══ POR QUÉ ESTE TEST EXISTE ═══
 *
 * `mock.module` de Bun es global al proceso y la suite de integración corre en una sola
 * invocación de `bun test`: el doble de `@/queue` aplica a TODOS los archivos, y si falta un
 * export, cualquier módulo que lo importe muere con
 *
 *     SyntaxError: Export named 'RETRY_POLICY' not found in module 'src/queue/index.ts'
 *
 * Eso ya pasó (2026-08-20, al agregar `conceptos-del-cliente.test.ts`), y lo peor no fue el
 * error sino DÓNDE apareció: **en CI y no en local**, porque el orden de carga de archivos no
 * es el mismo y el último doble que se registra gana. Un fallo que no se reproduce en la
 * máquina donde se escribe el código cuesta una vuelta completa de CI por intento.
 *
 * Este test lo mueve de "CI lo descubre" a "el gate local lo dice". No prueba comportamiento:
 * prueba una invariante estructural que nada más vigila.
 *
 * ═══ POR QUÉ SE LEE EL TEXTO Y NO SE IMPORTA EL MÓDULO ═══
 *
 * Importar `@/queue` ejecuta `export const boss = new PgBoss(...)`, que construye el cliente
 * de pg-boss durante los tests. No conecta, pero es un objeto con temporizadores propios que
 * no tiene nada que hacer acá. Es el mismo criterio que `next.config.test.ts` en el frontend:
 * cuando importar la cosa tiene un costo, se valida el texto que la declara.
 */

const FUENTE = readFileSync(new URL('../../src/queue/index.ts', import.meta.url), 'utf8');

/** Los `export` del módulo real, sacados de su fuente. Los tipos no cuentan: no existen en runtime. */
function exportsDeLaColaReal(): string[] {
  const nombres = new Set<string>();
  for (const m of FUENTE.matchAll(/^export\s+(?:async\s+)?(?:const|function|class)\s+(\w+)/gm)) {
    nombres.add(m[1]!);
  }
  return [...nombres].sort();
}

describe('el doble de `@/queue` no puede quedarse corto', () => {
  test('exporta todo lo que exporta el módulo real', () => {
    /*
     * Si esto falla, alguien agregó un export a `src/queue/index.ts` y el doble no lo tiene.
     * El síntoma en la suite NO va a mencionar este archivo: va a ser un `SyntaxError` de
     * importación en el primer test que monte un módulo que lo use. Agregarlo a
     * `doble-de-cola.ts` es el arreglo.
     */
    const { modulo } = crearDobleDeCola();
    const reales = exportsDeLaColaReal();
    const delDoble = Object.keys(modulo);

    expect(reales.length).toBeGreaterThan(0); // guardia: si el regex deja de casar, esto avisa
    expect(delDoble.sort()).toEqual(expect.arrayContaining(reales));
  });

  test('ningún archivo de la suite arma su propio doble de la cola', () => {
    /*
     * La otra mitad, y la que de verdad se rompió: tener un doble completo no sirve si un
     * archivo registra el suyo al lado. Como el último en cargarse gana, un doble local
     * incompleto vuelve a poner exactamente el mismo fallo — y sigue pasando en local.
     *
     * Se permite `mock.module('@/queue', ...)` SOLO si el objeto sale del doble compartido
     * (`dobleDeCola.modulo`), que es lo que garantiza la superficie completa.
     */

    const dir = new URL('.', import.meta.url);
    const culpables: string[] = [];

    for (const archivo of readdirSync(dir)) {
      if (!archivo.endsWith('.test.ts')) continue;
      // Este archivo se saltea porque contiene el literal que busca: se acusaría a sí mismo.
      // Es la única exclusión, y es por el texto del chequeo, no por una excepción de regla.
      if (archivo === 'doble-de-cola.test.ts') continue;
      const texto = readFileSync(new URL(archivo, dir), 'utf8');
      const i = texto.indexOf("mock.module('@/queue'");
      if (i === -1) continue;

      /*
       * Se exige el SPREAD del doble compartido —o que la fábrica lo devuelva tal cual—, no la
       * simple mención de `dobleDeCola.modulo` en algún lado.
       *
       * La primera versión de este chequeo buscaba la mención, y no atrapaba nada: un archivo
       * puede armar su propio objeto incompleto Y usar `dobleDeCola.modulo.registerWorker`
       * dentro de un override, que es exactamente la forma en que estos archivos están
       * escritos. Comprobado por mutación: la versión laxa pasaba.
       */
      const ventana = texto.slice(i, i + 200);
      const usaElCompartido =
        ventana.includes('...dobleDeCola.modulo') || ventana.includes('=> dobleDeCola.modulo');
      if (!usaElCompartido) culpables.push(archivo);
    }

    expect(culpables).toEqual([]);
  });
});
