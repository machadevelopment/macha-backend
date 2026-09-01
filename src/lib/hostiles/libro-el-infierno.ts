import { dobleDeModelo, serial, type LibroHostil, type Verdad } from './pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL INFIERNO: TODAS LAS TRAMPAS CONOCIDAS EN UN SOLO CUADERNO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `libro-la-ceiba` junta las siete decisiones de un analista sobre un archivo BIEN hecho.
 * Éste va más lejos: junta **todos los modos de fallo que esta ingesta ya pagó con un cliente**,
 * en el mismo libro, y encima está mal escrito. Cada hoja existe porque un bug real vivió ahí.
 *
 * Diecisiete hojas, y solo SIETE deben producir movimientos. Si el pipeline se equivoca en una
 * sola de las otras diez, la cifra del cliente cambia sin que nada falle — que es la única
 * forma de fallo que importa en este producto.
 *
 * ═══ LO QUE DEBE ATERRIZAR (7 hojas) ═══
 *
 *   · `Ventas`            movimientos con su costo en la línea
 *   · `OrdenesCompra`     cuentas por pagar SIN tipo → el cliente las contesta
 *   · `Gastos_Operativos` matriz concepto × mes, con los meses MAL ESCRITOS
 *   · `Facturacion`       facturas en USD que devengan su ingreso UNA vez
 *   · `Inventario`        existencias por (SKU, tienda) — no suma dinero, ajusta stock
 *   · `Servicios_Varios`  gastos con concepto ambiguo → el cliente los contesta
 *   · `Ventas_Mostrador`  ventas sin contraparte (la hoja que NINGUNA señal debe silenciar)
 *
 * ═══ LO QUE NO DEBE ATERRIZAR (10 hojas), Y QUÉ BUG ES CADA UNA ═══
 *
 *   · `Portada`             texto suelto. Trivial, y aun así llegó al modelo alguna vez.
 *   · `Ventas (2)`          COPIA EXACTA de `Ventas`: mismo dinero al centavo → facturación al
 *                           doble (2026-08-30).
 *   · `Resumen_Ventas`      consolidado propio de CUATRO filas con el período escrito como
 *                           serial de Excel → +945,00 medidos en producción (2026-09-01). Es el
 *                           caso que exige combinar empate al centavo con forma de período.
 *   · `Clientes_B2B`        cartera con `Venta neta acumulada` y `Saldo por cobrar`, y los
 *                           encabezados MAL ESCRITOS (`Contactoo`, `Telefonoo`, `Condicionees`).
 *                           Es KapePrueba (Q 13.362,75 de cobranza como ingresos) por la puerta
 *                           del typo, que apagaba la firma entera.
 *   · `Productos`/`Tiendas` catálogos.
 *   · `LineasOC`            detalle de `OrdenesCompra`: la misma plata a dos granularidades
 *                           (Q 2.707.318 contados dos veces en el archivo que lo motivó).
 *   · `Estado_Resultados`   matriz con la MISMA forma que la de gastos, pero es un estado:
 *                           `Ingresos = Egresos + Diferencia`. Etiquetas genéricas, así que no
 *                           la salva la lista de agregados ni el solape de conceptos — solo la
 *                           identidad aritmética (2026-08-30).
 *   · `Cobros`             cobros de las facturas de arriba: +52 % de ingreso si devengan otra
 *                           vez.
 *   · `Presupuesto`        columnas `Q1 2026 · Q2 2026 · Q3 2026`: períodos, no meses.
 *   · `Notas`              prosa del contador.
 *
 * ═══ Y LA SUCIEDAD, QUE VA APARTE ═══
 *
 * Fechas en CINCO formatos en la misma hoja (serial, `DD/MM/AAAA`, ISO en texto, mes en
 * español, y una imposible), montos escritos a mano (`Q 1,234.50`, paréntesis por negativo,
 * espacio duro), una moneda que no manejamos, un renglón de TOTAL y un PIE DE PÁGINA que
 * compite con el encabezado real.
 *
 * ═══ LA VERDAD SE CUENTA AL ESCRIBIRLA ═══
 *
 * Cada `mas(...)` ocurre en la línea donde se escribe la fila: la cifra esperada no es una
 * estimación sobre el archivo, ES el archivo. Lo que no entra es lo que legítimamente no debe
 * aterrizar — el TOTAL, la fecha imposible y la fila en euros.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

