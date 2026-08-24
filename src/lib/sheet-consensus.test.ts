import { describe, expect, test } from 'bun:test';
import {
  ConfianzaPorHoja,
  CanonizadorDeCategorias,
  ConsensoDeHoja,
  MAX_SKIP_EN_SONDA,
  SONDA_LOTES,
  SONDA_MIN_FILAS,
  UMBRAL_HOMOGENEIDAD,
  conceptoDeCategoria,
  elegirSonda,
  filaAptaParaCortocircuito,
  sonElMismoConcepto,
} from './sheet-consensus';
import type { ColumnMap } from './row-assembly';

/**
 * ═══ LOS DATOS DE ESTE ARCHIVO SON REALES ═══
 *
 * Todo lo que se afirma acá está tomado de la carga de `CasaViva_Registro_Operaciones_2025-2026
 * .xlsx` (House Products, documento `055d9a75-64b4-49f8-a391-3834346a4d67`, 2026-08-18): el mapa
 * de columnas es el que producción infirió y guardó en `company_column_profiles`, las filas son
 * filas del archivo, y las distribuciones de veredictos son las que devolvió el modelo, leídas
 * de `staging_rows`.
 *
 * Es la misma decisión que justifica `corpus-hojas-reales.test.ts`: un fixture inventado por
 * quien escribe el código comparte sus mismos puntos ciegos. Acá importaba especialmente porque
 * lo que se está probando es un ahorro que se activa SOLO con datos muy uniformes, y es fácil
 * escribir un caso sintético tan limpio que pase siempre.
 */

/** El mapa que producción infirió para `Ventas` (`company_column_profiles`, v1, `inferido`). */
const MAPA_VENTAS: ColumnMap = {
  date: 1,
  amount: 9,
  currency: null,
  description: 4,
  counterparty: 13,
  product: 4,
  quantity: 6,
  productCategory: 5,
  store: null,
  dueDate: null,
  costTotal: 11,
  costUnit: 10,
};

/** Filas reales de la hoja `Ventas`, con su ancho completo. */
const FILAS_VENTAS: unknown[][] = [
  [
    'V-2025-00001',
    45658,
    'Miércoles',
    'COC-005',
    'Tabla de cortar de bambú',
    'Cocina',
    3,
    55,
    0,
    165,
    28,
    84,
    'Tarjeta de Crédito',
    'Consumidor Final',
    'Tienda Física',
    'Mynor Solís',
    1,
  ],
  [
    'V-2025-00002',
    45658,
    'Miércoles',
    'ELE-007',
    'Aspiradora vertical 1200W',
    'Electrodomésticos',
    1,
    829,
    0,
    829,
    480,
    480,
    'Transferencia Bancaria',
    'Consumidor Final',
    'Tienda Física',
    'Byron Estuardo Chávez',
    1,
  ],
  [
    'V-2025-00002',
    45658,
    'Miércoles',
    'SAL-001',
    'Alfombra para sala 200x300cm',
    'Sala y Decoración',
    2,
    649,
    0,
    1298,
    380,
    760,
    'Transferencia Bancaria',
    'Consumidor Final',
    'Tienda Física',
    'Byron Estuardo Chávez',
    0,
  ],
];

/** Un lote de `n` veredictos idénticos, como los que devolvió el modelo en `Ventas`. */
function loteUniforme(n: number, categoria: string, cf = 0.95) {
  return Array.from({ length: n }, () => ({
    e: 'transaction',
    t: 'revenue' as const,
    c: categoria,
    cf,
  }));
}

