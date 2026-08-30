import { dobleDeModelo, serial, type LibroHostil, type Verdad } from './pipeline-doble';

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

export const LIBROS: (() => LibroHostil)[] = [
  libroTypos,
  libroColumnasCorridas,
  libroMontosSucios,
];
