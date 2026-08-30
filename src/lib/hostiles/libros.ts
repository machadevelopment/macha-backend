import { asNumber as asNumeroDeCelda } from '../row-assembly';
import {
  dobleDeModelo,
  serial,
  type LibroHostil,
  type Tipo,
  type Verdad,
} from './pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DIEZ LIBROS MAL HECHOS, CADA UNO CON SU VERDAD DE CAMPO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * No son archivos "difíciles" en el sentido de grandes: son archivos MAL HECHOS, que es lo que
 * un cliente sube de verdad. Encabezados con typos, columnas corridas, dos tablas en una hoja,
 * montos escritos a mano, meses mal escritos, fechas imposibles.
 *
 * Cada libro se genera desde acá, así que la VERDAD se conoce por construcción: no se estima
 * cuánto ingreso hay, se cuenta al escribirlo. Esa es la única forma de afirmar la cifra del
 * dashboard en vez de afirmar el veredicto de un filtro.
 *
 * Los mismos diez se escriben a disco con `bun run hostiles:generar` para subirlos por la
 * aplicación de verdad.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Acumulador de verdad: se suma al mismo tiempo que se escribe la fila. */
function contador() {
  const v: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  return { v, mas: (k: keyof Verdad, n: number) => (v[k] = r2(v[k] + n)) };
}

const MES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]; // prettier-ignore

/* ═══════════════════════════ 1. TYPOS EN TODOS LOS ENCABEZADOS ═══════════════════════════ */

function libroTypos(): LibroHostil {
  const { v, mas } = contador();

  const ventas: unknown[][] = [
    ['Fehca', 'No. Fatura', 'Clietne', 'Prodcuto', 'Cantidd', 'Montoo', 'Monedaa'],
  ];
  for (let m = 1; m <= 8; m++) {
    for (let k = 0; k < 5; k++) {
      const monto = 1200 + m * 70 + k * 15;
      mas('revenue', monto);
      ventas.push([
        serial(`2026-${String(m).padStart(2, '0')}-${String(4 + k * 3).padStart(2, '0')}`),
        `FAC-${m}${k}`,
        'Distribuidora El Quetzal',
        'Bolsa de café 500 g',
        3,
        monto,
        'GTQ',
      ]);
    }
  }

  const gastos: unknown[][] = [['FECHA ', 'PROVEDOR', 'CATEGORIA', 'MONTO Q', ' MONEDA']];
  for (let m = 1; m <= 8; m++) {
    for (const [quien, cat, monto] of [
      ['Energuate', 'Servicos', 640],
      ['Alquileres Zona 4', 'Alquilr', 3500],
      ['Contadora externa', 'Honorrios', 900],
    ] as [string, string, number][]) {
      mas('opex', monto);
      gastos.push([serial(`2026-${String(m).padStart(2, '0')}-28`), quien, cat, monto, 'GTQ']);
    }
  }

  /*
   * Cartera de clientes con los encabezados MAL ESCRITOS. Es el caso de KapePrueba con la
   * dificultad subida: allá la firma `contactos` fallaba por una columna que se llamaba
   * "Cliente"; acá falla porque están todas con typos. Si el pre-filtro no la reconoce, el
   * doble hace lo que hizo el modelo de verdad —fecha de última compra + saldo por cobrar— y
   * el saldo pendiente aparece como ingresos.
   */
  const cartera: unknown[][] = [
    ['Clietne', 'NIT', 'Contactoo', 'Telefonoo', 'Condicionees', 'Ultma Compra', 'Saldo x Cobrr'],
    ['Distribuidora El Quetzal', '4521879-3', 'Ana Morales', '5512-8890', '30 dias', serial('2026-08-20'), 18_400], // prettier-ignore
    ['Abarrotería La Bendición', '8834125-6', 'Rodrigo Pérez', '4478-2201', '15 dias', serial('2026-08-22'), 9_250], // prettier-ignore
    ['Tienda Doña Chus', '1209774-1', 'Marta Xoc', '5590-4412', 'Contado', serial('2026-08-19'), 3_120], // prettier-ignore
    ['Super del Barrio', '7781203-9', 'Luis Ich', '3312-7788', '30 dias', serial('2026-08-25'), 6_040], // prettier-ignore
    ['Cafetería Central', '3390112-4', 'Sara Tzoc', '4411-9903', '30 dias', serial('2026-08-27'), 11_770], // prettier-ignore
  ];

  return {
    archivo: '01-typos-en-encabezados.xlsx',
    titulo: 'Typos en todos los encabezados',
    rompe:
      'Ninguna columna se llama como debe. El pre-filtro de catálogo y la firma de contactos ' +
      'se buscan por vocabulario, así que un typo los apaga y la cartera de clientes llega al ' +
      'modelo — que fue el bug de KapePrueba (Q 13.362,75 de cobranza como ingresos).',
    hojas: [
      ['Ventaas', ventas],
      ['Gastoss', gastos],
      ['Clietnes', cartera],
    ],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { Ventaas: 'revenue', Gastoss: 'opex' } }),
    destinos: {
      Ventaas: 'movimientos:40',
      Gastoss: 'movimientos:24',
      Clietnes: 'descartada:catalogo:contactos',
    },
  };
}