describe('conceptoDeCategoria / sonElMismoConcepto', () => {
  /**
   * EL CASO QUE MOTIVA TODO ESTO. Los tres nombres salieron del MISMO archivo, sobre filas
   * indistinguibles de la misma hoja: `sales` (17.763 filas), `ventas` (88) y `product_sales`
   * (88). Los dos 88 son exactamente el tamaño de lote de esa corrida — o sea que no fueron
   * filas distintas, fueron LOTES distintos bautizando lo mismo.
   */
  test('unifica los tres nombres que producción devolvió para el mismo concepto', () => {
    expect(sonElMismoConcepto('sales', 'ventas')).toBe(true);
    expect(sonElMismoConcepto('sales', 'product_sales')).toBe(true);
    expect(sonElMismoConcepto('ventas', 'product_sales')).toBe(true);
  });

  test('unifica el par ES/EN de costo de mercadería que apareció en Compras_CMV', () => {
    // `merchandise` (439 filas) y `compra_mercaderia` (69) convivieron en la misma hoja.
    expect(sonElMismoConcepto('merchandise', 'mercaderia')).toBe(true);
  });

  test('no toca el orden de las palabras ni los plurales', () => {
    expect(sonElMismoConcepto('costo_de_ventas', 'ventas_costo')).toBe(true);
    expect(sonElMismoConcepto('bank_fees', 'bank_fee')).toBe(true);
  });

  /**
   * EL LADO QUE IMPORTA MÁS: `Gastos_Operativos` del mismo archivo trae 13 categorías, TODAS
   * `transaction`/`opex`. Si el canonizador las colapsara, el cliente perdería la única cosa
   * que hace útil su pantalla de gastos.
   */
  test('NO unifica categorías de gasto que son genuinamente distintas', () => {
    const reales = [
      'payroll',
      'rent',
      'utilities',
      'taxes',
      'marketing',
      'insurance',
      'maintenance',
      'bank_fees',
      'office_supplies',
      'transport_fuel',
      'municipal_taxes',
      'utilities_water',
      'electricity',
    ];
    const conceptos = new Set(reales.map(conceptoDeCategoria));
    // 13 categorías reales → 13 conceptos. Ni uno se colapsa con otro.
    expect(conceptos.size).toBe(reales.length);
  });

  test('una categoría de puras palabras genéricas no se une a otra igual de vacía', () => {
    // Sin la salvaguarda, ambas normalizarían a la cadena vacía y quedarían unificadas.
    expect(sonElMismoConcepto('total_general', 'monto_total')).toBe(false);
  });
});

describe('CanonizadorDeCategorias', () => {
  test('el primer nombre que usó la hoja es el que se conserva', () => {
    const c = new CanonizadorDeCategorias();
    expect(c.canonizar('Ventas', 'transaction', 'revenue', 'sales')).toBe('sales');
    expect(c.canonizar('Ventas', 'transaction', 'revenue', 'ventas')).toBe('sales');
    expect(c.canonizar('Ventas', 'transaction', 'revenue', 'product_sales')).toBe('sales');
    expect(c.nombresUnificados).toBe(2);
  });

  test('si la hoja arranca en español, se queda en español', () => {
    // El nombre que ve el cliente sale de SU archivo, no de la tabla de lemas.
    const c = new CanonizadorDeCategorias();
    expect(c.canonizar('Ventas', 'transaction', 'revenue', 'ventas')).toBe('ventas');
    expect(c.canonizar('Ventas', 'transaction', 'revenue', 'sales')).toBe('ventas');
  });

  test('no unifica entre hojas distintas', () => {
    const c = new CanonizadorDeCategorias();
    expect(c.canonizar('Ventas', 'transaction', 'revenue', 'sales')).toBe('sales');
    expect(c.canonizar('Otra', 'transaction', 'revenue', 'ventas')).toBe('ventas');
  });

  test('no unifica entre tipos contables distintos', () => {
    // Un `costo_de_ventas` que es `cogs` y uno que es `opex` son dos hechos distintos.
    const c = new CanonizadorDeCategorias();
    expect(c.canonizar('H', 'transaction', 'cogs', 'costo_de_ventas')).toBe('costo_de_ventas');
    expect(c.canonizar('H', 'transaction', 'opex', 'costos_ventas')).toBe('costos_ventas');
  });

  test('nunca inventa un nombre: sin precedente, devuelve el que le dieron', () => {
    const c = new CanonizadorDeCategorias();
    expect(c.canonizar('H', 'transaction', 'opex', 'licencias_software')).toBe(
      'licencias_software',
    );
    expect(c.nombresUnificados).toBe(0);
  });

  test('null y cadena vacía no participan', () => {
    const c = new CanonizadorDeCategorias();
    expect(c.canonizar('H', 'transaction', 'revenue', null)).toBeNull();
    expect(c.canonizar('H', 'transaction', 'revenue', '   ')).toBeNull();
  });
});