function contador() {
  const v: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  return { v, mas: (k: keyof Verdad, n: number) => (v[k] = r2(v[k] + n)) };
}

/** Tasa GTQ/USD que el test siembra en `fx_rates`. */
export const TASA_USD = 7.7;

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]; // prettier-ignore

/**
 * `escala` multiplica todos los montos. Existe para poder subir el MISMO libro dos veces a una
 * empresa real sin que la huella por fila (`ingested_rows`) lo reconozca como ya ingerido — que
 * es la conducta correcta y por eso no se puede desactivar. No cambia ninguna decisión del
 * pipeline: las proporciones, las formas y los empates se conservan.
 */
export function libroElInfierno(serie = '', anio = 2026): LibroHostil {
  /*
   * `serie` se pega a los CÓDIGOS de documento (`OV-`, `OC-`, `FAC-`, `REC-`, `LOC-`). Existe
   * para poder subir este mismo libro dos veces a una empresa real sin que la huella por fila
   * (`ingested_rows`) lo reconozca como ya ingerido — que es la conducta correcta y por eso no
   * se desactiva. No mueve un centavo ni rompe las referencias entre hojas: los códigos siguen
   * siendo consistentes entre `Facturacion` y `Cobros`, y entre `OrdenesCompra` y `LineasOC`.
   */
  const cod = (c: string) => `${c}${serie}`;
  /*
   * `anio` desplaza TODAS las fechas del libro. Existe por la misma razón que `serie`, y es más
   * fuerte: la huella por fila (`ingested_rows`) recuerda una carga aunque se haya revertido
   * —revertir borra el ledger, no las huellas— y `serie` solo cambia los CÓDIGOS, que la mitad
   * de las hojas no tiene. Sin esto, resubir este libro a una empresa que ya lo vio da
   * `ya_ingerida` en casi todo y la prueba no prueba nada.
   *
   * No mueve la verdad de campo: los totales no dependen del año.
   */
  const dia = (mmdd: string) => serial(`${anio}-${mmdd}`);
  const { v, mas } = contador();
  const hojas: [string, unknown[][]][] = [];

  /* ── 1. Portada: texto suelto ─────────────────────────────────────────────────────────── */
  hojas.push([
    'Portada',
    [
      ['COMERCIALIZADORA EL INFIERNO, S.A.'],
      [`Libro contable · ejercicio ${anio}`],
      ['Documento interno · no distribuir'],
    ],
  ]);

  /* ── 2. Ventas ────────────────────────────────────────────────────────────────────────────
   * Dos líneas de título arriba, un PIE DE PÁGINA abajo que cubre media tabla, cinco formatos
   * de fecha, montos escritos a mano y tres filas que NO deben aterrizar.
   */
  const ventas: unknown[][] = [
    ['COMERCIALIZADORA EL INFIERNO, S.A.'],
    [`Detalle de ventas · ene–jun ${anio}`],
    ['Fecha', 'No. Orden', 'Tienda', 'Cliente', 'Producto', 'Moneda', 'Monto', 'Costo Total'],
  ];

  /** Las ocho ventas buenas, cada una con la fecha escrita de una forma distinta. */
  const BUENAS = [
    { f: dia('01-08'), t: 'TDA-01', c: 'Cliente 1', p: 'Harina 5 lb', m: 1240.5, k: 780 },
    { f: `15/02/${anio}`,        t: 'TDA-01', c: 'Cliente 2', p: 'Aceite 1 L',  m: 980,    k: 610 },
    { f: `${anio}-03-04`,        t: 'TDA-02', c: 'Cliente 3', p: 'Refresco 2 L', m: 1530.75, k: 940 },
    { f: `15 de marzo de ${anio}`, t: 'TDA-02', c: 'Cliente 1', p: 'Detergente', m: 2110, k: 1305 },
    { f: dia('04-02'), t: 'TDA-03', c: 'Cliente 4', p: 'Harina 5 lb', m: 'Q 1,234.50', k: 760 },
    { f: `18/04/${anio}`,        t: 'TDA-03', c: 'Cliente 2', p: 'Aceite 1 L',  m: ' 1 890,00 ', k: 1160 },
    { f: dia('05-11'), t: 'TDA-01', c: 'Cliente 5', p: 'Refresco 2 L', m: 2450.25, k: 1500 },
    { f: `${anio}-06-20`,        t: 'TDA-02', c: 'Cliente 3', p: 'Detergente',  m: 1760, k: 1080 },
  ]; // prettier-ignore

  /** `Q 1,234.50` y ` 1 890,00 ` valen lo que dicen: el lector de montos tiene que leerlos. */
  const VALOR: Record<string, number> = { 'Q 1,234.50': 1234.5, ' 1 890,00 ': 1890 };
  const montoDe = (m: unknown) => (typeof m === 'number' ? m : VALOR[String(m)]!);

  for (const b of BUENAS) {
    ventas.push([b.f, cod(`OV-${1000 + ventas.length}`), b.t, b.c, b.p, 'GTQ', b.m, b.k]);
    mas('revenue', montoDe(b.m));
    mas('cogs', b.k); // El costo en la línea produce su propia transacción.
  }

  // NO aterrizan, y cada una por un motivo distinto:
  ventas.push([dia('06-25'), cod('OV-9001'), 'TDA-01', 'Cliente 9', 'Aceite 1 L', 'EUR', 220, 130]);
  ventas.push([
    `${anio}-02-31`,
    cod('OV-9002'),
    'TDA-01',
    'Cliente 8',
    'Harina 5 lb',
    'GTQ',
    500,
    300,
  ]);
  ventas.push(['TOTAL', '', '', '', '', 'GTQ', 13_416, 8_265]);
  // Pie de página: tres celdas que "cubren" la tabla y compiten con el encabezado real.
  ventas.push([anio, 6, 'Hoja 1 de 1']);
  hojas.push(['Ventas', ventas]);

  /* ── 3. Ventas (2): copia exacta ─────────────────────────────────────────────────────── */
  hojas.push(['Ventas (2)', ventas.map((f) => [...f])]);

  /* ── 4. Resumen_Ventas: consolidado propio, período como serial, CUATRO filas ─────────── */
  /*
   * Un consolidado de verdad lo escribe una FÓRMULA (`SUMIFS` por mes sobre la columna de
   * monto), así que suma la columna ENTERA — incluidas la fila en euros y la de fecha
   * imposible, porque una fórmula no sabe de eso. Consolidar solo las filas buenas sería
   * escribir a mano un archivo que nadie escribe así, y el empate al centavo dejaría de
   * existir justo donde este libro quiere probarlo.
   */
  const porMes: Record<string, number> = {};
  const sumar = (mes: number, monto: number) =>
    (porMes[String(mes)] = r2((porMes[String(mes)] ?? 0) + monto));
  const mesDe = (f: unknown): number => {
    if (typeof f === 'number')
      return new Date(Date.UTC(1899, 11, 30) + f * 86_400_000).getUTCMonth() + 1;
    const t = String(f);
    if (/^\d{2}\/\d{2}\//.test(t)) return Number(t.slice(3, 5));
    if (/^\d{4}-\d{2}-/.test(t)) return Number(t.slice(5, 7));
    return MESES_ES.indexOf(/de (\w+) de/.exec(t)![1]!) + 1;
  };
  for (const b of BUENAS) sumar(mesDe(b.f), montoDe(b.m));
  sumar(6, 220); // la fila en euros
  sumar(2, 500); // la de fecha imposible

  hojas.push([
    'Resumen_Ventas',
    [
      ['Mes', 'Total Ventas'],
      ...Object.entries(porMes)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([m, t]) => [serial(`${anio}-0${m}-01`), t]),
    ],
  ]);

  /* ── 5. Clientes_B2B: cartera con encabezados MAL ESCRITOS ────────────────────────────── */
  const clientes: unknown[][] = [
    ['Cliente', 'NIT', 'Tipo', 'Contactoo', 'Telefonoo', 'Condicionees', 'Venta neta acumulada', 'Última compra', 'Saldo por cobrar'],
  ]; // prettier-ignore
  for (let i = 1; i <= 6; i++) {
    clientes.push([
      `Cliente ${i}`, `10000${i}-K`, i % 2 ? 'Detalle' : 'Mayoreo',
      `Contacto ${i}`, `5100001${i}`, i % 2 ? 'Contado' : '30 días',
      12_000 + i * 430, dia('06-15'), 3_400 + i * 210,
    ]); // prettier-ignore
  }
  hojas.push(['Clientes_B2B', clientes]);

  /* ── 6-7. Catálogos ───────────────────────────────────────────────────────────────────── */
  hojas.push([
    'Productos',
    [
      ['SKU', 'Nombre Producto', 'Categoría', 'Marca', 'Presentacion', 'Estado'],
      ['ABR-0001', 'Harina de maíz 5 lb', 'Abarrotes', 'El Infierno', 'Unidad', 'Activo'],
      ['ABR-0002', 'Aceite vegetal 1 L', 'Abarrotes', 'El Infierno', 'Unidad', 'Activo'],
      ['BEB-0007', 'Refresco 2 L', 'Bebidas', 'El Infierno', 'Unidad', 'Activo'],
      ['LIM-0003', 'Detergente 1 kg', 'Limpieza', 'El Infierno', 'Unidad', 'Activo'],
    ],
  ]);
  hojas.push([
    'Tiendas',
    [
      ['IDTienda', 'Nombre', 'Ciudad', 'Pais', 'Gerente', 'Fecha Apertura'],
      ['TDA-01', 'Centro', 'Guatemala', 'Guatemala', 'Gerente 1', serial('2019-05-01')],
      ['TDA-02', 'Zona 10', 'Guatemala', 'Guatemala', 'Gerente 2', serial('2020-02-01')],
      ['TDA-03', 'Xela', 'Quetzaltenango', 'Guatemala', 'Gerente 3', serial('2021-09-01')],
    ],
  ]);

  /* ── 8. Inventario: (SKU, tienda) con SKU repetido ────────────────────────────────────── */
  const inventario: unknown[][] = [
    ['SKU', 'Tienda', 'Cantidad Disponible', 'Punto Reorden', 'Costo Unitario', 'Precio Lista'],
  ];
  for (const sku of ['ABR-0001', 'ABR-0002', 'BEB-0007', 'LIM-0003']) {
    for (const [i, tda] of ['TDA-01', 'TDA-02', 'TDA-03'].entries()) {
      inventario.push([sku, tda, 30 + i * 12, 15, 27.5, 42]);
    }
  }
  hojas.push(['Inventario', inventario]);

  /* ── 9. OrdenesCompra: cuentas por pagar SIN tipo → LAS CONTESTA EL CLIENTE ───────────── */
  const PROVEEDORES = ['Cropa', 'Distribuidora El Quetzal', 'Servicios Múltiples R&M'];
  const ordenes: unknown[][] = [
    ['IDOC', 'Fecha', 'Proveedor', 'Moneda', 'Total', 'Fecha Vencimiento'],
  ];
  const lineas: unknown[][] = [
    ['IDLineaOC', 'IDOC', 'SKU', 'Cantidad', 'Costo Unitario', 'Total Línea'],
  ];
  let totalOC = 0;
  for (let i = 0; i < 12; i++) {
    const id = cod(`OC-${2000 + i}`);
    const monto = r2(3_150 + i * 187.4);
    const mes = (i % 6) + 1;
    ordenes.push([
      id, serial(`${anio}-0${mes}-1${(i % 8) + 1}`), PROVEEDORES[i % 3], 'GTQ', monto,
      serial(`${anio}-0${Math.min(mes + 1, 9)}-1${(i % 8) + 1}`),
    ]); // prettier-ignore
    totalOC = r2(totalOC + monto);
    // El detalle: cuatro líneas por orden que suman EXACTAMENTE su total.
    const parte = r2(monto / 4);
    for (let k = 0; k < 4; k++) {
      const m = k === 3 ? r2(monto - parte * 3) : parte;
      lineas.push([cod(`LOC-${i}-${k}`), id, `ABR-000${(k % 2) + 1}`, 10 + k, r2(m / (10 + k)), m]);
    }
  }
  // Su costo entra cuando el cliente contesta que es mercadería. Ver `marcadas`.
  mas('cogs', totalOC);
  hojas.push(['OrdenesCompra', ordenes]);
  hojas.push(['LineasOC', lineas]);

  /* ── 10. Gastos_Operativos: matriz con los MESES MAL ESCRITOS ────────────────────────── */
  const RUBROS = [
    { nombre: 'Renta del local', base: 8_500 },
    { nombre: 'Planilla administrativa', base: 21_400 },
    { nombre: 'Energía eléctrica', base: 3_150 },
    { nombre: 'Publicidad y marketing', base: 4_800 },
  ];
  // `Enrero`, `Febrro` y `Abrl` con typo: hacen falta ≥1 mes exacto y ≥2 casi-coincidencias.
  const CABECERA_MESES = ['Enrero', 'Febrro', 'Marzo', 'Abrl', 'Mayo', 'Junio'];
  const gastos: unknown[][] = [['Concepto', ...CABECERA_MESES, 'Total']];
  for (const r of RUBROS) {
    const fila: unknown[] = [r.nombre];
    let suma = 0;
    for (let m = 0; m < 6; m++) {
      const monto = r2(r.base + m * 55);
      fila.push(monto);
      suma = r2(suma + monto);
      mas('opex', monto);
    }
    fila.push(suma);
    gastos.push(fila);
  }
  hojas.push(['Gastos_Operativos', gastos]);

  /* ── 11. Estado_Resultados: MISMA forma, pero es un estado ────────────────────────────── */
  const ingresosMes = [12_400, 13_100, 11_900, 14_250, 13_800, 12_650];
  const egresosMes = [9_100, 9_450, 8_800, 10_050, 9_900, 9_200];
  hojas.push([
    'Estado_Resultados',
    [
      ['Concepto', ...MESES_ES.slice(0, 6).map((m) => m[0]!.toUpperCase() + m.slice(1))],
      ['Ingresos', ...ingresosMes],
      ['Egresos', ...egresosMes],
      // La identidad que lo delata: Ingresos = Egresos + Diferencia.
      ['Diferencia', ...ingresosMes.map((x, i) => r2(x - egresosMes[i]!))],
    ],
  ]);

  /* ── 12. Facturacion: USD, devenga su ingreso UNA vez ─────────────────────────────────── */
  const facturas: unknown[][] = [
    ['No. Factura', 'Fecha Emision', 'Cliente', 'Moneda', 'Monto', 'Fecha Vencimiento'],
  ];
  for (let i = 0; i < 8; i++) {
    const monto = 900 + i * 65;
    facturas.push([
      cod(`FAC-${500 + i}`), serial(`${anio}-0${(i % 6) + 1}-0${(i % 8) + 1}`), `Cliente ${(i % 5) + 1}`,
      'USD', monto, serial(`${anio}-0${Math.min((i % 6) + 2, 9)}-0${(i % 8) + 1}`),
    ]); // prettier-ignore
    mas('revenue', r2(monto * TASA_USD));
  }
  hojas.push(['Facturacion', facturas]);

  /* ── 13. Cobros: de ESAS facturas. No devengan de nuevo ───────────────────────────────── */
  const cobros: unknown[][] = [
    ['No. Recibo', 'Fecha', 'No. Factura', 'Cliente', 'Monto', 'Moneda'],
  ];
  for (let i = 0; i < 6; i++) {
    cobros.push([
      cod(`REC-${900 + i}`), serial(`${anio}-0${(i % 6) + 2}-2${(i % 8) + 1}`), cod(`FAC-${500 + i}`),
      `Cliente ${(i % 5) + 1}`, 900 + i * 65, 'USD',
    ]); // prettier-ignore
  }
  hojas.push(['Cobros', cobros]);

  /* ── 14. Presupuesto: TRIMESTRES, no meses ────────────────────────────────────────────── */
  hojas.push([
    'Presupuesto',
    [
      ['Rubro', `Q1 ${anio}`, `Q2 ${anio}`, `Q3 ${anio}`, `Q4 ${anio}`],
      ['Ventas proyectadas', 42_000, 45_000, 47_500, 51_000],
      ['Compras proyectadas', 26_000, 27_800, 29_100, 31_400],
      ['Gastos proyectados', 11_200, 11_500, 11_900, 12_400],
    ],
  ]);

  /* ── 15. Servicios_Varios: conceptos AMBIGUOS → los contesta el cliente ───────────────── */
  const servicios: unknown[][] = [['Fecha', 'Proveedor', 'Descripción', 'Moneda', 'Monto']];
  const AMBIGUOS = [
    ['Cropa', 'Servicio contratado mensual'],
    ['R&M Asociados', 'Servicio contratado mensual'],
  ];
  let totalServicios = 0;
  for (let i = 0; i < 6; i++) {
    const monto = r2(1_450 + i * 96.5);
    const a = AMBIGUOS[i % 2]!;
    servicios.push([serial(`${anio}-0${(i % 6) + 1}-25`), a[0], a[1], 'GTQ', monto]);
    totalServicios = r2(totalServicios + monto);
  }
  // También entran cuando el cliente dice qué son. Ver `marcadas`.
  mas('opex', totalServicios);
  hojas.push(['Servicios_Varios', servicios]);

  /* ── 16. Ventas_Mostrador: sin contraparte. NINGUNA señal debe silenciarla ────────────── */
  const mostrador: unknown[][] = [['Fecha', 'Producto', 'Cantidad', 'Moneda', 'Monto']];
  for (let i = 0; i < 9; i++) {
    const monto = r2(310 + i * 47.25);
    mostrador.push([
      serial(`${anio}-0${(i % 6) + 1}-0${(i % 9) + 1}`),
      'Venta de mostrador',
      1,
      'GTQ',
      monto,
    ]);
    mas('revenue', monto);
  }
  hojas.push(['Ventas_Mostrador', mostrador]);

  /* ── 17. Notas ────────────────────────────────────────────────────────────────────────── */
  hojas.push([
    'Notas',
    [
      ['Notas del contador'],
      ['Revisar reclasificación de fletes en julio'],
      ['El aumento de renta entra a partir de octubre'],
    ],
  ]);

  return {
    archivo: '13-el-infierno.xlsx',
    titulo: 'Comercializadora El Infierno — todas las trampas a la vez',
    rompe:
      'Diecisiete hojas y solo siete producen movimientos. Copia exacta, consolidado propio de ' +
      'cuatro filas, cartera con encabezados mal escritos, cabecera y detalle, matriz de gastos ' +
      'con los meses con typo, un estado de resultados con la misma forma, cobros de facturas ya ' +
      'devengadas, presupuesto por trimestres, cinco formatos de fecha, montos escritos a mano, ' +
      'una moneda que no manejamos, un TOTAL y un pie de página que compite con el encabezado.',
    hojas,
    verdad: v,
    base: 'GTQ',
    tasas: { USD: TASA_USD },
    /*
     * TREINTA Y CUATRO filas a revisión, y el desglose importa porque son dos cosas distintas:
     *
     *   · **30 que el CLIENTE contesta** (`low_confidence`): las 12 órdenes de compra con su
     *     costo derivado —¿mercadería o gasto de operación?— y los 6 servicios con concepto
     *     ambiguo ("Cropa", "R&M Asociados"). Su dinero SÍ está en `verdad`: tiene que
     *     aterrizar en cuanto conteste, y que no lo haga es el bug que se arregló el
     *     2026-09-01 (`lib/derivacion-de-costo.ts`).
     *   · **4 que ninguna categoría arregla**: la fila en EUR y la de fecha imposible, cada una
     *     con su costo en la línea. Su dinero NO está en `verdad` — no debe aterrizar nunca, y
     *     tampoco debe aparecer en la pantalla de conceptos, porque el problema es el dato.
     */
    marcadas: 34,
    clasificar: dobleDeModelo({
      tipos: {
        Ventas: 'revenue',
        'Ventas (2)': 'revenue',
        Ventas_Mostrador: 'revenue',
        Resumen_Ventas: 'revenue',
        Clientes_B2B: 'revenue',
        OrdenesCompra: 'cogs',
        LineasOC: 'cogs',
        Gastos_Operativos: 'opex',
        Estado_Resultados: 'revenue',
        Facturacion: 'revenue',
        Cobros: 'revenue',
        Presupuesto: 'revenue',
        Servicios_Varios: 'opex',
      },
      entidades: { Facturacion: 'invoice', OrdenesCompra: 'bill' },
      // Por debajo de `CONFIDENCE_THRESHOLD`: el modelo no se compromete y pregunta el cliente.
      confianza: { OrdenesCompra: 0.45, Servicios_Varios: 0.45 },
    }),
  };
}
