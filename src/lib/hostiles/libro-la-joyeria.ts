import { dobleDeModelo, serial, type LibroHostil, type Verdad } from './pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA JOYERÍA: EL TOTAL QUE SE CONTABA COMO UN MOVIMIENTO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Reproduce la forma de `Jewelry_Store_Template11.xlsx`, un archivo real de cliente que llegó
 * el 2026-09-03 con un reporte de una línea: *"en el primer Excel me dice que son 140 pero en
 * la web me salía 280"*. Las CINCO hojas de dinero mostraban ×2 EXACTO en el portón.
 *
 * Es una plantilla EN INGLÉS y bien hecha —nada de typos ni columnas corridas— y ahí está lo
 * que la hace valiosa como caso: los libros hostiles que ya existen son desprolijos, y éste no
 * lo es. Su trampa es de FORMA, y de la forma más común que hay.
 *
 * ═══ LAS DOS TRAMPAS, Y LAS DOS SON EL MISMO ×2 ═══
 *
 * 1. **El renglón de TOTAL, con el rótulo alineado a la derecha.** Así es como una persona lo
 *    escribe en Excel: pegado a la cifra, con todo lo de la izquierda en blanco. Un total es
 *    por definición la suma de las filas de arriba, así que medirlo reporta el doble. Y el
 *    rótulo va en PLURAL INGLÉS (`TOTALS`), que era invisible para el filtro — el plural que
 *    estaba escrito era `totales`, el español.
 *
 * 2. **El consolidado al final de la misma hoja.** `EXPENSES BY CATEGORY` con su propio título
 *    y su propio encabezado, sumando exactamente lo mismo que el detalle. Acá va ALINEADO bajo
 *    la columna de montos, que es la variante peligrosa: en el archivo original sus cifras
 *    caían en otra columna y no llegaba a duplicar por casualidad.
 *
 * ═══ POR QUÉ EL DAÑO ERA DEL PORTÓN Y NO DEL DASHBOARD ═══
 *
 * El renglón de total no trae fecha, así que `staging-rules` lo marca `invalid_date` y nunca
 * llega al ledger. Lo que estaba mal era la cifra que el portón (migración 0042) le enseña al
 * dueño **antes de publicar** — o sea la única herramienta que tiene para desmentirnos. Por
 * eso este libro declara `verdad` (lo que aterriza) y su `rompe` nombra la otra mitad: las dos
 * se verifican, y son distintas.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

function contador() {
  const v: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  return { v, mas: (k: keyof Verdad, n: number) => (v[k] = r2(v[k] + n)) };
}