describe('ConsensoDeHoja — la hoja Ventas del archivo real', () => {
  /**
   * El caso que paga por todo: 205 de las 216 llamadas del archivo fueron esta hoja, y las
   * 18.034 filas volvieron `transaction`/`revenue` sin una sola excepción.
   */
  test('con tres lotes uniformes hay consenso y hereda la confianza del modelo', () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) c.registrarLote(loteUniforme(57, 'sales', 0.95));

    const d = c.decidir(MAPA_VENTAS);
    expect(d.homogenea).toBe(true);
    if (!d.homogenea) throw new Error('inalcanzable');
    expect(d.veredicto.targetEntity).toBe('transaction');
    expect(d.veredicto.type).toBe('revenue');
    expect(d.veredicto.category).toBe('sales');
    // Heredada, no inventada: `staging-rules` lee este número para decidir revisión, y 0,95
    // está por encima de `CONFIDENCE_THRESHOLD`, así que las filas promueven.
    expect(d.veredicto.confidence).toBeCloseTo(0.95, 5);
  });

  test('un solo lote NUNCA alcanza para decidir, por uniforme que sea', () => {
    const c = new ConsensoDeHoja();
    c.registrarLote(loteUniforme(500, 'sales'));
    const d = c.decidir(MAPA_VENTAS);
    expect(d.homogenea).toBe(false);
    if (d.homogenea) throw new Error('inalcanzable');
    expect(d.motivo).toContain('1 lote');
  });

  test('tres lotes cortos tampoco: pocas filas es coincidencia, no patrón', () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) c.registrarLote(loteUniforme(4, 'sales'));
    const d = c.decidir(MAPA_VENTAS);
    expect(d.homogenea).toBe(false);
    if (d.homogenea) throw new Error('inalcanzable');
    expect(d.motivo).toContain('filas observadas');
  });

  test('la canonicalización es lo que HABILITA el consenso', () => {
    /*
     * Sin unificar los nombres, los tres lotes reales de `Ventas` habrían contado como tres
     * veredictos distintos —`sales`, `ventas`, `product_sales`— y ninguno habría llegado al
     * 98 %. O sea que las dos funcionalidades no son independientes: la de datos habilita la
     * de costo.
     */
    const sinUnificar = new ConsensoDeHoja();
    sinUnificar.registrarLote(loteUniforme(57, 'sales'));
    sinUnificar.registrarLote(loteUniforme(57, 'ventas'));
    sinUnificar.registrarLote(loteUniforme(57, 'product_sales'));
    expect(sinUnificar.decidir(MAPA_VENTAS).homogenea).toBe(false);

    const canon = new CanonizadorDeCategorias();
    const unificado = new ConsensoDeHoja();
    for (const nombre of ['sales', 'ventas', 'product_sales']) {
      unificado.registrarLote(
        loteUniforme(57, canon.canonizar('Ventas', 'transaction', 'revenue', nombre)!),
      );
    }
    expect(unificado.decidir(MAPA_VENTAS).homogenea).toBe(true);
  });
});

