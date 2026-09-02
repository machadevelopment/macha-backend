/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * A QUÉ PANTALLAS LLEGA CADA HOJA (reporte de Jose, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"La data no va únicamente al dashboard: cargamos un Excel y esa data viaja tanto al
 * dashboard como a las otras secciones que tenemos… si ponemos solo los del dashboard y el
 * campo va a cuentas por pagar, no lo estamos registrando."*
 *
 * Tiene razón, y el hueco es exactamente ese. El portón (migración 0042) le enseña al dueño el
 * DINERO de cada hoja y con qué TIPO entró —ingreso, costo, gasto—, que son los rubros del
 * dashboard. Pero una fila también puede aterrizar en `invoices` (Por cobrar), en `bills` (Por
 * pagar), en el inventario o en Ventas por producto, y de eso la pantalla no decía nada. El
 * dueño aprobaba su archivo mirando una parte de lo que ese archivo hace.
 *
 * Y no hace falta inventar nada: **el destino ya está determinado en la fila de staging**. Lo
 * único que faltaba era decirlo.
 *
 *   · `targetEntity` decide la tabla: `transaction` → dashboard y flujo de caja, `invoice` →
 *     Por cobrar, `bill` → Por pagar.
 *   · `type` decide el rubro del dashboard (`revenue` → Ingresos, `cogs`/`opex` → Costos).
 *   · `product` decide si la fila alimenta Ventas por producto.
 *
 * ═══ POR QUÉ VIVE ACÁ Y NO EN EL HANDLER ═══
 *
 * Porque la misma pregunta la hacen DOS lados —el portón, que la muestra antes de publicar, y
 * el resumen de lectura, que la explica después— y este repo ya pagó varias veces la lección de
 * las dos copias que se separan (`esArreglablePorCategoria`, `cumpleFirma`, `mesPorNombre`). Si
 * el portón dijera "esto va a Por pagar" y la otra pantalla no, el cliente dejaría de creerle a
 * las dos.
 *
 * ⚠️ NO se derivan destinos de la ENTIDAD sola cuando el tipo los precisa. Una `bill` va a Por
 * pagar **y** a Costos, porque desde el 2026-08-30 una factura recibida produce su costo; una
 * `invoice` va a Por cobrar **y** a Ingresos, porque emitirla devenga. Listar solo la cuenta
 * escondería justamente la mitad que el cliente ve en su dashboard.
 */

/** Las pantallas del producto, con el nombre que el cliente lee en el menú. */
export type Destino =
  /** Panorama y Analítica: ingresos del período. */
  | 'ingresos'
  /** Panorama y Analítica: costo de ventas y gastos operativos. */
  | 'costos'
  /** Analítica → Por cobrar. */
  | 'porCobrar'
  /** Analítica → Por pagar. */
  | 'porPagar'
  /** Ventas por producto. */
  | 'productos'
  /** Inventario. */
  | 'inventario'
  /**
   * Entró al ledger pero ninguna pantalla lo suma.
   *
   * ⚠️ Es el caso de `type: 'other'`, y decirlo es el punto: `rollups.ts` suma `revenue`,
   * `cogs` y `opex`, así que una fila `other` se guarda y **no aparece en ninguna cifra**. Jose
   * preguntó por escrito dónde caía eso ("¿y si fuera otro movimiento, en dónde lo registra?")
   * y la respuesta honesta es "en ningún lado que se vea". Mostrarlo en el portón es lo que le
   * permite corregirlo ANTES de publicar en vez de descubrirlo por una cifra que no cuadra.
   */
  | 'sinPantalla';

/**
 * A qué pantallas llega una fila de staging.
 *
 * Devuelve un conjunto porque una sola fila llega a varias: una factura emitida es a la vez
 * ingreso del período y cuenta por cobrar.
 */
export function destinosDeLaFila(fila: {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  payload: Record<string, unknown>;
}): Destino[] {
  const out = new Set<Destino>();
  const tipo = typeof fila.payload.type === 'string' ? fila.payload.type : null;

  if (fila.targetEntity === 'invoice') out.add('porCobrar');
  if (fila.targetEntity === 'bill') out.add('porPagar');

  /*
   * El rubro del dashboard. Va para las tres entidades y no solo para `transaction`: la
   * factura emitida devenga su ingreso y la recibida produce su costo, así que las dos
   * aparecen en el estado de resultados además de en su cuenta.
   */
  if (tipo === 'revenue') out.add('ingresos');
  if (tipo === 'cogs' || tipo === 'opex') out.add('costos');

  /*
   * `other` entra al ledger y NO lo suma ninguna pantalla. Se dice explícitamente en vez de
   * omitirlo: una hoja sin destino visible es lo que el dueño necesita ver antes de publicar.
   */
  if (tipo === 'other') out.add('sinPantalla');

  /*
   * Ventas por producto agrupa por `product` sobre los ingresos. Una compra con producto no
   * aparece ahí, así que se exige el ingreso además de la columna.
   */
  const producto = fila.payload.product;
  if (out.has('ingresos') && typeof producto === 'string' && producto.trim() !== '') {
    out.add('productos');
  }

  return [...out];
}

/** Los destinos de una hoja entera: la unión de los de sus filas. */
export function destinosDeLaHoja(
  filas: { targetEntity: 'transaction' | 'invoice' | 'bill'; payload: Record<string, unknown> }[],
): Destino[] {
  const out = new Set<Destino>();
  for (const f of filas) for (const d of destinosDeLaFila(f)) out.add(d);
  return [...out];
}
