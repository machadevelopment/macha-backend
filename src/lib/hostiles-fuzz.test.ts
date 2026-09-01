import { describe, expect, test } from 'bun:test';
import { generarLibro, opcionesDeSemilla } from './hostiles/fuzz';
import { correrPipeline } from './hostiles/pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TRESCIENTOS LIBROS GENERADOS, CONTRA LAS TRES CIFRAS DEL DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Los libros escritos a mano cubren los casos que YA conocemos. Este cubre los que no: los
 * fallos de esta ingesta no viven en un filtro sino en la COMBINACIÓN de doce filtros por cada
 * forma de libro posible, y ese espacio no se escribe a mano.
 *
 * ═══ LO QUE ENCONTRÓ LA PRIMERA CORRIDA (2026-08-31) ═══
 *
 * De 200 libros, 120 daban una cifra equivocada. Tres defectos, todos PREEXISTENTES, todos
 * pérdidas o duplicaciones silenciosas, y ninguno reportado nunca por un cliente:
 *
 *   1. **Una fecha escrita como TEXTO se usaba de clave foránea** (`sheet-relations`). Dos
 *      hojas del mismo período se "referenciaban" por su columna de fecha, el esquema del libro
 *      creía que una repetía un hecho ya contado, y `ventaYaRegistradaEnOtraHoja` **suprimía la
 *      hoja entera**. Es el bug de U3TECH (cero ingresos con la facturación bien leída) por
 *      otra puerta. Arreglado: 80 → 162 libros exactos con un solo cambio.
 *   2. **La misma ceguera en el dedup** (`sheet-duplication`): `aNumero` convierte `01/04/2026`
 *      en 1042026, así que dos hojas del mismo período sumaban ~14 M cada una y quedaban dentro
 *      del 1 %. Una se descartaba con todo su dinero.
 *   3. **Columnas de IDENTIFICADOR contadas como dinero** en el mismo dedup: `FAC-1000` valía
 *      mil. Con cinco columnas espurias por hoja, un empate del 1 % por azar deja de ser raro,
 *      y el precio del empate es descartar una hoja entera.
 *
 * Ninguno de los doce libros escritos a mano los tocaba. El acantilado de
 * `MIN_VALORES_PARA_RELACION` —una hoja de seis cobros duplicando el 45 % del ingreso— salió
 * de variar UN parámetro: la cantidad de filas.
 *
 * ═══ POR QUÉ 300 Y CON SEMILLA FIJA ═══
 *
 * Con semilla fija el test es reproducible: un fallo se reproduce con `generarLibro(N)` y se
 * pega tal cual en un test de regresión. Un fuzzer con `Math.random()` es un test que falla en
 * CI y pasa en tu máquina. 300 libros corren en menos de un segundo, así que no hay razón para
 * mirar menos.
 */

const SEMILLAS = 300;

/**
 * ⚠️ EL ÚNICO HUECO QUE QUEDA, MEDIDO Y NO CERRADO.
 *
 * Un libro con su propio consolidado mensual de MENOS de 6 meses vuelve a contar su ingreso: la
 * señal que reconoce un resumen por período (`sheet-shape`, señal 6-bis) exige **6 meses
 * distintos**, y el dedup cabecera/detalle exige 8 filas. Con cuatro meses no lo ve ninguno.
 *
 * No se baja el umbral y la decisión está razonada en `sheet-shape`: *"el umbral de seis meses
 * distintos sigue protegiendo el otro lado — una hoja de cinco filas no se toca"*. Aflojarlo
 * haría que una hoja de tres movimientos con fechas el día 1 y sin columna de texto se
 * descartara entera, y perder contabilidad en silencio es peor que mostrar de más, que al menos
 * se ve. Medido además: bajar el piso del dedup de 8 a 4 **no arregla ninguno** de estos libros,
 * así que no hay ahí una salida barata.
 *
 * Se excluye de la aserción exacta y se afirma aparte, para que el hueco quede VISIBLE en vez
 * de invisible. Si algún día deja de fallar, este bloque se borra.
 */