describe('ConsensoDeHoja — las hojas que NO deben cortocircuitar', () => {
  /**
   * `Gastos_Operativos`, 260 filas, 13 categorías, la más frecuente cubre ~11 %. Acá cada fila
   * sí requiere criterio y el modelo tiene que verlas todas.
   */
  test('la distribución real de Gastos_Operativos no alcanza consenso', () => {
    const reales: [string, number][] = [
      ['payroll', 29],
      ['bank_fees', 20],
      ['office_supplies', 20],
      ['marketing', 20],
      ['insurance', 20],
      ['rent', 20],
      ['transport_fuel', 14],
      ['municipal_taxes', 13],
      ['maintenance', 13],
      ['utilities', 13],
      ['utilities_water', 7],
      ['electricity', 7],
      ['taxes', 7],
    ];
    const mapa: ColumnMap = { ...MAPA_VENTAS, date: 0, amount: 4 };
    const c = new ConsensoDeHoja();
    // Se reparten en tres lotes para que la sonda sí se complete: lo que falla es la
    // homogeneidad, no el conteo de lotes.
    for (let i = 0; i < SONDA_LOTES; i++) {
      c.registrarLote(
        reales.flatMap(([cat, n]) =>
          Array.from({ length: n }, () => ({
            e: 'transaction',
            t: 'opex' as const,
            c: cat,
            cf: 0.92,
          })),
        ),
      );
    }
    const d = c.decidir(mapa);
    expect(d.homogenea).toBe(false);
    if (d.homogenea) throw new Error('inalcanzable');
    expect(d.motivo).toContain('% de las filas');
  });

  test('sin columna de fecha no se cortocircuita — es el caso real de Nomina', () => {
    // `Nomina` quedó con `date: null` en su perfil: sin fecha no hay forma de distinguir un
    // movimiento de un subtotal, y el candado por fila no podría correr.
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) c.registrarLote(loteUniforme(57, 'payroll'));
    const d = c.decidir({ ...MAPA_VENTAS, date: null });
    expect(d.homogenea).toBe(false);
    if (d.homogenea) throw new Error('inalcanzable');
    expect(d.motivo).toContain('fecha y monto');
  });

  test('sin columna de monto tampoco — es el caso real de Portada', () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) c.registrarLote(loteUniforme(57, 'sales'));
    expect(c.decidir({ ...MAPA_VENTAS, amount: null }).homogenea).toBe(false);
  });

  /**
   * Una hoja con subtotales intercalados tiene estructura que el cortocircuito no puede leer.
   * Es el modo de fallo caro: aplicarle "venta" a un renglón de subtotal le suma al cliente un
   * ingreso que no existe.
   */
  test('demasiadas filas que no son datos aborta el consenso', () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) {
      const lote = loteUniforme(50, 'sales');
      // 10 de 60 filas son subtotales: muy por encima del 2 % tolerado.
      c.registrarLote([
        ...lote,
        ...Array.from({ length: 10 }, () => ({ e: 'skip', t: null, c: null, cf: 0 })),
      ]);
    }
    const d = c.decidir(MAPA_VENTAS);
    expect(d.homogenea).toBe(false);
    if (d.homogenea) throw new Error('inalcanzable');
    expect(d.motivo).toContain('no son datos');
  });

  test('una hoja de puros subtotales no produce veredicto', () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) {
      c.registrarLote(Array.from({ length: 50 }, () => ({ e: 'skip', t: null, c: null, cf: 0 })));
    }
    expect(c.decidir(MAPA_VENTAS).homogenea).toBe(false);
  });

  test('mezcla de entidades destino no alcanza consenso', () => {
    // Una hoja con ventas Y cuentas por cobrar mezcladas: el modelo tiene que ver cada fila.
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) {
      c.registrarLote([
        ...loteUniforme(30, 'sales'),
        ...Array.from({ length: 30 }, () => ({
          e: 'invoice',
          t: null,
          c: 'cuentas_por_cobrar',
          cf: 0.9,
        })),
      ]);
    }
    expect(c.decidir(MAPA_VENTAS).homogenea).toBe(false);
  });
});

describe('ConsensoDeHoja — el borde del umbral', () => {
  test(`una rareza aislada no desactiva el ahorro (por encima del ${Math.round(UMBRAL_HOMOGENEIDAD * 100)} %)`, () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) {
      // 99 de 100 filas coinciden: una devolución suelta en una hoja de 18.000 filas no puede
      // costar el ahorro completo.
      c.registrarLote([
        ...loteUniforme(99, 'sales'),
        { e: 'transaction', t: 'other' as const, c: 'devolucion', cf: 0.8 },
      ]);
    }
    expect(c.decidir(MAPA_VENTAS).homogenea).toBe(true);
  });

  test('un 10 % de filas distintas SÍ lo desactiva', () => {
    const c = new ConsensoDeHoja();
    for (let i = 0; i < SONDA_LOTES; i++) {
      c.registrarLote([
        ...loteUniforme(90, 'sales'),
        ...Array.from({ length: 10 }, () => ({
          e: 'transaction',
          t: 'other' as const,
          c: 'devolucion',
          cf: 0.8,
        })),
      ]);
    }
    // 1.800 movimientos clasificados por inercia en una hoja de 18.000 es demasiado.
    expect(c.decidir(MAPA_VENTAS).homogenea).toBe(false);
  });

  test('los umbrales son los documentados', () => {
    // Bajarlos es una decisión de producto, no un ajuste: si alguien los mueve, este test lo
    // pone frente a la conversación en vez de dejarlo pasar como refactor.
    expect(SONDA_LOTES).toBe(3);
    expect(SONDA_MIN_FILAS).toBe(120);
    expect(UMBRAL_HOMOGENEIDAD).toBe(0.98);
    expect(MAX_SKIP_EN_SONDA).toBe(0.02);
  });
});

