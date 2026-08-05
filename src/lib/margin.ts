/**
 * CU-868kh8y58 — LA definición de margen del producto. Decisión de Jose, 2026-07-28.
 *
 * El margen de Macha es **margen bruto**: `revenue - cogs`. Ni antes ni después esa
 * fórmula fue otra cosa, pero hasta esta decisión circulaba como *placeholder* en tres
 * archivos distintos: era correcta por accidente, no por acuerdo. Ahora es una regla de
 * negocio, escrita también en `PRD.md` §08.
 *
 * POR QUÉ BRUTO Y NO NETO. El margen neto exige separar con confianza el costo directo
 * de venta del gasto operativo. El corazón de Macha es leer Exceles desordenados de
 * pymes, donde el dueño mete "pago a proveedor" y "alquiler" en la misma columna. Sobre
 * datos así, un neto sería una resta sobre categorías mal separadas: más preciso en
 * apariencia, menos confiable en realidad. El bruto es más honesto con la calidad de
 * datos que vamos a tener. No cierra el neto para siempre — lo saca del MVP; por eso
 * `cogs` y `opex` se guardan separados desde ya.
 *
 * QUÉ ENTRA EN `cogs` (esto define el cálculo, no es un detalle de taxonomía):
 *   · SÍ: costo directo de lo vendido — materia prima, producto para reventa, insumo
 *     que se transforma en el producto vendido.
 *   · NO: alquiler, sueldos administrativos, servicios, mercadeo, comisiones bancarias
 *     ni ningún gasto fijo o de estructura. Todo eso es `opex` y queda FUERA del bruto.
 * De ahí que la ingesta (Módulo 2) tenga que poder clasificar cada fila de costo como
 * directo u operativo: si no distingue las dos, este número no es confiable.
 *
 * POR QUÉ VIVE AQUÍ Y NO EN CADA CONSUMIDOR. El bug que originó el ticket no era "qué
 * margen", era que en la misma pantalla la ganancia restaba gastos y el margen no, y
 * los dos números se contradecían. Tres copias de una resta divergen; una función
 * compartida, no. La consumen: `modules/metrics` (KPI), `lib/reports`
 * (computeReportMetrics) y `lib/alerts` (regla `margin_drop`).
 */

/** Utilidad bruta en moneda base: la cifra grande que acompaña al porcentaje. */
export function grossProfit(revenue: number, cogs: number): number {
  return revenue - cogs;
}

/**
 * Margen bruto como PORCENTAJE (0-100), o `null` cuando no existe.
 *
 * `null` y no 0 con `revenue === 0`: un período sin ventas no tiene margen "del 0%",
 * no tiene margen. Devolver 0 haría que la alerta `margin_drop` (umbral 25%) se
 * disparara todos los meses en que una empresa no facturó, que es justo cuando el dueño
 * menos necesita ruido. Cada consumidor decide qué hacer con el `null`.
 */
export function grossMarginPct(revenue: number, cogs: number): number | null {
  if (revenue === 0) return null;
  return (grossProfit(revenue, cogs) / revenue) * 100;
}
