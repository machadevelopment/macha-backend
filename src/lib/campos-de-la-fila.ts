/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TODOS LOS CAMPOS DE LA FILA, NO SOLO LOS DEL DASHBOARD (reporte de Jose, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"En analítica tenemos ingresos, flujo de caja, costos, por cobrar y por pagar. Entonces ahí
 * tenemos OTROS CAMPOS. Luego tenemos ventas por producto y luego tenemos inventario… no solo
 * los campos del dashboard, sino los campos de analítica y los campos de inventario. Los campos
 * realmente cabal son los campos que vos ya tenés en la base de datos, o sea que sólo con
 * agregarlos ahí deberíamos estar check."*
 *
 * El portón mostraba **seis campos elegidos a mano** —fecha, concepto, monto, moneda, tipo y
 * categoría— que son exactamente los que alimentan el estado de resultados. El pipeline extrae
 * once, y los cinco que faltaban son los que mandan en las OTRAS pantallas:
 *
 *   · `dueDate` — decide el TRAMO DE ANTIGÜEDAD en Por cobrar y Por pagar (corriente, 1-30,
 *     31-60, 61-90, 90+). Es el campo que define cómo se ve esa pantalla y el portón no lo
 *     enseñaba **en absoluto**: mostraba la fecha de emisión y ya. Un vencimiento mal leído
 *     manda toda la cartera al tramo equivocado sin cambiar un solo total.
 *   · `counterparty` — quién debe o a quién se le debe, la columna con la que se lee esa misma
 *     pantalla. Se mostraba colapsado dentro de "concepto" y solo si no había descripción.
 *   · `product` y `productCategory` — Ventas por producto. Mismo colapso.
 *   · `quantity` y `store` — Inventario y Ventas por tienda.
 *
 * ═══ SE DEVUELVEN LOS QUE LA FILA TRAE, NO UNA LISTA FIJA ═══
 *
 * Un campo ausente NO se muestra: una hoja de gastos no tiene producto ni tienda, y pintar seis
 * renglones vacíos convierte la pantalla en ruido — que es justo lo que hace que el dueño deje
 * de leerla. Lo que la hoja trae es lo que hay que revisar.
 *
 * Los nombres son los del CLIENTE y no los del esquema, por la misma razón que
 * `read-summary.NOMBRE_DE_CAMPO`: `counterparty` no significa nada para quien lleva la
 * contabilidad de una cafetería, y esta pantalla existe para que ÉL pueda desmentirnos.
 */

/** Un campo con valor, listo para pintar. El orden de la lista es el orden en pantalla. */
export interface CampoDeLaFila {
  /** Clave estable, para que la pantalla traduzca. */
  clave: string;
  /** El valor tal como quedó, ya en texto. */
  valor: string;
}

/**
 * El ORDEN es el de lectura de una fila contable: cuándo, quién, qué, cuánto.
 *
 * `dueDate` va inmediatamente después de la fecha de emisión y no al final: son las dos fechas
 * de la misma fila y el sentido de la segunda se pierde lejos de la primera.
 */
const ORDEN: { campo: string; clave: string }[] = [
  { campo: 'date', clave: 'fecha' },
  { campo: 'issueDate', clave: 'emision' },
  { campo: 'dueDate', clave: 'vencimiento' },
  { campo: 'counterparty', clave: 'contraparte' },
  { campo: 'description', clave: 'descripcion' },
  { campo: 'product', clave: 'producto' },
  { campo: 'productCategory', clave: 'categoriaProducto' },
  { campo: 'quantity', clave: 'cantidad' },
  { campo: 'store', clave: 'tienda' },
];

/**
 * Los campos con valor de una fila de staging, en orden de lectura.
 *
 * NO incluye monto, moneda, tipo ni categoría: esos ya los pinta la pantalla aparte y con
 * formato propio (el monto va con su moneda, el tipo es un control que se puede cambiar).
 * Duplicarlos acá los mostraría dos veces.
 */
export function camposDeLaFila(payload: Record<string, unknown>): CampoDeLaFila[] {
  const out: CampoDeLaFila[] = [];
  for (const { campo, clave } of ORDEN) {
    const v = payload[campo];
    if (v === null || v === undefined || v === '') continue;
    out.push({ clave, valor: String(v) });
  }
  return out;
}