/* ═══════════════════════ 2. COLUMNAS CORRIDAS Y ENCABEZADO ENTERRADO ═══════════════════════ */

function libroColumnasCorridas(): LibroHostil {
  const { v, mas } = contador();

  /*
   * Cuatro columnas vacías a la izquierda, tres filas de título arriba (una con números, para
   * que no baste "la primera fila con texto"), un encabezado repetido (`Monto` es a la vez la
   * cantidad y el importe) y una columna entera vacía en el medio.
   */
  const ventas: unknown[][] = [
    [null, null, null, null, 'COMERCIALIZADORA XELA, S.A.'],
    [null, null, null, null, 'NIT 7788990-1', null, 'Periodo: 2026'],
    [null, null, null, null, 2026, null, 8, null, 'Hoja 1 de 1'],
    [],
    [null, null, null, null, 'Fecha', 'Documento', 'Cliente', null, 'Monto', 'Monto', 'Moneda'],
  ];
  for (let m = 1; m <= 8; m++) {
    for (let k = 0; k < 4; k++) {
      const importe = 2100 + m * 60 + k * 25;
      mas('revenue', importe);
      ventas.push([
        null, null, null, null,
        serial(`2026-${String(m).padStart(2, '0')}-${String(6 + k * 4).padStart(2, '0')}`),
        `BOL-${m}${k}`, 'Ferretería El Tornillo', null, 2, importe, 'GTQ',
      ]); // prettier-ignore
    }
  }

  const compras: unknown[][] = [
    ['Compras a proveedores'],
    [],
    [null, 'Fecha', 'Proveedor', 'Descripcion', 'Monto', 'Moneda'],
  ];
  for (let m = 1; m <= 8; m++) {
    const monto = 3400 + m * 90;
    mas('cogs', monto);
    compras.push([
      null,
      serial(`2026-${String(m).padStart(2, '0')}-12`),
      'Importaciones del Sur',
      'Lote de mercadería',
      monto,
      'GTQ',
    ]);
  }

  return {
    archivo: '02-columnas-corridas.xlsx',
    titulo: 'Encabezado enterrado y columnas corridas',
    rompe:
      'La tabla empieza en la columna E y en la fila 5, con una fila de título que trae ' +
      'números (2026, 8) para que parezca datos. Y hay DOS columnas llamadas `Monto`: la ' +
      'primera es la cantidad. Elegir la fila 0 desplaza el mapa entero y los datos salen de ' +
      'las columnas equivocadas, sin que nada falle visiblemente.',
    hojas: [
      ['Ventas', ventas],
      ['Compras', compras],
    ],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { Ventas: 'revenue', Compras: 'cogs' } }),
    destinos: { Ventas: 'movimientos:32', Compras: 'movimientos:8' },
  };
}

