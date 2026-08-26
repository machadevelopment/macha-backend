/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * GUIÓN DE QA FUNCIONAL — MÓDULOS 1-6 (segunda pasada)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ejecutable, no una lista para tildar a mano. La primera pasada la corrió el equipo de Macha
 * por formulario el 2026-08-14 y produjo diez defectos; esto re-ejecuta lo que se puede
 * verificar sobre el código desplegado sin tocar la contabilidad de un cliente real.
 *
 * ⚠️ NO SUBE ARCHIVOS A NINGUNA EMPRESA. El ticket lo advierte y con razón: no hay staging, así
 * que un archivo de prueba deja filas reales en el dashboard de alguien y revertirlo es un
 * soft-delete por `document_id`, no un botón. Todo lo de acá corre contra los MÓDULOS, con los
 * archivos reales como entrada, sin escribir en la base.
 *
 * Uso: `bun run qa-modulos.ts`
 */
import * as XLSX from 'xlsx';
import { detectarFilaDeEncabezado } from './src/lib/sheet-header';
import { analizarFormaDeHoja } from './src/lib/sheet-shape';
import {
  canSkipSheet,
  firmaDeCatalogo,
  noPuedeProducirMovimientos,
  pareceLibroDeMovimientos,
} from './src/lib/sheet-classifier';
import { analizarEsquema, esTablaDeEntidades } from './src/lib/sheet-relations';
import { detectarDetalleDuplicado } from './src/lib/sheet-duplication';
import { medirFilas } from './src/lib/reconciliation';
import { asDate, asNumber, type ColumnMap } from './src/lib/row-assembly';
import { CURRENCIES, counterCurrency, resolveFromCatalog } from './src/lib/fx';
import { clientCan } from './src/lib/permissions';
import { TARGET_INDUSTRIES } from './src/config/industries';
import { evaluateFlagReason, CONFIDENCE_THRESHOLD } from './src/lib/staging-rules';

const DESCARGAS = '/Users/kenethruiz/Downloads';

interface Hallazgo {
  modulo: string;
  severidad: 'alta' | 'media' | 'baja';
  detalle: string;
}
const hallazgos: Hallazgo[] = [];
const fallar = (modulo: string, severidad: Hallazgo['severidad'], detalle: string) =>
  hallazgos.push({ modulo, severidad, detalle });

let pasos = 0;
const ok = (msg: string) => {
  pasos++;
  console.log(`   ✓ ${msg}`);
};
const seccion = (t: string) => console.log(`\n${'─'.repeat(88)}\n▸ ${t}\n`);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M2 · INGESTA — el pipeline determinista contra los libros reales de clientes
// ═══════════════════════════════════════════════════════════════════════════════════════════
seccion('M2 · INGESTA — enrutado de hojas y lectura de dinero (16 libros reales)');

/** Los diez del validador de extracción, que declara qué debería mostrar la plataforma. */
const VALIDADOR: {
  archivo: string;
  empresa: string;
  excluidas: string[];
  movimientos: string[];
}[] = [
  {
    archivo: '01_Clinica_Dental_GT.xlsx',
    empresa: 'Clínica Dental',
    excluidas: [],
    movimientos: ['Consultas', 'InsumosMedicos', 'GastosAdmin'],
  },
  {
    archivo: '02_Restaurante_ElFogon.xlsx',
    empresa: 'Restaurante',
    excluidas: ['InventarioInsumos', 'ReporteMensualGastos'],
    movimientos: ['Ventas', 'CostosYGastos'],
  },
  {
    archivo: '03_Ferreteria_Central.xlsx',
    empresa: 'Ferretería',
    excluidas: ['Inventario', 'LineasOrdenCompra'],
    movimientos: ['Ventas', 'GastosOperativos'],
  },
  {
    archivo: '04_BufeteLegal_PazAsociados.xlsx',
    empresa: 'Bufete',
    excluidas: ['Clientes'],
    movimientos: ['Movimientos'],
  },
  {
    archivo: '05_AgenciaMarketing_Impacto.xlsx',
    empresa: 'Agencia',
    excluidas: ['Clientes'],
    movimientos: ['Ingresos', 'Gastos'],
  },
  {
    archivo: '06_TransportesDelNorte.xlsx',
    empresa: 'Transportes',
    excluidas: ['Clientes', 'Rutas', 'Flota'],
    movimientos: ['Fletes', 'GastosOperativos'],
  },
  {
    archivo: '07_Hotel_VistaAlLago.xlsx',
    empresa: 'Hotel',
    excluidas: ['ResumenGerencial'],
    movimientos: ['Ingresos', 'Gastos'],
  },
  {
    archivo: '08_Boutique_Elegance.xlsx',
    empresa: 'Boutique',
    excluidas: ['Inventario'],
    movimientos: ['Libro'],
  },
  {
    archivo: '09_Panaderia_LaEspigaDorada.xlsx',
    empresa: 'Panadería',
    excluidas: [],
    movimientos: ['Ventas', 'GastosYCompras'],
  },
  {
    archivo: '10_Constructora_Horizonte.xlsx',
    empresa: 'Constructora',
    excluidas: [],
    movimientos: ['AvancesDeObra', 'CostosDirectos', 'GastosAdmin'],
  },
];

