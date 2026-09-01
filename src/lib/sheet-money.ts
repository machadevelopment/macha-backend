import { normalizeHeader, MONEY_HINTS } from './sheet-classifier';
import { asNumber, type ColumnMap } from './row-assembly';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CUÁNTO DINERO HAY EN UNA HOJA QUE EL MODELO NUNCA VIO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `medirFilas` (lib/reconciliation.ts) mide el dinero de una hoja usando el mapa de columnas
 * que devolvió el modelo. Eso deja fuera, por construcción, a **todas las hojas que se
 * descartan antes de llegar al modelo** — que es justamente donde han estado casi todos los
 * fallos de esta casa.
 *
 * ═══ EL AGUJERO, MEDIDO ═══
 *
 * Los cinco puntos donde el worker descarta una hoja registran `filas: rows.length` y **ninguno
 * registra el monto**. O sea que el sistema podía decir "descarté 220 filas" y no podía decir
 * "descarté Q 2.707.318". Cada uno de los bugs de ingesta de los últimos meses fue una
 * exclusión equivocada o una inclusión equivocada, y **el dinero es lo que las hace evidentes**:
 *
 *   · KapePrueba — se descartaron `Ventas` (481 filas) y `Compras` (43) para conservar un
 *     resumen de 11. En filas se ve como "descarté dos hojas". En dinero se ve como
 *     "descarté Q 524.000 de movimientos reales", que nadie deja pasar.
 *   · CarsGT — 260 vehículos en stock entraron como costo. Q 16 M.
 *   · La matriz de gastos de una PYME descartada por forma. Q 75.465,90 — el único gasto
 *     operativo que ese cliente tenía.
 *
 * Con la cifra al lado, la decisión deja de ser invisible: aparece en "Ver qué entendimos de tu
 * archivo" y el dueño la desmiente en dos segundos, que es el verificador más barato que hay.
 *
 * ═══ ESTO ES UNA ESTIMACIÓN Y NO PUEDE ALIMENTAR EL LEDGER ═══
 *
 * ⚠️ El valor que sale de acá **no construye ni un solo payload**. Es un número para EXPLICAR
 * y para RANQUEAR el riesgo de una decisión, nunca para contabilizar. La diferencia importa:
 * el mapa del modelo se verifica contra sí mismo entre lotes (`assertMismoMapa`) y se le exige
 * coherencia; esto es una heurística sobre encabezados y magnitudes que puede elegir la columna
 * de al lado. Para decir "esta hoja descartada traía del orden de Q 2,7 M" alcanza y sobra;
 * para sumar al dashboard, no.
 *
 * Por eso las hojas que SÍ producen movimientos se siguen midiendo con `medirFilas` y el mapa
 * real. Esto cubre exactamente el hueco: las que nunca tuvieron mapa.
 */

/**
 * Rango de plausibilidad de un serial de fecha de Excel — el mismo de `row-assembly`,
 * `sheet-duplication` y `sheet-relations`.
 *
 * Sin esto, una columna de fechas es la que más "dinero" tiene de toda la hoja: sesenta
 * seriales de ~46.000 suman más que la columna de montos de su propia hoja.
 */
const ES_SERIAL_DE_FECHA = (n: number): boolean => n >= 32_874 && n <= 73_415;

/**
 * Debajo de esto una columna numérica no es dinero.
 *
 * Un porcentaje (`0,1`), un margen (`0,72`) y una cantidad chica viven acá abajo. No se trata
 * de acertar siempre: se trata de no reportar "esta hoja traía Q 12" cuando lo que tenía era
 * una columna de descuentos.
 */
const MAGNITUD_MINIMA = 1;

/** Cuántas de las celdas de una columna tienen que ser números para considerarla numérica. */
const COBERTURA_NUMERICA = 0.6;

const mediana = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * Elige la columna de dinero más probable de una hoja, y la de moneda si la hay.
 *
 * ═══ EL ORDEN DE LOS CRITERIOS ES LA DECISIÓN ═══
 *
 * 1. **Vocabulario primero.** Si algún encabezado dice `Total`, `Monto`, `Importe`, esa es la
 *    columna: el que escribió el archivo ya contestó la pregunta. Se reutiliza la MISMA lista
 *    que usa `classifySheet` para decidir si una hoja es financiera — dos listas de dinero que
 *    se separan producirían una hoja que se clasifica por una y se mide por la otra.
 * 2. **Magnitud como desempate**, no como criterio principal. Entre `Precio Unitario` y
 *    `Total Línea` gana la de valores más grandes, que es la del documento completo. Un archivo
 *    real trae las dos y elegir la chica subestima la hoja entera.
 * 3. **Sin vocabulario, la magnitud sola**, con el piso de arriba. Es el caso de una hoja de
 *    columnas mal nombradas, que es exactamente el tipo de archivo que llega.
 *
 * Devuelve un `ColumnMap` PARCIAL (solo `amount` y `currency`) para poder pasárselo a
 * `medirFilas` sin duplicar la lógica de acumulación por moneda. Los demás campos van en
 * `null` a propósito: acá no se arma ninguna fila.
 */