export function libroLaJoyeria(): LibroHostil {
  const { v, mas } = contador();

  /* ── Ventas: el rótulo del total en la columna 7 de nueve ──────────────────────────────── */
  const ventas: unknown[][] = [
    ['Order #', 'Order Date', 'Cust. ID', 'Customer Name', 'SKU', 'Item Name', 'Qty', 'Unit Price', 'Total'],
  ]; // prettier-ignore
  let totalVentas = 0;
  for (let i = 0; i < 24; i++) {
    const precio = [440, 130, 950, 275, 1850][i % 5]!;
    const total = precio;
    totalVentas = r2(totalVentas + total);
    mas('revenue', total);
    ventas.push([
      `SO-${2001 + i}`,
      serial(`2026-0${(i % 8) + 1}-${String(3 + (i % 24)).padStart(2, '0')}`),
      `CU-00${(i % 5) + 1}`,
      ['Corporate Gifts LLC', 'James Whitfield', 'Sarah Chen'][i % 3],
      `JW-10${String(13 - (i % 9)).padStart(2, '0')}`,
      ['Rose Gold Bangle', 'Charm Bracelet', 'Solitaire Diamond Ring'][i % 3],
      1,
      precio,
      total,
    ]);
  }
  // ⚠️ Siete celdas vacías antes del rótulo. Con `fila[0]` esto daba `false`.
  ventas.push(['', '', '', '', '', '', '', 'TOTAL SALES', totalVentas]);
  // Y el pie de página de la plantilla, que compite con el encabezado.
  ventas.push(['Type Order #, Date, Customer ID, SKU, Qty. The rest fills in automatically.']);

  /* ── Cartera: el rótulo en PLURAL INGLÉS ───────────────────────────────────────────────── */
  const cartera: unknown[][] = [
    ['Invoice #', 'Cust. ID', 'Invoice Date', 'Due Date', 'Invoice Amount', 'Amount Paid', 'Balance Due'],
  ]; // prettier-ignore
  let totalCartera = 0;
  let totalPagado = 0;
  for (let i = 0; i < 14; i++) {
    const monto = 440 + i * 55;
    const pagado = i < 9 ? monto : 0;
    totalCartera = r2(totalCartera + monto);
    totalPagado = r2(totalPagado + pagado);
    /*
     * La cartera DEVENGA su ingreso además de crear la cuenta por cobrar (regla del
     * 2026-08-19). Sus clientes y sus importes son propios —no son las mismas ventas de
     * `Sales Orders`— así que acá el devengo es legítimo y suma. Escribirlo de otro modo
     * metería en este libro el debate del doble conteo entre facturación y ventas, que es un
     * tema aparte y no es lo que vino a medir.
     */
    mas('revenue', monto);
    cartera.push([
      `INV-${6001 + i}`,
      `CU-00${(i % 5) + 1}`,
      serial(`2026-0${(i % 7) + 1}-${String(2 + (i % 22)).padStart(2, '0')}`),
      serial(`2026-0${(i % 7) + 2}-${String(2 + (i % 22)).padStart(2, '0')}`),
      monto,
      pagado,
      r2(monto - pagado),
    ]);
  }
  /*
   * ⚠️ `TOTALS`, no `TOTAL`. El regex tenía `totales` —el plural ESPAÑOL— y el `\b` hacía que
   * `total` seguido de `s` no cerrara palabra: el rótulo más común de una plantilla en inglés
   * era invisible para los tres filtros que lo consultan.
   */
  cartera.push(['', '', '', 'TOTALS', totalCartera, totalPagado, r2(totalCartera - totalPagado)]);

  /* ── Gastos: renglón de total Y consolidado por categoría al final ─────────────────────── */
  const CATS: [string, number][] = [
    ['Rent', 700],
    ['Professional Fees', 80],
    ['Utilities', 147.62],
    ['Marketing', 200],
    ['Salaries & Wages', 1911.08],
    ['Security & Insurance', 213.41],
  ];
  const gastos: unknown[][] = [['Date', 'Category', 'Description', 'Amount', 'Payment Method']];
  const porCategoria = new Map<string, number>();
  let totalGastos = 0;
  for (let mes = 1; mes <= 6; mes++) {
    for (const [cat, monto] of CATS) {
      totalGastos = r2(totalGastos + monto);
      porCategoria.set(cat, r2((porCategoria.get(cat) ?? 0) + monto));
      mas('opex', monto);
      gastos.push([
        serial(
          `2026-0${mes}-${String(3 + CATS.findIndex((c) => c[0] === cat) * 4).padStart(2, '0')}`,
        ),
        cat,
        `${cat} - month ${mes}`,
        monto,
        'Bank Transfer',
      ]);
    }
  }
  gastos.push(['', '', 'TOTAL OPERATING EXPENSES', totalGastos]);
  /*
   * ⚠️ EL CONSOLIDADO, ALINEADO BAJO LA COLUMNA DE MONTOS. En el archivo original sus cifras
   * caían en la columna 1 y no llegaba a duplicar por casualidad; así es la variante que sí
   * duplica, y es como lo escribiría cualquiera que quiera las cifras en la misma columna.
   */
  gastos.push(['EXPENSES BY CATEGORY']);
  gastos.push(['Category', '', '', 'Total']);
  for (const [cat, total] of porCategoria) gastos.push([cat, '', '', total]);

  return {
    archivo: '15-la-joyeria.xlsx',
    titulo: 'Plantilla en inglés bien hecha, con su total y su consolidado (el ×2 del portón)',
    rompe:
      'Reproduce la forma del archivo real que reportó el ×2 el 2026-09-03. El renglón de ' +
      'TOTAL lleva el rótulo alineado a la derecha —siete celdas vacías antes— y en la ' +
      'cartera va en PLURAL INGLÉS (`TOTALS`), que el filtro no reconocía porque el plural ' +
      'escrito era el español. Y los gastos terminan con un consolidado por categoría ' +
      'alineado bajo la columna de montos. Las tres cosas suman exactamente lo mismo que sus ' +
      'filas de arriba, así que contarlas reporta el DOBLE. ⚠️ El daño era del PORTÓN y no ' +
      'del dashboard —esas filas no traen fecha, así que `staging-rules` las marca— pero esa ' +
      'es la pantalla donde el dueño decide si publica: enseñarle el doble de su facturación ' +
      'lo deja eligiendo entre aprobar una cifra falsa o no aprobar la suya.',
    hojas: [
      ['Sales Orders', ventas],
      ['Accounts Receivable', cartera],
      ['Operating Expenses', gastos],
    ],
    verdad: v,
    clasificar: dobleDeModelo({
      tipos: { 'Sales Orders': 'revenue', 'Operating Expenses': 'opex' },
      entidades: { 'Accounts Receivable': 'invoice' },
    }),
    /*
     * ⚠️ 21, y cada una dice algo:
     *
     *  · 15 `missing_counterparty` — la cartera identifica al cliente por `Cust. ID` y no por
     *    nombre, igual que el archivo real. Una `invoice` sin contraparte no se puede leer en
     *    Por cobrar, así que se marca en vez de entrar a medias. Es correcto y es un hallazgo
     *    que vale conservar: una plantilla que normaliza el cliente a otra hoja deja su
     *    facturación en revisión.
     *  · 6 `invalid_date` — las seis filas del CONSOLIDADO. Llegan al modelo, no traen fecha y
     *    se marcan: visibles en la cola, nunca sumadas. Que sean exactamente seis es la prueba
     *    de que el consolidado no produjo movimientos.
     */
    marcadas: 21,
  };
}
