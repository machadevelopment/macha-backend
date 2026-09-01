import { dobleDeModelo, serial, type LibroHostil, type Verdad } from './pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL LIBRO DIFÍCIL: LAS SIETE REGLAS A LA VEZ, EN UN SOLO ARCHIVO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Los diez libros de `libros.ts` son archivos MAL HECHOS: cada uno rompe una cosa. Éste es
 * distinto — está **bien hecho** y es difícil por otra razón: trae, en un solo cuaderno, las
 * siete decisiones que un analista financiero tiene que tomar sobre una contabilidad real, y
 * cada una tiene una trampa que ya se cobró un cliente:
 *
 *   1. La tabla real no empieza en la fila 0 (`Ventas` trae dos líneas de título).
 *   2. Hay catálogos que PARECEN movimientos: `Clientes` tiene columna de fecha Y de dinero.
 *   3. La misma plata a dos granularidades (`OrdenesCompra` / `LineasOC`) y un consolidado
 *      del propio libro (`Resumen_Ventas_Mensual`) que empata con el detalle por construcción.
 *   4. Renta, planilla y marketing viven en una matriz por mes y son OPEX, nunca COGS.
 *   5. Una factura emitida devenga ingreso Y abre cuenta por cobrar; una recibida produce
 *      costo Y cuenta por pagar; y un COBRO de esas mismas facturas no es una venta nueva.
 *   6. El detalle tiene que sobrevivir fila por fila, con producto, tienda y categoría, o el
 *      dashboard queda con las cifras bien y las pantallas de producto vacías.
 *   7. Y hay suciedad real: un renglón de TOTAL, una fecha ilegible y una moneda que no
 *      manejamos.
 *
 * ═══ LA VERDAD SE CUENTA AL ESCRIBIRLA ═══
 *
 * Igual que el resto del corpus hostil: cada `mas(...)` ocurre en la misma línea en que se
 * escribe la fila, así que la cifra esperada no es una estimación sobre el archivo — es el
 * archivo. Lo que NO entra en la verdad es lo que legítimamente no debe aterrizar: el renglón
 * de total, la fila con fecha ilegible y la que viene en euros.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

function contador() {
  const v: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  return { v, mas: (k: keyof Verdad, n: number) => (v[k] = r2(v[k] + n)) };
}

/** Tasa GTQ/USD que el test siembra en `fx_rates`. */
export const TASA_USD = 7.7;

const TIENDAS = ['TDA-01', 'TDA-02', 'TDA-03'];
const NOMBRE_TIENDA: Record<string, string> = {
  'TDA-01': 'La Ceiba Centro',
  'TDA-02': 'La Ceiba Zona 10',
  'TDA-03': 'La Ceiba Xela',
};

const CATALOGO = [
  { cod: 'ABR-0001', nombre: 'Harina de maíz 5 lb', cat: 'Abarrotes', precio: 42, costo: 27.5 },
  { cod: 'ABR-0002', nombre: 'Aceite vegetal 1 L', cat: 'Abarrotes', precio: 38, costo: 25 },
  { cod: 'BEB-0007', nombre: 'Refresco 2 L', cat: 'Bebidas', precio: 22, costo: 13.4 },
  { cod: 'LIM-0003', nombre: 'Detergente 1 kg', cat: 'Limpieza', precio: 55, costo: 34 },
];