/* ══════════════════════════ 3. MONTOS ESCRITOS A MANO, SUCIOS ══════════════════════════ */

function libroMontosSucios(): LibroHostil {
  const { v, mas } = contador();

  const filas: unknown[][] = [['Fecha', 'Cliente', 'Concepto', 'Monto', 'Moneda']];
  const escrituras: ((n: number) => string)[] = [
    (n) => `Q ${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    (n) => `${n.toFixed(2).replace('.', ',')}`,
    (n) => ` ${n.toLocaleString('en-US', { minimumFractionDigits: 2 })} Q `,
    (n) => `GTQ${n.toFixed(2)}`,
    (n) => n.toFixed(2),
  ];
  let k = 0;
  for (let m = 1; m <= 8; m++) {
    for (let j = 0; j < 5; j++) {
      const monto = 900 + m * 40 + j * 11;
      mas('revenue', monto);
      filas.push([
        serial(`2026-${String(m).padStart(2, '0')}-${String(2 + j * 5).padStart(2, '0')}`),
        'Panadería San Juan',
        'Venta de mostrador',
        escrituras[k++ % escrituras.length]!(monto),
        'GTQ',
      ]);
    }
  }
  /* Cuatro celdas que NO son montos: tienen que ir a revisión, no inventarse un número. */
  const basura = ['#REF!', '#N/A', '-', 'PENDIENTE'];
  for (const b of basura) {
    filas.push([serial('2026-08-30'), 'Panadería San Juan', 'Venta de mostrador', b, 'GTQ']);
  }

  /* Gastos con paréntesis contables: `(1,250.00)` es un negativo, no un adorno. */
  const gastos: unknown[][] = [['Fecha', 'Proveedor', 'Rubro', 'Importe', 'Moneda']];
  for (let m = 1; m <= 8; m++) {
    const monto = 1250 + m * 30;
    mas('opex', monto);
    gastos.push([
      serial(`2026-${String(m).padStart(2, '0')}-20`),
      'Servicios Generales',
      'Mantenimiento',
      `(${monto.toLocaleString('en-US', { minimumFractionDigits: 2 })})`,
      'GTQ',
    ]);
  }

  return {
    archivo: '03-montos-sucios.xlsx',
    titulo: 'Montos escritos a mano',
    rompe:
      'Cinco formas de escribir el mismo importe en la misma columna (símbolo delante, ' +
      'detrás, coma decimal europea, espacio duro), más cuatro celdas que no son montos ' +
      '(#REF!, #N/A, guion, texto). El riesgo no es perder plata: es INVENTARLA — un ' +
      '"SKU-4567" salía convertido en -4567.',
    hojas: [
      ['Ventas', filas],
      ['Gastos', gastos],
    ],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { Ventas: 'revenue', Gastos: 'opex' } }),
    destinos: { Ventas: 'movimientos:40', Gastos: 'movimientos:8' },
    marcadas: 4,
  };
}

/* ═══════════════════════ 4. DOS TABLAS EN LA MISMA HOJA ═══════════════════════ */

function libroDosTablas(): LibroHostil {
  const { v, mas } = contador();

  /*
   * Ventas arriba, tres filas en blanco, y debajo OTRA tabla con su propio encabezado. Es
   * como escribe una persona que no piensa en hojas separadas, y el encabezado de la segunda
   * queda a mitad de la hoja donde ningún detector lo busca.
   */
  const mezclada: unknown[][] = [['Fecha', 'Cliente', 'Concepto', 'Monto', 'Moneda']];
  for (let m = 1; m <= 6; m++) {
    for (let k = 0; k < 5; k++) {
      const monto = 1500 + m * 80 + k * 20;
      mas('revenue', monto);
      mezclada.push([
        serial(`2026-${String(m).padStart(2, '0')}-${String(3 + k * 4).padStart(2, '0')}`),
        'Óptica Visión Clara',
        'Venta de armazones',
        monto,
        'GTQ',
      ]);
    }
  }
  mezclada.push([], [], []);
  mezclada.push(['Fecha', 'Proveedor', 'Concepto', 'Monto', 'Moneda']);
  for (let m = 1; m <= 6; m++) {
    const monto = 2200 + m * 45;
    // La segunda tabla es de COMPRAS y hoy no hay forma de que el pipeline lo sepa: sus filas
    // quedan bajo el encabezado de la primera. Se declara `cogs` para medir si al menos el
    // dinero llega — perder estas filas dejaría el resultado del período inflado.
    mas('cogs', monto);
    mezclada.push([
      serial(`2026-${String(m).padStart(2, '0')}-25`),
      'Lentes del Norte',
      'Compra de lentes',
      monto,
      'GTQ',
    ]);
  }

  return {
    archivo: '04-dos-tablas-en-una-hoja.xlsx',
    titulo: 'Dos tablas en la misma hoja',
    rompe:
      'Ventas arriba, tres filas en blanco, y debajo una segunda tabla de compras con su ' +
      'propio encabezado a mitad de hoja. Ningún paso del pipeline busca un encabezado que no ' +
      'esté arriba, así que la fila de encabezado de la segunda tabla entra como si fuera un ' +
      'movimiento.',
    hojas: [['Movimientos', mezclada]],
    verdad: v,
    clasificar: ({ fila, columns }) => {
      // El modelo SÍ ve el cambio de tabla: la fila que repite los nombres de columna es un
      // encabezado y lo declara `skip`; las de abajo son compras porque nombran proveedor.
      const texto = fila.map((c) => String(c ?? '').toLowerCase());
      if (texto.includes('fecha') && texto.includes('monto')) return null;
      const esCompra = texto.some((t) => t.includes('compra'));
      const monto = columns.amount === null ? null : asNumeroDeCelda(fila[columns.amount]);
      if (monto === null) return null;
      return { e: 'transaction', t: esCompra ? 'cogs' : 'revenue', c: esCompra ? 'compras' : 'ventas' }; // prettier-ignore
    },
    destinos: { Movimientos: 'movimientos:36' },
  };
}

/* ═══════════════════════ 5. NOMBRES DE MES MAL ESCRITOS ═══════════════════════ */

function libroMesesConTypo(): LibroHostil {
  const { v, mas } = contador();

  const ventas: unknown[][] = [['Fecha', 'Cliente', 'Producto', 'Monto', 'Moneda']];
  for (let m = 1; m <= 8; m++) {
    for (let k = 0; k < 4; k++) {
      const monto = 1800 + m * 55 + k * 30;
      mas('revenue', monto);
      ventas.push([
        serial(`2026-${String(m).padStart(2, '0')}-${String(7 + k * 5).padStart(2, '0')}`),
        'Ferretería Central',
        'Cemento saco 42.5 kg',
        monto,
        'GTQ',
      ]);
    }
  }

  /*
   * Matriz de gastos con los meses MAL ESCRITOS. Es la única fuente de estos gastos: si
   * `mesDeEncabezado` no los reconoce, la hoja no se despivota, se queda sin columna de fecha
   * y desaparece entera — el cliente ve utilidad neta igual a utilidad bruta.
   */
  const MAL = ['Enrero', 'Febrro', 'Marzoo', 'Abrl', 'Mayo', 'Juno', 'Julioo', 'Agosot'];
  const matriz: unknown[][] = [['Concepto', ...MAL, 'Total']];
  for (const [concepto, base] of [
    ['Alquiler de bodega', 4200],
    ['Combustible de reparto', 1350],
    ['Papelería y limpieza', 480],
  ] as [string, number][]) {
    matriz.push([concepto, ...MAL.map(() => base), base * 8]);
    for (let i = 0; i < 8; i++) mas('opex', base);
  }
  matriz.push(['TOTAL', ...MAL.map(() => 6030), 48_240]);

  return {
    archivo: '05-meses-mal-escritos.xlsx',
    titulo: 'Nombres de mes mal escritos',
    rompe:
      'La matriz de gastos tiene los meses escritos a mano y con typos (Enrero, Febrro, ' +
      'Abrl, Agosot). Sin reconocerlos la hoja no se despivota, se queda sin fecha y ' +
      'desaparece: el cliente ve utilidad neta = utilidad bruta, o sea que el producto le ' +
      'dice que operar su negocio no cuesta nada.',
    hojas: [
      ['Ventas', ventas],
      ['Gastos Mensuales', matriz],
    ],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { Ventas: 'revenue', 'Gastos Mensuales': 'opex' } }),
    destinos: { Ventas: 'movimientos:32', 'Gastos Mensuales': 'movimientos:24:despivotada' },
  };
}

/* ═══════════════════════════ 6. FECHAS IMPOSIBLES ═══════════════════════════ */

function libroFechasImposibles(): LibroHostil {
  const { v, mas } = contador();

  const filas: unknown[][] = [['Fecha', 'Cliente', 'Concepto', 'Monto', 'Moneda']];
  /* Ocho formas legítimas de escribir una fecha, todas en la misma columna. */
  const formas: ((iso: string) => unknown)[] = [
    (iso) => serial(iso),
    (iso) => iso,
    (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
    (iso) => `${Number(iso.slice(8))} de ${MES_ES[Number(iso.slice(5, 7)) - 1]} de ${iso.slice(0, 4)}`, // prettier-ignore
    (iso) => `${iso.slice(8)}-${MES_ES[Number(iso.slice(5, 7)) - 1]!.slice(0, 3)}-${iso.slice(2, 4)}`, // prettier-ignore
    (iso) => `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`,
    (iso) => new Date(`${iso}T00:00:00Z`),
    (iso) => `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8)}`,
  ];
  let k = 0;
  for (let m = 1; m <= 8; m++) {
    for (let j = 0; j < 4; j++) {
      const monto = 1100 + m * 35 + j * 12;
      mas('revenue', monto);
      const iso = `2026-${String(m).padStart(2, '0')}-${String(2 + j * 6).padStart(2, '0')}`;
      filas.push([formas[k++ % formas.length]!(iso), 'Librería El Saber', 'Venta', monto, 'GTQ']);
    }
  }
  /* Cuatro fechas que NO existen o no son plausibles: a revisión, nunca inventadas. */
  for (const mala of ['31/02/2026', '2026-13-01', '15/07/1823', 'Sin fecha']) {
    filas.push([mala, 'Librería El Saber', 'Venta', 500, 'GTQ']);
  }

  return {
    archivo: '06-fechas-imposibles.xlsx',
    titulo: 'Ocho formas de fecha y cuatro imposibles',
    rompe:
      'Serial, ISO, DD/MM, español completo, abreviado, con puntos, objeto Date y YYYY/MM/DD ' +
      'en la MISMA columna, más un 31 de febrero, un mes 13, un año 1823 y un "Sin fecha". ' +
      'Leer mal una fecha no borra plata: la MUEVE DE MES, que es peor porque no se ve.',
    hojas: [['Ventas', filas]],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { Ventas: 'revenue' } }),
    destinos: { Ventas: 'movimientos:32' },
    marcadas: 4,
  };
}

/* ═════════════ 7. CABECERA Y DETALLE, MÁS UNA COINCIDENCIA POR AZAR ═════════════ */

function libroCabeceraDetalle(): LibroHostil {
  const { v, mas } = contador();

  /* Órdenes de compra (cabecera) y sus líneas: la MISMA plata a dos granularidades. */
  const cabecera: unknown[][] = [['Fecha', 'No. Orden', 'Proveedor', 'Total', 'Moneda']];
  const detalle: unknown[][] = [['No. Orden', 'Producto', 'Cantidad', 'Precio Unitario', 'Total']];
  for (let i = 0; i < 12; i++) {
    const oc = `OC-2026-${String(100 + i)}`;
    const lineas = [3200 + i * 40, 1800 + i * 25, 950 + i * 15];
    const total = lineas.reduce((a, b) => a + b, 0);
    mas('cogs', total);
    cabecera.push([
      serial(`2026-0${(i % 8) + 1}-${String(5 + (i % 20)).padStart(2, '0')}`),
      oc,
      'Distribuidora Mayorista',
      total,
      'GTQ',
    ]);
    for (const [j, linea] of lineas.entries()) {
      detalle.push([oc, `Artículo ${j + 1}`, 1, linea, linea]);
    }
  }

  /*
   * Y una hoja de gastos que suma EXACTAMENTE lo mismo que las órdenes, por azar. No comparte
   * ninguna llave con ellas, así que no puede declararse duplicado: si se descarta, se pierde
   * la contabilidad real del cliente.
   */
  const totalOC = v.cogs;
  const gastos: unknown[][] = [['Fecha', 'Descripcion', 'Categoria', 'Monto', 'Moneda']];
  const porMes = r2(totalOC / 12);
  for (let m = 1; m <= 12; m++) {
    const monto = m === 12 ? r2(totalOC - porMes * 11) : porMes;
    mas('opex', monto);
    gastos.push([
      serial(`2026-${String(m).padStart(2, '0')}-15`),
      'Servicio de vigilancia',
      'Seguridad',
      monto,
      'GTQ',
    ]);
  }

  return {
    archivo: '07-cabecera-detalle.xlsx',
    titulo: 'Cabecera, detalle y una coincidencia por azar',
    rompe:
      'OrdenesCompra y LineasOC son la misma plata a dos granularidades: procesar las dos ' +
      'duplica las compras. Y la hoja de gastos suma EXACTAMENTE lo mismo por casualidad, sin ' +
      'compartir ninguna llave: descartarla perdería contabilidad real. El dedup tiene que ' +
      'acertar en los dos sentidos a la vez.',
    hojas: [
      ['OrdenesCompra', cabecera],
      ['LineasOC', detalle],
      ['Gastos', gastos],
    ],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { OrdenesCompra: 'cogs', LineasOC: 'cogs', Gastos: 'opex' } }), // prettier-ignore
    destinos: {
      OrdenesCompra: 'movimientos:12',
      LineasOC: 'descartada:duplica',
      Gastos: 'movimientos:12',
    },
  };
}

/* ═══════════════ 8. UN SOLO LIBRO DIARIO CON DEBE Y HABER MEZCLADOS ═══════════════ */

function libroDiario(): LibroHostil {
  const { v, mas } = contador();

  /*
   * Ingresos y egresos en la MISMA hoja, con los egresos en negativo (convención de export
   * muy común) y las fechas en MM/DD/YYYY con días > 12, o sea que solo `mdy` las explica.
   */
  const filas: unknown[][] = [
    ['Fecha', 'Descripcion', 'Contraparte', 'Categoria', 'Monto', 'Moneda'],
  ];
  for (let m = 1; m <= 8; m++) {
    const venta = 5400 + m * 120;
    mas('revenue', venta);
    filas.push([`${String(m).padStart(2, '0')}/17/2026`, 'Depósito por ventas del mes', 'Varios clientes', 'Ventas', venta, 'GTQ']); // prettier-ignore

    const compra = 2300 + m * 60;
    mas('cogs', compra);
    filas.push([`${String(m).padStart(2, '0')}/19/2026`, 'Compra de mercadería', 'Mayorista Xela', 'Mercadería', -compra, 'GTQ']); // prettier-ignore

    const gasto = 1400 + m * 25;
    mas('opex', gasto);
    filas.push([`${String(m).padStart(2, '0')}/28/2026`, 'Pago de planilla', 'Colaboradores', 'Planilla', -gasto, 'GTQ']); // prettier-ignore
  }
  filas.push(['', 'SALDO DEL PERIODO', '', '', 18_420, 'GTQ']);

  return {
    archivo: '08-libro-diario-mezclado.xlsx',
    titulo: 'Un solo libro diario, egresos en negativo',
    rompe:
      'Ingresos, costos y gastos en la misma hoja, los egresos en negativo, y las fechas en ' +
      'MM/DD/YYYY con todos los días arriba de 12 — leerlas como DD/MM da mes 17 y la hoja ' +
      'entera se descarta sin dejar una fila marcada. Es la forma más común de contabilidad ' +
      'de una PYME chica.',
    hojas: [['LibroDiario', filas]],
    verdad: v,
    clasificar: ({ fila, columns }) => {
      const texto = fila.map((c) => String(c ?? '').toUpperCase());
      if (texto.some((t) => t.includes('SALDO'))) return null;
      const cat = String(fila[columns.productCategory ?? -1] ?? '').toLowerCase();
      const t: Tipo = cat.startsWith('venta') ? 'revenue' : cat.startsWith('mercade') ? 'cogs' : 'opex';
      return { e: 'transaction', t, c: cat || 'general' };
    },
    destinos: { LibroDiario: 'movimientos:24' },
  };
}

/* ═════════════════════ 9. HOJAS BASURA ALREDEDOR DE LOS DATOS ═════════════════════ */

function libroHojasBasura(): LibroHostil {
  const { v, mas } = contador();

  const ventas: unknown[][] = [['Fecha', 'Cliente', 'Producto', 'Monto', 'Moneda']];
  for (let m = 1; m <= 8; m++) {
    for (let k = 0; k < 3; k++) {
      const monto = 2400 + m * 65 + k * 18;
      mas('revenue', monto);
      ventas.push([
        serial(`2026-${String(m).padStart(2, '0')}-${String(8 + k * 6).padStart(2, '0')}`),
        'Clínica Dental Sonrisa',
        'Limpieza dental',
        monto,
        'GTQ',
      ]);
    }
  }

  /* Una hoja de 120 columnas: un export de sistema con todo el esquema interno al lado. */
  const anchisima: unknown[][] = [
    Array.from({ length: 120 }, (_, i) => (i === 0 ? 'ID' : `campo_${i}`)),
  ];
  for (let i = 0; i < 10; i++) {
    anchisima.push(Array.from({ length: 120 }, (_, j) => (j === 0 ? `R-${i}` : j * (i + 1))));
  }

  return {
    archivo: '09-hojas-basura.xlsx',
    titulo: 'Hojas basura alrededor de los datos',
    rompe:
      'Una hoja vacía, una con solo un título, una de 120 columnas y una con una sola fila de ' +
      'datos, todas alrededor de la única hoja que importa. Ninguna puede tumbar la carga ni ' +
      'aportar una cifra.',
    hojas: [
      ['(vacía)', []],
      ['Instrucciones', [['Llenar la hoja Ventas y enviar a contabilidad']]],
      ['Ventas', ventas],
      ['Export_Sistema', anchisima],
      ['Notas', [['Fecha', 'Nota'], [serial('2026-03-01'), 'Revisar con el contador']]], // prettier-ignore
    ],
    verdad: v,
    clasificar: dobleDeModelo({ tipos: { Ventas: 'revenue' } }),
    destinos: { Ventas: 'movimientos:24' },
  };
}

/* ══════════ 10. EL MEZCLADOR: MONEDAS, FACTURAS, COBROS E INVENTARIO ══════════ */

function libroMezclador(): LibroHostil {
  const { v, mas } = contador();
  const TASA = 7.7;

  /* Facturación emitida: devenga su ingreso además de la cuenta por cobrar. */
  const facturacion: unknown[][] = [
    ['Fecha Emision', 'No. Documento', 'Cliente', 'Monto', 'Moneda', 'Fecha Vencimiento'],
  ];
  for (let i = 0; i < 20; i++) {
    const usd = i % 3 === 0;
    const monto = usd ? 1200 + i * 40 : 14_000 + i * 300;
    mas('revenue', usd ? r2(monto * TASA) : monto);
    facturacion.push([
      serial(`2026-0${(i % 8) + 1}-${String(4 + (i % 20)).padStart(2, '0')}`),
      `FAC-${1000 + i}`,
      `Cliente ${(i % 5) + 1}`,
      monto,
      usd ? 'USD' : 'GTQ',
      serial(`2026-0${(i % 8) + 1}-28`),
    ]);
  }

  /*
   * Cobros que APUNTAN a esas facturas: es el ESTADO de una venta ya registrada, no una venta
   * nueva. Si producen ingreso, la facturación se cuenta dos veces.
   */
  const cobros: unknown[][] = [['Fecha', 'No. Documento', 'Cliente', 'Monto', 'Moneda']];
  for (let i = 0; i < 12; i++) {
    const usd = i % 3 === 0;
    cobros.push([
      serial(`2026-0${(i % 8) + 1}-28`),
      `FAC-${1000 + i}`,
      `Cliente ${(i % 5) + 1}`,
      usd ? 1200 + i * 40 : 14_000 + i * 300,
      usd ? 'USD' : 'GTQ',
    ]);
  }

  /* Facturas RECIBIDAS: producen su costo además de la cuenta por pagar. */
  const porPagar: unknown[][] = [
    ['Fecha Emision', 'No. Factura', 'Proveedor', 'Monto', 'Moneda', 'Fecha Vencimiento'],
  ];
  for (let i = 0; i < 10; i++) {
    const monto = 6800 + i * 210;
    mas('cogs', monto);
    porPagar.push([
      serial(`2026-0${(i % 8) + 1}-11`),
      `PRV-${500 + i}`,
      `Proveedor ${(i % 4) + 1}`,
      monto,
      'GTQ',
      serial(`2026-0${(i % 8) + 1}-30`),
    ]);
  }

  /* Inventario serializado: no produce movimientos, va a inventario. */
  const inventario: unknown[][] = [
    ['VIN', 'Marca', 'Modelo', 'Anio', 'Costo Adquisicion', 'Fecha Ingreso'],
  ];
  for (let i = 0; i < 15; i++) {
    inventario.push([
      `3VW${String(100000 + i)}`,
      'Toyota',
      'Hilux',
      2025,
      118_000 + i * 900,
      serial('2026-01-15'),
    ]);
  }

  /* Una moneda que NO manejamos: se conserva para que la fila se marque, nunca se renombra. */
  facturacion.push([serial('2026-08-15'), 'FAC-9999', 'Cliente de Madrid', 900, 'EUR', serial('2026-08-30')]); // prettier-ignore

  return {
    archivo: '10-mezclador.xlsx',
    titulo: 'Monedas, facturas, cobros e inventario',
    rompe:
      'Facturación en GTQ y USD que devenga su ingreso, cobros que apuntan a esas MISMAS ' +
      'facturas y no deben devengar de nuevo, cuentas por pagar que sí producen su costo, ' +
      'inventario serializado por VIN que no produce ninguno, y una factura en EUR que no ' +
      'sabemos convertir. Cinco reglas que se contradicen si alguna se aplica de más.',
    hojas: [
      ['Facturacion', facturacion],
      ['Cobros', cobros],
      ['CuentasPorPagar', porPagar],
      ['Inventario', inventario],
    ],
    verdad: v,
    base: 'GTQ',
    tasas: { USD: TASA },
    clasificar: dobleDeModelo({
      tipos: { Facturacion: 'revenue', Cobros: 'revenue', CuentasPorPagar: 'cogs' },
      entidades: { Facturacion: 'invoice', CuentasPorPagar: 'bill' },
    }),
    destinos: {
      Facturacion: 'movimientos:20',
      Cobros: 'movimientos:0',
      CuentasPorPagar: 'movimientos:10',
      Inventario: 'inventario',
    },
    marcadas: 2,
  };
}

export const LIBROS: (() => LibroHostil)[] = [
  libroTypos,
  libroColumnasCorridas,
  libroMontosSucios,
  libroDosTablas,
  libroMesesConTypo,
  libroFechasImposibles,
  libroCabeceraDetalle,
  libroDiario,
  libroHojasBasura,
  libroMezclador,
];