/** El destino que el pipeline le da a cada hoja de un libro. */
function enrutar(ruta: string, buf: ArrayBuffer): Map<string, string> {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const hojas = new Map<string, { header: unknown[]; rows: unknown[][]; desde: unknown[][] }>();
  for (const n of wb.SheetNames) {
    const todo = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n]!, {
      header: 1,
      raw: true,
      blankrows: false,
    });
    const hi = detectarFilaDeEncabezado(todo);
    hojas.set(n, { header: todo[hi] ?? [], rows: todo.slice(hi + 1), desde: todo.slice(hi) });
  }

  const destino = new Map<string, string>();
  const vivas: { nombre: string; rows: unknown[][] }[] = [];
  for (const [n, h] of hojas) {
    if (firmaDeCatalogo(h.header) === 'existencias') destino.set(n, 'inventario');
    else if (analizarFormaDeHoja(h.desde).esReporte) destino.set(n, 'descartada:reporte');
    else if (canSkipSheet(h.header)) destino.set(n, 'descartada:catalogo');
    else if (noPuedeProducirMovimientos(h.desde, asDate, asNumber))
      destino.set(n, 'descartada:sin fecha+dinero');
    else {
      destino.set(n, 'movimientos');
      vivas.push({ nombre: n, rows: h.rows });
    }
  }
  const esquema = analizarEsquema(vivas);
  for (const { nombre: n } of vivas) {
    if (esTablaDeEntidades(esquema, n) && !pareceLibroDeMovimientos(hojas.get(n)!.header)) {
      destino.set(n, 'inventario');
    }
  }
  for (const [d] of detectarDetalleDuplicado(
    vivas
      .filter((v) => destino.get(v.nombre) === 'movimientos')
      .map((v) => ({ nombre: v.nombre, rows: [hojas.get(v.nombre)!.header, ...v.rows] })),
  )) {
    destino.set(d, 'descartada:duplica');
  }
  void ruta;
  return destino;
}