export function libroLaCeiba(): LibroHostil {
  const { v, mas } = contador();

  /* ─────────────────────────── 1. Portada: puro título ─────────────────────────── */

  const portada: unknown[][] = [
    ['DISTRIBUIDORA LA CEIBA, S.A.'],
    ['Libro contable enero–agosto 2026'],
    ['Uso interno · no modificar'],
  ];

  /* ───────── 2. Ventas: la tabla real, con dos líneas de título encima ───────── */

  const ventas: unknown[][] = [
    ['DISTRIBUIDORA LA CEIBA, S.A.'],
    ['Detalle de ventas por línea · ene–ago 2026'],
    [
      'Fecha',
      'No. Orden',
      'Tienda',
      'Cliente',
      'Código',
      'Producto',
      'Categoría',
      'Cantidad',
      'Precio Unitario',
      'Descuento %',
      'Total Línea',
      'Costo Unitario',
      'Moneda',
      'Método de Pago',
    ],
  ];

  /** Lo que suma la hoja, para poder escribir un consolidado que empate de verdad. */
  const ventasPorMes = new Map<number, number>();
  let orden = 1000;

  for (let mes = 1; mes <= 8; mes++) {
    for (const [t, tienda] of TIENDAS.entries()) {
      for (const [p, art] of CATALOGO.entries()) {
        const cantidad = 3 + ((mes + t + p) % 5);
        const descuento = p === 2 ? 0.1 : 0;
        const total = r2(art.precio * cantidad * (1 - descuento));
        const costo = r2(art.costo * cantidad);
        mas('revenue', total);
        mas('cogs', costo);
        ventasPorMes.set(mes, r2((ventasPorMes.get(mes) ?? 0) + total));
        ventas.push([
          serial(`2026-${String(mes).padStart(2, '0')}-${String(3 + p * 6 + t).padStart(2, '0')}`),
          `ORD-${orden++}`,
          tienda,
          `Cliente ${1 + ((mes + p) % 24)}`,
          art.cod,
          art.nombre,
          art.cat,
          cantidad,
          art.precio,
          descuento,
          total,
          art.costo,
          'GTQ',
          p % 2 === 0 ? 'Efectivo' : 'Tarjeta',
        ]);
      }
    }
  }

  /*
   * SUCIEDAD 1 — una fecha que no se puede leer. No se descarta en silencio: tiene que caer en
   * revisión con `invalid_date`, y su costo derivado también. Dos filas marcadas, cero quetzales
   * perdidos sin rastro.
   */
  ventas.push([
    '#N/D',
    `ORD-${orden++}`,
    'TDA-02',
    'Cliente mostrador',
    'ABR-0001',
    'Harina de maíz 5 lb',
    'Abarrotes',
    4,
    42,
    0,
    168,
    27.5,
    'GTQ',
    'Efectivo',
  ]);

  /*
   * SUCIEDAD 2 — una venta en euros. `asCurrency` conserva la moneda que la hoja AFIRMA en vez
   * de renombrarla a la base, justamente para que la fila se marque en vez de entrar valiendo
   * 7,7 veces menos. Sin columna de costo: así se marca una sola fila y se ve limpio el conteo.
   */
  ventas.push([
    serial('2026-08-14'),
    `ORD-${orden}`,
    'TDA-01',
    'Cliente de Madrid',
    'BEB-0007',
    'Refresco 2 L',
    'Bebidas',
    10,
    22,
    0,
    220,
    null,
    'EUR',
    'Transferencia',
  ]);

  /* SUCIEDAD 3 — el renglón de cierre. El modelo lo declara `skip` y no produce nada. */
  const totalVentas = [...ventasPorMes.values()].reduce((a, b) => r2(a + b), 0);
  ventas.push(['', 'TOTAL', '', '', '', '', '', '', '', '', totalVentas, '', '', '']);

  /* ────── 3. El consolidado del propio libro: empata con el detalle a propósito ────── */

  const resumen: unknown[][] = [['Mes', 'Total Ventas']];
  for (let mes = 1; mes <= 8; mes++) {
    resumen.push([serial(`2026-${String(mes).padStart(2, '0')}-01`), ventasPorMes.get(mes) ?? 0]);
  }

  /* ─────────── 4. Catálogos. `Clientes` trae fecha Y dinero: es la trampa ─────────── */

  const clientes: unknown[][] = [
    [
      'Cliente',
      'NIT',
      'Tipo',
      'Contacto',
      'Teléfono',
      'Condiciones',
      'Venta neta acumulada',
      'Unidades',
      'Última compra',
      'Saldo por cobrar',
    ],
  ];
  for (let i = 1; i <= 24; i++) {
    clientes.push([
      `Cliente ${i}`,
      `${1_000_000 + i * 37}-K`,
      i % 3 === 0 ? 'Mayorista' : 'Detalle',
      `Contacto ${i}`,
      `5${String(100_0000 + i * 13).slice(0, 7)}`,
      i % 2 === 0 ? '30 días' : 'Contado',
      12_000 + i * 430,
      80 + i,
      serial(`2026-0${(i % 8) + 1}-15`),
      i % 4 === 0 ? 3_400 + i * 90 : 0,
    ]);
  }

  const productos: unknown[][] = [
    ['SKU', 'Nombre Producto', 'Categoría', 'Subcategoria', 'Marca', 'Presentacion', 'Estado'],
  ];
  for (const a of CATALOGO) {
    productos.push([a.cod, a.nombre, a.cat, a.cat, 'La Ceiba', 'Unidad', 'Activo']);
  }

  const tiendas: unknown[][] = [
    ['IDTienda', 'Nombre', 'Ciudad', 'Pais', 'Gerente', 'Fecha Apertura', 'Superficie m2'],
  ];
  for (const t of TIENDAS) {
    tiendas.push([
      t,
      NOMBRE_TIENDA[t],
      t === 'TDA-03' ? 'Quetzaltenango' : 'Guatemala',
      'Guatemala',
      `Gerente ${t}`,
      serial('2019-05-01'),
      180,
    ]);
  }

  /* ───── 5. Inventario: fotografía de existencias, sin fecha por fila ───── */

  const inventario: unknown[][] = [
    ['SKU', 'Tienda', 'Cantidad Disponible', 'Punto Reorden', 'Costo Unitario', 'Ubicacion'],
  ];
  for (const t of TIENDAS) {
    for (const a of CATALOGO) {
      inventario.push([a.cod, t, 40 + CATALOGO.indexOf(a) * 12, 15, a.costo, `${t}-A${1}`]);
    }
  }

  /* ───── 6. Compras: cabecera y detalle de la MISMA plata ───── */

  const ordenes: unknown[][] = [
    ['IDOC', 'Fecha', 'Proveedor', 'Moneda', 'Total', 'Fecha Vencimiento'],
  ];
  const lineas: unknown[][] = [
    ['IDLineaOC', 'IDOC', 'SKU', 'Cantidad', 'Costo Unitario', 'Total Línea'],
  ];
  for (let i = 0; i < 12; i++) {
    const idoc = `OC-${2000 + i}`;
    const mes = (i % 8) + 1;
    // Cuatro líneas por orden; la cabecera trae su suma exacta.
    let totalOC = 0;
    for (const [k, art] of CATALOGO.entries()) {
      const cant = 40 + ((i + k) % 25);
      const totalLinea = r2(art.costo * cant);
      totalOC = r2(totalOC + totalLinea);
      lineas.push([`LOC-${i}${k}`, idoc, art.cod, cant, art.costo, totalLinea]);
    }
    mas('cogs', totalOC);
    ordenes.push([
      idoc,
      serial(`2026-${String(mes).padStart(2, '0')}-08`),
      `Proveedor ${(i % 4) + 1}`,
      'GTQ',
      totalOC,
      serial(`2026-${String(mes).padStart(2, '0')}-28`),
    ]);
  }

  /* ───── 7. Gastos operativos: matriz concepto × mes. Renta y planilla son OPEX ───── */

  const gastos: unknown[][] = [
    ['Concepto', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto'],
  ];
  const RUBROS: [string, number][] = [
    ['Renta del local', 18_500],
    ['Planilla administrativa', 42_000],
    ['Marketing digital', 6_200],
    ['Energía eléctrica', 4_100],
    ['Internet y teléfono', 1_350],
    ['Contabilidad externa', 3_000],
  ];
  for (const [concepto, base] of RUBROS) {
    const fila: unknown[] = [concepto];
    for (let mes = 1; mes <= 8; mes++) {
      const monto = r2(base + mes * 55);
      mas('opex', monto);
      fila.push(monto);
    }
    gastos.push(fila);
  }

  /* ───── 8. Facturación en USD: devenga ingreso Y abre cuenta por cobrar ───── */

  const facturacion: unknown[][] = [
    ['No. Factura', 'Fecha Emision', 'Cliente', 'Moneda', 'Monto', 'Fecha Vencimiento'],
  ];
  for (let i = 0; i < 10; i++) {
    const monto = 1_200 + i * 140;
    mas('revenue', r2(monto * TASA_USD));
    facturacion.push([
      `FAC-${500 + i}`,
      serial(`2026-0${(i % 8) + 1}-12`),
      `Cliente ${i + 1}`,
      'USD',
      monto,
      serial(`2026-0${(i % 8) + 1}-27`),
    ]);
  }

  /* ───── 9. Cobros de ESAS facturas: no son ventas nuevas ───── */

  const cobros: unknown[][] = [
    ['No. Recibo', 'Fecha', 'No. Factura', 'Cliente', 'Monto', 'Moneda'],
  ];
  for (let i = 0; i < 6; i++) {
    cobros.push([
      `REC-${900 + i}`,
      serial(`2026-0${(i % 8) + 1}-25`),
      `FAC-${500 + i}`,
      `Cliente ${i + 1}`,
      1_200 + i * 140,
      'USD',
    ]);
  }

  /* ───── 10. Notas: texto libre, ni una cifra ───── */

  const notas: unknown[][] = [
    ['Notas del contador'],
    ['Revisar reclasificación de fletes en septiembre'],
    ['El aumento de renta entra a partir de octubre'],
    ['Pendiente conciliar caja chica de Xela'],
  ];

  return {
    archivo: '12-la-ceiba.xlsx',
    titulo: 'Distribuidora La Ceiba — las siete reglas en un solo libro',
    rompe:
      'Un libro BIEN hecho y difícil: título sobre la tabla, un catálogo de clientes con ' +
      'fecha y dinero, un consolidado propio que empata con el detalle, cabecera y detalle de ' +
      'compras, matriz de gastos por mes, facturación en dólares con sus cobros, e ' +
      'inventario. Si cualquiera de las siete decisiones se toma mal, la cifra del cliente ' +
      'cambia sin que nada falle.',
    hojas: [
      ['Portada', portada],
      ['Ventas', ventas],
      ['Resumen_Ventas_Mensual', resumen],
      ['Clientes', clientes],
      ['Productos', productos],
      ['Tiendas', tiendas],
      ['Inventario', inventario],
      ['OrdenesCompra', ordenes],
      ['LineasOC', lineas],
      ['Gastos_Operativos', gastos],
      ['Facturacion', facturacion],
      ['Cobros', cobros],
      ['Notas', notas],
    ],
    verdad: v,
    base: 'GTQ',
    tasas: { USD: TASA_USD },
    marcadas: 3,
    destinos: {
      Ventas: 'movimientos:192',
      Resumen_Ventas_Mensual: 'descartada:reporte',
      Clientes: 'descartada:catalogo:contactos',
      Productos: 'descartada:catalogo:productos',
      Tiendas: 'descartada:catalogo:ubicaciones',
      Inventario: 'inventario',
      // La línea de la orden de compra NO es una lista de existencias: es el detalle de la
      // cabecera de al lado, y por eso la descarta el dedup y no la captura el inventario.
      LineasOC: 'descartada:duplica',
      OrdenesCompra: 'movimientos:12',
      Gastos_Operativos: 'movimientos:48:despivotada',
      Facturacion: 'movimientos:10',
      // Los seis recibos apuntan a facturas ya devengadas: no vuelven a registrar ingreso.
      Cobros: 'movimientos:0',
    },
    clasificar: dobleDeModelo({
      tipos: {
        Ventas: 'revenue',
        Facturacion: 'revenue',
        Cobros: 'revenue',
        OrdenesCompra: 'cogs',
        Gastos_Operativos: 'opex',
        Resumen_Ventas_Mensual: 'revenue',
      },
      entidades: { Facturacion: 'invoice', OrdenesCompra: 'bill' },
    }),
  };
}