describe('elegirSonda', () => {
  /**
   * El punto ciego que esto cierra: las hojas vienen ordenadas por fecha y el cierre de tabla
   * está al FINAL. Una sonda de "los primeros tres" nunca ve el renglón de TOTAL, así que el
   * tope de `skip` mediría ruido estructural justo donde el ruido no está.
   */
  test('incluye el primer y el ÚLTIMO lote de la hoja', () => {
    const idx = elegirSonda(201);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(200);
  });

  test('los reparte en vez de amontonarlos al principio', () => {
    expect(elegirSonda(201)).toEqual([0, 100, 200]);
    expect(elegirSonda(6)).toEqual([0, 3, 5]);
  });

  test('una hoja con menos lotes que la sonda va entera', () => {
    expect(elegirSonda(1)).toEqual([0]);
    expect(elegirSonda(2)).toEqual([0, 1]);
    expect(elegirSonda(3)).toEqual([0, 1, 2]);
  });

  test('nunca devuelve menos lotes de los pedidos ni repite', () => {
    // `decidir` cuenta lotes para decidir, así que una sonda corta por redondeo denegaría el
    // consenso por el motivo equivocado.
    for (let total = 1; total <= 60; total++) {
      const idx = elegirSonda(total);
      expect(idx.length).toBe(Math.min(total, SONDA_LOTES));
      expect(new Set(idx).size).toBe(idx.length);
      expect(idx.every((i) => i >= 0 && i < total)).toBe(true);
    }
  });

  test('un cierre de tabla en el último lote deniega el consenso', () => {
    /*
     * La prueba de que la sonda repartida sirve: mismos tres lotes de muestra, pero el último
     * de la hoja trae los subtotales. Con la sonda vieja (los primeros tres) no se veían.
     */
    const c = new ConsensoDeHoja();
    c.registrarLote(loteUniforme(90, 'sales'));
    c.registrarLote(loteUniforme(90, 'sales'));
    c.registrarLote([
      ...loteUniforme(70, 'sales'),
      ...Array.from({ length: 20 }, () => ({ e: 'skip', t: null, c: null, cf: 0 })),
    ]);
    const d = c.decidir(MAPA_VENTAS);
    expect(d.homogenea).toBe(false);
    if (d.homogenea) throw new Error('inalcanzable');
    expect(d.motivo).toContain('no son datos');
  });
});

describe('filaAptaParaCortocircuito', () => {
  test('las filas reales de Ventas pasan las tres', () => {
    for (const fila of FILAS_VENTAS) {
      expect(filaAptaParaCortocircuito(fila, MAPA_VENTAS)).toBe(true);
    }
  });

  /**
   * EL CANDADO QUE IMPORTA. Un Excel de PYME cierra su tabla con un renglón de TOTAL: no tiene
   * fecha, y si el cortocircuito le aplicara el veredicto de venta le sumaría al cliente un
   * ingreso que no existe — con dato plausible y sin un solo error.
   */
  test('un renglón de TOTAL sin fecha no pasa', () => {
    const total: unknown[] = new Array(17).fill(null);
    total[0] = 'TOTAL';
    total[9] = 7850592.736; // el total real del archivo
    expect(filaAptaParaCortocircuito(total, MAPA_VENTAS)).toBe(false);
  });

  test('un título de sección no pasa', () => {
    const titulo: unknown[] = new Array(17).fill(null);
    titulo[0] = 'VENTAS DE ENERO';
    expect(filaAptaParaCortocircuito(titulo, MAPA_VENTAS)).toBe(false);
  });

  test('monto cero no pasa: staging-rules lo marcaría igual', () => {
    const fila = [...FILAS_VENTAS[0]!];
    fila[9] = 0;
    expect(filaAptaParaCortocircuito(fila, MAPA_VENTAS)).toBe(false);
  });

  test('monto no numérico no pasa', () => {
    const fila = [...FILAS_VENTAS[0]!];
    fila[9] = 'n/d';
    expect(filaAptaParaCortocircuito(fila, MAPA_VENTAS)).toBe(false);
  });

  test('acepta el monto con separadores y moneda, como lo escribe una PYME', () => {
    const fila = [...FILAS_VENTAS[0]!];
    fila[9] = 'Q 1,234.50';
    expect(filaAptaParaCortocircuito(fila, MAPA_VENTAS)).toBe(true);
  });

  test('una fecha fuera del rango de plausibilidad no pasa', () => {
    // 999 como serial de Excel es 1902: `asDate` lo rechaza para que un MONTO en la columna
    // equivocada no se convierta en una fecha creíble.
    const fila = [...FILAS_VENTAS[0]!];
    fila[1] = 999;
    expect(filaAptaParaCortocircuito(fila, MAPA_VENTAS)).toBe(false);
  });

  test('sin mapa de fecha o monto, ninguna fila es apta', () => {
    expect(filaAptaParaCortocircuito(FILAS_VENTAS[0]!, { ...MAPA_VENTAS, date: null })).toBe(false);
    expect(filaAptaParaCortocircuito(FILAS_VENTAS[0]!, { ...MAPA_VENTAS, amount: null })).toBe(
      false,
    );
  });
});

