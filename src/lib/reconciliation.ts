import { asNumber, costoDeLaFila, type ColumnMap } from './row-assembly';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CUÁNTO DINERO TRAÍA EL ARCHIVO — LA CIFRA QUE EL CLIENTE PUEDE DESMENTIR
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El pipeline verifica muchísimo sobre CÓMO lee cada fila —cobertura, desplazamiento de
 * índices, mapa único por hoja, reglas de staging— y nada sobre el RESULTADO agregado. Nadie
 * compara "esto es lo que decía tu archivo" contra "esto es lo que quedó". Esa comparación
 * hoy la hace un humano, a mano, cuando un cliente se queja.
 *
 * ═══ POR QUÉ ES ESTO Y NO UN CUADRE AUTOMÁTICO ═══
 *
 * La tentación es afirmar `dinero del archivo == dinero promovido` y frenar la carga si no
 * cierra. No se puede, y el motivo es de diseño y no de implementación: **una fila del archivo
 * produce legítimamente MÁS de una fila del ledger**. Una venta con su costo en la misma línea
 * produce dos transacciones (`construirFilas`), y una factura emitida produce su cuenta por
 * cobrar Y su ingreso devengado. Las dos reglas son correctas y están documentadas.
 *
 * Un cuadre ingenuo marcaría cada una de esas cargas como descuadrada. Y un falso positivo que
 * frene la promoción es peor que el problema que viene a resolver: deja al cliente sin su
 * contabilidad por un chequeo que se equivocó. Por eso esta primera versión **mide y reporta,
 * nunca bloquea**. Cuando haya evidencia de producción de que las magnitudes se comportan, se
 * puede endurecer con conocimiento; hacerlo hoy sería adivinar.
 *
 * ═══ LO QUE SÍ RESUELVE, Y ESTÁ MEDIDO ═══
 *
 * El caso que lo motiva es del 2026-08-25. Un cliente subió 19 meses de contabilidad
 * (`Ventas`: 240 filas, Q 38.843.310) y el dashboard abrió en "este mes" (45 filas, Q 7.014.710).
 * Las cifras eran correctas al quetzal, pero contra el archivo no se parecían a nada, y el
 * reporte que llegó fue "esta data no tiene absolutamente nada que ver con el Excel". Se buscó
 * el defecto en la ingesta, en el prompt y en la base durante horas; no había ninguno.
 *
 * Con esta cifra en el resumen de lectura —"leí 240 filas por Q 38.843.310 en Ventas"— esa
 * conversación dura dos segundos, porque el dueño reconoce sus propias ventas. Es el
 * verificador más barato y más confiable que tenemos, y hasta hoy no le preguntábamos nada.
 *
 * ═══ SEPARADO POR MONEDA, SIEMPRE ═══
 *
 * Nunca se suma GTQ con USD. En esta etapa las filas todavía no tienen `amount_base` —la
 * conversión pasa al promover, con la tasa snapshoteada por fila—, así que no hay cifra
 * convertida que sumar y un total mezclado no sería ninguna de las dos monedas. Es la misma
 * regla que ya gobierna la pantalla de conceptos pendientes.
 */

/** Lo que una hoja traía, en la moneda en que lo traía. */
export interface MontoPorMoneda {
  moneda: string;
  /** Suma de la columna de monto sobre las filas enviadas a clasificar. */
  total: number;
  /** Cuántas filas aportaron a ese total (las que traen un monto legible). */
  filas: number;
}

/** Lo que una hoja traía en sus columnas de dinero. */
export interface MedicionDeFilas {
  /** Filas que llegaron a clasificarse. */
  filasEnviadas: number;
  /** Suma de la columna de monto, por moneda. */
  montos: MontoPorMoneda[];
  /**
   * Suma de la columna de COSTO, cuando la hoja la trae aparte.
   *
   * Va separada del monto y no sumada: en un libro de PYME el costo vive en su propia columna
   * de la misma fila (`Costo Vehiculo (Q)` al lado de `Precio Venta (Q)`), y mezclarlos daría
   * un número que no es ni la venta ni el costo. Es además la mitad que explica por qué el
   * ledger tiene más filas que el archivo.
   */
  costos: MontoPorMoneda[];
}

/**
 * La moneda de una fila: la que diga su columna, o la base de la empresa.
 *
 * Se normaliza a mayúsculas porque un archivo real escribe `usd`, `USD` y `Usd` en la misma
 * columna, y tres claves distintas partirían el total de una sola moneda en tres.
 */
function monedaDeLaFila(row: unknown[], columns: ColumnMap, base: string): string {
  if (columns.currency === null) return base;
  const raw = row[columns.currency];
  if (raw === null || raw === undefined) return base;
  const s = String(raw).trim().toUpperCase();
  return s === '' ? base : s;
}

function acumular(destino: Map<string, MontoPorMoneda>, moneda: string, valor: number): void {
  const previo = destino.get(moneda);
  if (previo) {
    previo.total += valor;
    previo.filas += 1;
  } else {
    destino.set(moneda, { moneda, total: valor, filas: 1 });
  }
}

/**
 * Mide lo que la hoja traía, antes de cualquier interpretación.
 *
 * Lee las MISMAS columnas que `assemblePayload` usa para construir las filas (`asNumber`,
 * `costoDeLaFila`), a propósito: si algún día el mapa apunta a la columna equivocada, esta
 * cifra se equivoca junto con el ledger y el cliente ve un total que no reconoce. Una medición
 * que leyera por su cuenta podría cuadrar con el archivo mientras el ledger va por otro lado,
 * que es exactamente el descuadre que no queremos esconder.
 *
 * El monto se toma en VALOR ABSOLUTO por la misma razón que el pipeline lo exige positivo: la
 * dirección la lleva el tipo contable, y un archivo que escribe los gastos en negativo daría
 * un total que se cancela contra sus ingresos.
 */
export function medirFilas(
  batch: unknown[][],
  columns: ColumnMap,
  baseCurrency: string,
): MedicionDeFilas {
  const montos = new Map<string, MontoPorMoneda>();
  const costos = new Map<string, MontoPorMoneda>();

  for (const row of batch) {
    const moneda = monedaDeLaFila(row, columns, baseCurrency);

    if (columns.amount !== null) {
      const monto = asNumber(row[columns.amount]);
      if (monto !== null) acumular(montos, moneda, Math.abs(monto));
    }

    const costo = costoDeLaFila(row, columns);
    if (costo !== null) acumular(costos, moneda, Math.abs(costo));
  }

  return {
    filasEnviadas: batch.length,
    montos: [...montos.values()],
    costos: [...costos.values()],
  };
}