const tieneElHuecoConocido = (semilla: number): boolean => {
  const o = opcionesDeSemilla(semilla);
  return o.resumenPropio && o.filasVentas < 6;
};

describe('libros generados: el dashboard muestra lo que trae el archivo', () => {
  const exactos: number[] = [];
  const conHueco: number[] = [];
  const rotos: { semilla: number; delta: string; destino: string; opciones: string }[] = [];

  for (let semilla = 1; semilla <= SEMILLAS; semilla++) {
    const libro = generarLibro(semilla);
    const c = correrPipeline(libro);
    const delta = (['revenue', 'cogs', 'opex'] as const)
      .map((k) => [k, Math.round((c.totales[k] - libro.verdad[k]) * 100) / 100] as const)
      .filter(([, d]) => Math.abs(d) > 0.01);

    if (delta.length === 0) exactos.push(semilla);
    else if (tieneElHuecoConocido(semilla)) conHueco.push(semilla);
    else
      rotos.push({
        semilla,
        delta: delta.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${d}`).join(' · '),
        destino: [...c.destino].map(([h, d]) => `${h}=${d}`).join(' | '),
        opciones: libro.rompe,
      });
  }

  test('ningún libro pierde ni inventa dinero, salvo el hueco conocido', () => {
    /*
     * El mensaje del fallo trae la SEMILLA, el delta, a dónde fue cada hoja y las opciones del
     * libro. Es lo que convierte "el fuzzer está en rojo" en "reproducilo con
     * `generarLibro(147)`" — sin eso, un fuzzer es un test que nadie puede arreglar.
     */
    expect(
      rotos.length === 0
        ? 'sin libros rotos'
        : rotos
            .map((r) => `\n  semilla ${r.semilla}: ${r.delta}\n    ${r.destino}\n    ${r.opciones}`)
            .join(''),
    ).toBe('sin libros rotos');
  });

  /*
   * ⚠️ EL HUECO SE MIDIÓ EN PRODUCCIÓN, no solo acá (2026-09-01). El libro de la semilla 131,
   * subido por la aplicación real, dejó el dashboard con **+945,00 de ingreso sobre una verdad
   * de campo de 34.209,00** (+2,8 %) — con el costo y los gastos EXACTOS. `Ventas` (5 filas,
   * GTQ 945) y su propio `Resumen_Mensual` (5 filas, GTQ 945) se procesaron las dos.
   *
   * Y los DOS arreglos naturales tienen contraejemplo, comprobado el mismo día:
   *
   *  · Bajar `MIN_FILAS_PARA_AFIRMAR` cuando los totales empatan AL CENTAVO pone en rojo un
   *    test que ya existe en `sheet-duplication.test.ts`: `Ventas` (1000+2000+3000) y `Gastos`
   *    (1500+2500+2000) suman 6000 las dos, con tres filas cada una y compartiendo la llave
   *    `Documento`. Son dos hojas distintas que empatan exacto por azar — con cifras redondas
   *    eso pasa.
   *  · Exigir además que solo UNA de las dos se baste sola tampoco separa ese par: la hoja de
   *    gastos de una PYME no nombra proveedor y es una hoja de movimientos igual, que es lo
   *    que `pareceLibroDeMovimientos` ya advierte por escrito.
   *
   * Sigue sin aflojarse, y el criterio no cambia: mostrar de más se VE y el cliente lo
   * desmiente; perder su contabilidad en silencio, no. El camino cuando aparezca un archivo
   * real así es COMBINAR dos señales débiles —forma de período Y empate exacto con otra hoja
   * del mismo libro—, no bajar un umbral.
   */
  test('el hueco conocido es SOLO el del consolidado de menos de 6 meses', () => {
    // Si esto cae, apareció una segunda causa y hay que investigarla en vez de ensancharlo.
    expect(exactos.length + conHueco.length).toBe(SEMILLAS);
    // Y sigue siendo una minoría: si creciera, el hueco dejó de ser un caso de borde.
    expect(conHueco.length).toBeLessThan(SEMILLAS * 0.1);
  });
});