/**
 * ═══ LOS TRES LOTES DE `Ventas` DE CarsGT (2026-08-24) ═══
 *
 * 240 filas indistinguibles entre sí, tres lotes, tres confianzas exactas y uniformes:
 * 0,92 · 0,75 · 0,60. Con `CONFIDENCE_THRESHOLD` en 0,7 el tercer lote mandó 148 filas
 * buenas a revisión interna — la misma venta pasaba o se marcaba según en qué lote cayó.
 */
describe('la confianza uniforme de un lote no decide el destino de una fila', () => {
  const venta = (cf: number) => ({ e: 'transaction', t: 'revenue', c: 'venta_vehiculos', cf });

  test('un lote uniforme hereda el techo que el modelo ya dio a ese veredicto', () => {
    const c = new ConfianzaPorHoja();

    const lote0 = [venta(0.92), venta(0.92), venta(0.92)];
    const lote2 = [venta(0.6), venta(0.6), venta(0.6)];
    c.registrarLote('Ventas', lote0);
    c.registrarLote('Ventas', lote2);

    // Sin esto, las tres del lote 2 caen bajo el umbral de 0,7 y van a revisión.
    expect(lote2.map((v) => v.cf)).toEqual([0.92, 0.92, 0.92]);
    expect(c.filasElevadas).toBe(3);
  });

  test('la variación DENTRO de un lote es juicio por fila y no se toca', () => {
    /*
     * Es la mitad que protege la red de seguridad: si el modelo distinguió una fila de sus
     * vecinas, esa distinción es exactamente lo que el prompt le pide y no puede borrarse.
     */
    const c = new ConfianzaPorHoja();
    c.registrarLote('Ventas', [venta(0.95), venta(0.95)]);

    const mezclado = [venta(0.95), venta(0.4), venta(0.95)];
    c.registrarLote('Ventas', mezclado);

    expect(mezclado.map((v) => v.cf)).toEqual([0.95, 0.4, 0.95]);
    expect(c.filasElevadas).toBe(0);
  });

  test('nunca se baja una confianza', () => {
    const c = new ConfianzaPorHoja();
    c.registrarLote('Ventas', [venta(0.6), venta(0.6)]);

    const alto = [venta(0.95), venta(0.95)];
    c.registrarLote('Ventas', alto);

    expect(alto.map((v) => v.cf)).toEqual([0.95, 0.95]);
  });

  test('el techo NO cruza veredictos distintos', () => {
    /*
     * Un `opex` que el modelo entendió bien no dice nada sobre un `cogs` que no entendió. Si
     * el techo se compartiera entre veredictos, una hoja heterogénea como `Gastos_Operativos`
     * subiría todas sus filas al máximo de la más clara.
     */
    const c = new ConfianzaPorHoja();
    c.registrarLote('Gastos', [
      { e: 'transaction', t: 'opex', c: 'alquiler', cf: 0.95 },
      { e: 'transaction', t: 'opex', c: 'alquiler', cf: 0.95 },
    ]);

    const dudoso = [
      { e: 'transaction', t: 'opex', c: 'otros', cf: 0.5 },
      { e: 'transaction', t: 'opex', c: 'otros', cf: 0.5 },
    ];
    c.registrarLote('Gastos', dudoso);

    expect(dudoso.map((v) => v.cf)).toEqual([0.5, 0.5]);
  });

  test('el techo NO cruza hojas', () => {
    const c = new ConfianzaPorHoja();
    c.registrarLote('Ventas', [venta(0.95), venta(0.95)]);

    const otraHoja = [venta(0.5), venta(0.5)];
    c.registrarLote('Devoluciones', otraHoja);

    expect(otraHoja.map((v) => v.cf)).toEqual([0.5, 0.5]);
  });

  test('los `skip` no cuentan para juzgar la uniformidad', () => {
    // Una fila que el modelo declaró "esto no es un dato" no habla del criterio con que
    // clasificó las demás; si contara, un solo skip haría ver mezclado un lote uniforme.
    const c = new ConfianzaPorHoja();
    c.registrarLote('Ventas', [venta(0.9), venta(0.9)]);

    const conSkip = [venta(0.6), { e: 'skip', t: null, c: null, cf: 0 }, venta(0.6)];
    c.registrarLote('Ventas', conSkip);

    expect(conSkip[0]!.cf).toBe(0.9);
    expect(conSkip[2]!.cf).toBe(0.9);
    expect(conSkip[1]!.cf).toBe(0); // el skip queda intacto
  });
});