/**
 * Columnas que traen NÚMEROS y no son dinero. Ver el bloque de arriba: con el portón, esta
 * estimación se le muestra al cliente, así que sumar su columna de teléfonos no es un detalle.
 *
 * La lista es corta y cerrada a propósito, como la de agregados de `sheet-unpivot`: la forma de
 * titular un identificador en una hoja contable son seis palabras. NO incluye `total` ni
 * `monto` por razones obvias, ni `numero` a secas — "Número de factura" es identificador pero
 * "Número de unidades" no, y el que decide es el sufijo, no el prefijo.
 */
const ES_IDENTIFICADOR = [
  'telefono', 'celular', 'movil', 'phone', 'nit', 'dpi', 'cui', 'rtu',
  'codigopostal', 'zipcode', 'cuenta bancaria', 'cuentabancaria',
]; // prettier-ignore

export function mapaDeDineroProbable(rows: unknown[][]): ColumnMap {
  const vacio: ColumnMap = {
    date: null, amount: null, currency: null, description: null, counterparty: null,
    product: null, quantity: null, productCategory: null, store: null, dueDate: null,
    costTotal: null, costUnit: null,
  }; // prettier-ignore

  const header = rows[0] ?? [];
  const datos = rows.slice(1);
  if (datos.length === 0) return vacio;

  const ancho = Math.max(header.length, ...datos.map((f) => f.length));
  const encabezados = header.map((h) => normalizeHeader(h));

  let moneda: number | null = null;
  for (let c = 0; c < ancho; c++) {
    const h = encabezados[c];
    if (h === 'moneda' || h === 'divisa' || h === 'currency') {
      moneda = c;
      break;
    }
  }

  const candidatos: { indice: number; magnitud: number; porVocabulario: boolean }[] = [];
  for (let c = 0; c < ancho; c++) {
    if (c === moneda) continue;
    const numeros: number[] = [];
    let presentes = 0;
    for (const f of datos) {
      const v = f[c];
      if (v === null || v === undefined || v === '') continue;
      presentes++;
      const n = asNumber(v);
      if (n === null || !Number.isFinite(n)) continue;
      if (ES_SERIAL_DE_FECHA(n)) continue;
      numeros.push(Math.abs(n));
    }
    if (presentes === 0 || numeros.length < presentes * COBERTURA_NUMERICA) continue;

    const m = mediana(numeros);
    if (m < MAGNITUD_MINIMA) continue;

    const h = encabezados[c] ?? '';
    /*
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * UN TELÉFONO NO ES PLATA, Y AHORA EL CLIENTE LO VE (2026-09-01)
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * Esta estimación no alimenta el ledger —explica y ranquea— así que un desatino costaba
     * poco. Con el PORTÓN (migración 0042) pasó a mostrarse en la pantalla donde el dueño
     * decide si publica su contabilidad, y ahí cambia todo: verificado en producción, la hoja
     * `Clientes_B2B` descartada declaraba **GTQ 306.000.081,00**, que es la suma de la columna
     * de TELÉFONOS. Un cliente que lee eso deja de creerle a la pantalla entera — y esa
     * pantalla es la única herramienta que tiene para desmentirnos.
     *
     * El veto es por VOCABULARIO de identificador y no por magnitud: un teléfono guatemalteco
     * (8 dígitos) y un monto grande son indistinguibles por el número, y poner un techo
     * arbitrario recortaría la factura legítima de una constructora. Lo que sí los separa es
     * cómo se llama la columna — nadie titula "Teléfono" a una columna de dinero.
     *
     * `nit` y `telefono` ya viven en la firma `contactos` de `sheet-classifier` por la misma
     * razón: son cómo se FICHA a una contraparte, no cómo se registra un hecho.
     */
    if (ES_IDENTIFICADOR.some((p) => h.includes(p))) continue;

    candidatos.push({
      indice: c,
      magnitud: m,
      // `includes` y no igualdad: los encabezados reales dicen "Total Línea (Q)" y
      // `normalizeHeader` deja "totallineaq". La lista es la del clasificador.
      porVocabulario: MONEY_HINTS.some((p) => h.includes(p)),
    });
  }

  if (candidatos.length === 0) return { ...vacio, currency: moneda };

  const conVocabulario = candidatos.filter((c) => c.porVocabulario);
  const pool = conVocabulario.length > 0 ? conVocabulario : candidatos;
  const elegida = pool.reduce((a, b) => (b.magnitud > a.magnitud ? b : a));

  return { ...vacio, amount: elegida.indice, currency: moneda };
}