for (const caso of VALIDADOR) {
  const buf = await Bun.file(`${DESCARGAS}/${caso.archivo}`)
    .arrayBuffer()
    .catch(() => null);
  if (!buf) {
    fallar('M2', 'baja', `no se encontró ${caso.archivo} para re-ejecutar el guión`);
    continue;
  }
  const destino = enrutar(caso.archivo, buf);
  let bien = true;
  for (const e of caso.excluidas) {
    if (destino.get(e) === 'movimientos') {
      fallar('M2', 'alta', `${caso.empresa}: "${e}" debe excluirse y produce movimientos`);
      bien = false;
    }
  }
  for (const m of caso.movimientos) {
    if (destino.get(m) !== 'movimientos') {
      fallar(
        'M2',
        'alta',
        `${caso.empresa}: "${m}" debe producir movimientos y quedó como ${destino.get(m)}`,
      );
      bien = false;
    }
  }
  if (bien) ok(`${caso.empresa}: enrutado de ${destino.size} hojas conforme al validador`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M3a · EL DINERO — contra las cifras que declara el validador de extracción
// ═══════════════════════════════════════════════════════════════════════════════════════════
seccion('M3a · Reconciliación de dinero contra el validador (agosto 2026)');

/*
 * El validador declara qué DEBERÍA mostrar la plataforma por empresa y período. Esto lee las
 * mismas hojas con las mismas funciones del pipeline y compara al quetzal.
 *
 * Se eligió agosto 2026 porque es el período que el validador fija ("Hoy" clavado al 24 de
 * agosto), así que las cifras son comparables sin interpretar nada.
 */
const DINERO: { archivo: string; hoja: string; col: string; esperado: number }[] = [
  { archivo: '03_Ferreteria_Central.xlsx', hoja: 'Ventas', col: 'Total (Q)', esperado: 19_511 },
  {
    archivo: '06_TransportesDelNorte.xlsx',
    hoja: 'Fletes',
    col: 'Monto Flete (Q)',
    esperado: 62_538,
  },
  {
    archivo: '10_Constructora_Horizonte.xlsx',
    hoja: 'AvancesDeObra',
    col: 'Monto Facturado (USD)',
    esperado: 160_874,
  },
  {
    archivo: '05_AgenciaMarketing_Impacto.xlsx',
    hoja: 'Ingresos',
    col: 'Monto',
    esperado: 38_897,
  },
];

const MAPA_VACIO: ColumnMap = {
  date: null,
  amount: null,
  currency: null,
  description: null,
  counterparty: null,
  product: null,
  quantity: null,
  productCategory: null,
  store: null,
  dueDate: null,
  costTotal: null,
  costUnit: null,
};

for (const caso of DINERO) {
  const buf = await Bun.file(`${DESCARGAS}/${caso.archivo}`)
    .arrayBuffer()
    .catch(() => null);
  if (!buf) continue;
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const todo = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[caso.hoja]!, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  const hi = detectarFilaDeEncabezado(todo);
  const hdr = (todo[hi] ?? []).map((c) => String(c ?? ''));
  const iM = hdr.indexOf(caso.col);
  const iF = hdr.findIndex((h) => h.toLowerCase().includes('fecha'));
  if (iM === -1 || iF === -1) {
    fallar('M3', 'alta', `${caso.hoja}: no se encontró la columna "${caso.col}" o la de fecha`);
    continue;
  }

  // Solo agosto 2026, que es el período del validador.
  const deAgosto = todo.slice(hi + 1).filter((f) => {
    const d = asDate(f[iF]);
    return d !== null && d >= '2026-08-01' && d <= '2026-08-31';
  });
  const med = medirFilas(deAgosto, { ...MAPA_VACIO, date: iF, amount: iM }, 'GTQ');
  const total = Math.round(med.montos.reduce((sum, m) => sum + m.total, 0));

  if (total !== caso.esperado) {
    fallar(
      'M3',
      'alta',
      `${caso.hoja} en agosto: leí ${total.toLocaleString('es-GT')} y el validador declara ` +
        `${caso.esperado.toLocaleString('es-GT')}`,
    );
  } else {
    ok(`${caso.hoja}: ${total.toLocaleString('es-GT')} en ${deAgosto.length} filas de agosto`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M2b · Los lectores no inventan datos (defectos de la primera pasada)
// ═══════════════════════════════════════════════════════════════════════════════════════════
seccion('M2b · Lectura de fechas y montos');

const FECHAS_OK: [string, string][] = [
  ['01/05/2025', '2025-05-01'],
  ['25/09/2025', '2025-09-25'],
  ['2025-05-01', '2025-05-01'],
];
for (const [entrada, esperado] of FECHAS_OK) {
  if (asDate(entrada) !== esperado) {
    fallar('M2', 'alta', `asDate("${entrada}") = ${asDate(entrada)}, se esperaba ${esperado}`);
  }
}
ok('las fechas guatemaltecas (DD/MM) se leen en su mes');

for (const codigo of ['CLI-0001', 'SKU-4567', 'PRY-002', 'Zona 10']) {
  if (asDate(codigo) !== null) fallar('M2', 'alta', `asDate("${codigo}") inventó una fecha`);
  if (asNumber(codigo) !== null) fallar('M2', 'alta', `asNumber("${codigo}") inventó un monto`);
}
ok('un código de catálogo no se convierte en fecha ni en monto');

const MONTOS: [string, number][] = [
  ['Q 1,234.56', 1234.56],
  ['US$ 1,234.56', 1234.56],
  ['1.234,56', 1234.56],
  ['(1,234.56)', -1234.56],
];
for (const [entrada, esperado] of MONTOS) {
  if (asNumber(entrada) !== esperado) {
    fallar('M2', 'media', `asNumber("${entrada}") = ${asNumber(entrada)}, se esperaba ${esperado}`);
  }
}
ok('la decoración de moneda de un archivo real se lee');

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M2c · Ninguna fila mala llega a la contabilidad
// ═══════════════════════════════════════════════════════════════════════════════════════════
seccion('M2c · `staging-rules` detiene lo que no puede entrar');

const filaBase = {
  targetEntity: 'transaction' as const,
  confidence: 0.95,
  payload: {
    type: 'revenue',
    category: 'ventas',
    date: '2026-03-10',
    originalAmount: 100,
    originalCurrency: 'GTQ',
  },
};
if (evaluateFlagReason(filaBase as never) !== null) {
  fallar('M2', 'alta', 'una fila válida se está marcando');
}
ok('una fila válida pasa');

const MALAS: [string, unknown][] = [
  [
    'sin fecha (el renglón de TOTAL)',
    { ...filaBase, payload: { ...filaBase.payload, date: null } },
  ],
  // El monto NEGATIVO no va acá: hay un test que fija que se acepta a propósito
  // ("cogs/opex can be recorded as negative"). Lo que sí es un hallazgo —la contradicción
  // entre las tres piezas que tratan el signo— se registra en el bloque de abajo.
  ['monto cero', { ...filaBase, payload: { ...filaBase.payload, originalAmount: 0 } }],
  ['sin categoría', { ...filaBase, payload: { ...filaBase.payload, category: null } }],
  ['confianza baja', { ...filaBase, confidence: CONFIDENCE_THRESHOLD - 0.01 }],
];
for (const [nombre, fila] of MALAS) {
  if (evaluateFlagReason(fila as never) === null) {
    fallar('M2', 'alta', `una fila con ${nombre} NO se marca y entraría a la contabilidad`);
  }
}
ok('se marcan tres de las cuatro formas de fila inválida (fecha, categoría, confianza)');

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEFECTO REGISTRADO, NO ARREGLADO: EL SIGNO DEL MONTO TIENE TRES COMPORTAMIENTOS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * No se toca porque las tres piezas están documentadas y se contradicen entre ellas — elegir
 * una es una decisión de producto, no de QA. Medido:
 *
 *   1. `assemblePayload` DESTRUYE el signo (`Math.abs`), porque "la dirección la lleva `type`".
 *   2. `staging-rules` para `transaction` ACEPTA negativos, y hay un test que lo fija:
 *      "a negative amount is valid (cogs/opex can be recorded as negative)".
 *   3. `staging-rules` para `invoice`/`bill` los RECHAZA (`invalid_amount`).
 *
 * La consecuencia práctica, y es lo que importa: **una nota de crédito o una devolución que el
 * cliente trae en negativo se registra como un COSTO en positivo.** En vez de reducir sus
 * costos, se los aumenta. La comprobación de (2) no puede dispararse nunca por el camino
 * normal, porque (1) ya convirtió el número antes de llegar.
 *
 * Y `row-assembly.ts` afirma por escrito que "`staging-rules` exige positivo en las DOS formas
 * de payload", que es lo único de las cuatro afirmaciones que es falso hoy.
 *
 * Decisión pendiente: ¿una devolución reduce el costo (conservar el signo) o es un movimiento
 * aparte? Hasta que se conteste, esto queda medido y visible en vez de arreglado a ciegas.
 */
{
  const negativa = { ...filaBase, payload: { ...filaBase.payload, originalAmount: -500 } };
  const comoTransaccion = evaluateFlagReason(negativa as never);
  const comoFactura = evaluateFlagReason({
    targetEntity: 'bill',
    confidence: 0.95,
    payload: {
      counterparty: 'Proveedor',
      issueDate: '2026-03-10',
      originalAmount: -500,
      originalCurrency: 'GTQ',
    },
  } as never);
  if (comoTransaccion === null && comoFactura !== null) {
    fallar(
      'M2',
      'media',
      'un monto negativo pasa como transacción y se marca como factura; y `assemblePayload` ' +
        'le quita el signo antes, así que una devolución se cuenta como costo. Ver el bloque.',
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M3 · DOS MONEDAS (criterio corregido del ticket: GTQ y USD, no tres)
// ═══════════════════════════════════════════════════════════════════════════════════════════
seccion('M3 · Dos monedas — GTQ y USD');

if (CURRENCIES.length !== 2 || !CURRENCIES.includes('GTQ') || !CURRENCIES.includes('USD')) {
  fallar('M3', 'alta', `el producto declara ${CURRENCIES.join('/')}, se esperaba GTQ y USD`);
}
ok(`el producto soporta exactamente ${CURRENCIES.join(' y ')}`);

if (counterCurrency('GTQ') !== 'USD' || counterCurrency('USD') !== 'GTQ') {
  fallar('M3', 'alta', 'la moneda del par no se calcula bien');
}
ok('el par se resuelve en las dos direcciones');

/*
 * La tasa de una fecha se resuelve con la vigente EN o ANTES de esa fecha: una tasa registrada
 * después no puede aplicarse hacia atrás. Es la garantía que desbloqueó el ticket del tipo de
 * cambio, y acá se comprueba sobre el resolvedor.
 */
// El catálogo va DESCENDENTE, como lo devuelve `loadFxCatalog`. La primera versión de este
// guión lo pasaba ascendente y "encontró" dos defectos que eran del guión.
const catalogo = [
  { rate: 8.5, effectiveDate: '2026-06-01' },
  { rate: 7.7, effectiveDate: '2026-01-01' },
];
const marzo = resolveFromCatalog(catalogo, '2026-03-10');
const julio = resolveFromCatalog(catalogo, '2026-07-10');
if (marzo?.rate !== 7.7) fallar('M3', 'alta', `marzo resolvió ${marzo?.rate}, se esperaba 7.7`);
if (julio?.rate !== 8.5) fallar('M3', 'alta', `julio resolvió ${julio?.rate}, se esperaba 8.5`);
ok('la tasa de una fecha es la vigente en o antes de ella, nunca una posterior');

/*
 * Una fecha ANTERIOR a toda tasa cae a la más antigua disponible, y eso es DELIBERADO
 * (decisión del 2026-08-07, documentada en `resolveFromCatalog`): registrar una tasa
 * cualquiera alcanza para que el archivo entero se convierta, en vez de obligar al cliente a
 * retrofechar hasta su movimiento más viejo. Se comprueba que siga siendo así, no lo contrario.
 */
const antes = resolveFromCatalog(catalogo, '2025-12-31');
if (antes?.rate !== 7.7) {
  fallar('M3', 'alta', `una fecha previa a toda tasa dio ${antes?.rate}, se esperaba caer a 7.7`);
}
ok('una fecha previa a toda tasa cae a la más antigua (decisión 2026-08-07), no se marca');

// ═══════════════════════════════════════════════════════════════════════════════════════════
// M6 · ADMIN Y PERMISOS
// ═══════════════════════════════════════════════════════════════════════════════════════════
seccion('M6 · Permisos por rol');

const MATRIZ: [Parameters<typeof clientCan>[0], Parameters<typeof clientCan>[1], boolean][] = [
  ['owner', 'billing', true],
  ['admin', 'billing', false],
  ['member', 'billing', false],
  ['owner', 'manage_members', true],
  ['admin', 'manage_members', false],
  ['owner', 'manage_fx_rate', true],
  ['admin', 'manage_fx_rate', true],
  ['member', 'manage_fx_rate', false],
  ['member', 'upload_excel', true],
  ['member', 'revert_upload', false],
  ['member', 'view_dashboard_reports', true],
];
for (const [rol, cap, esperado] of MATRIZ) {
  if (clientCan(rol, cap) !== esperado) {
    fallar('M6', 'alta', `${rol} + ${cap} = ${clientCan(rol, cap)}, se esperaba ${esperado}`);
  }
}
ok(`la matriz de permisos responde a las ${MATRIZ.length} combinaciones probadas`);

if (TARGET_INDUSTRIES.length !== 28) {
  fallar('M6', 'media', `hay ${TARGET_INDUSTRIES.length} industrias, Jose entregó 28`);
}
if (!TARGET_INDUSTRIES.includes('retail')) {
  fallar(
    'M6',
    'alta',
    '`retail` no está: las empresas ya guardadas con ese valor pierden plantilla',
  );
}
ok(`las ${TARGET_INDUSTRIES.length} industrias de Jose están, con \`retail\` conservado`);

// ═══════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(88)}\n`);
console.log(`  ${pasos} comprobaciones ejecutadas.\n`);
if (hallazgos.length === 0) {
  console.log('  ✓ sin defectos\n');
} else {
  const orden = { alta: 0, media: 1, baja: 2 } as const;
  hallazgos.sort((a, b) => orden[a.severidad] - orden[b.severidad]);
  console.log(`  ${hallazgos.length} DEFECTO(S):\n`);
  for (const h of hallazgos) {
    console.log(`    [${h.severidad.toUpperCase()}] ${h.modulo} · ${h.detalle}`);
  }
  console.log('');
  process.exitCode = 1;
}