/**
 * ═══ TRES NOMBRES PARA EL MISMO GASTO (CarsGT, verificado en producción 2026-08-24) ═══
 *
 * Una concesionaria produjo, un nombre por lote:
 *
 *     import_customs         11 filas
 *     importacion_aduanas     8 filas
 *     import_customs_duties   6 filas   ← estas fueron A REVISIÓN INTERNA
 *
 * Y el daño fue doble: el cliente vio tres rubros donde hay uno, y como los tres contaban
 * como veredictos distintos, el tercero no pudo heredar la confianza que el modelo ya le
 * había dado al mismo concepto — sus 6 filas se marcaron.
 */
describe('el mismo concepto con un matiz de más se unifica', () => {
  test('los tres nombres reales de "importación y aduanas" son uno solo', () => {
    expect(sonElMismoConcepto('import_customs', 'importacion_aduanas')).toBe(true);
    expect(sonElMismoConcepto('import_customs', 'import_customs_duties')).toBe(true);
    expect(sonElMismoConcepto('importacion_aduanas', 'import_customs_duties')).toBe(true);
  });

  test('los tres nombres reales de "venta de vehículos" también', () => {
    expect(sonElMismoConcepto('venta_vehiculos', 'vehicle_sales')).toBe(true);
    expect(sonElMismoConcepto('venta_vehiculos', 'car_sales')).toBe(true);
  });

  /**
   * La otra mitad, y la que importa más: compartir UNA palabra no puede bastar. Estos dos son
   * ambos `opex`, comparten `utility`, y colapsarlos le quita al cliente su pantalla de
   * gastos. Con CONTENCIÓN no se tocan: cada uno tiene una palabra que el otro no tiene.
   */
  test('dos gastos distintos que comparten una palabra NO se unifican', () => {
    expect(sonElMismoConcepto('servicios_publicos', 'servicios_profesionales')).toBe(false);
    expect(sonElMismoConcepto('alquiler', 'nomina')).toBe(false);
    expect(sonElMismoConcepto('costo_de_ventas', 'venta_vehiculos')).toBe(false);

    /*
     * ESTE es el caso que de verdad fija la regla, y los de arriba no lo hacían: ahí los dos
     * conceptos tienen el MISMO tamaño, así que la guarda de cardinalidad los separa antes de
     * llegar a comparar palabras. Con tamaños distintos, "comparten alguna palabra" y
     * "contención" dan resultados OPUESTOS — y solo la contención da el correcto.
     *
     * Verificado por mutación: sin este caso, cambiar la contención por "comparten alguna"
     * dejaba la suite entera en verde.
     */
    expect(sonElMismoConcepto('servicios_publicos', 'servicios_profesionales_externos')).toBe(
      false,
    );
    expect(sonElMismoConcepto('gasto_alquiler', 'gasto_nomina_extra')).toBe(false);
  });

  test('un nombre de UNA sola palabra no absorbe a otro', () => {
    /*
     * `gasto` está fuera de `PALABRAS_GENERICAS` a propósito —"gasto_ventas no es ventas"— y
     * sin el mínimo de dos lemas la contención lo uniría con todo lo que empiece por gasto.
     */
    expect(sonElMismoConcepto('gasto', 'gasto_ventas')).toBe(false);
    expect(sonElMismoConcepto('venta', 'venta_vehiculos')).toBe(false);
  });
});
