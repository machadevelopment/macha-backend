import { describe, expect, test } from 'bun:test';
import {
  DiccionarioDeCategorias,
  claveDeConcepto,
  resolverLoteConDiccionario,
} from '@/lib/category-dictionary';
import type { ColumnMap } from '@/lib/row-assembly';
import { CONFIDENCE_THRESHOLD } from '@/lib/staging-rules';

/**
 * Diccionario de categorías por empresa — acuerdo Keneth–Semi, 2026-08-20.
 *
 * Lo que se prueba acá es la NORMALIZACIÓN y la regla de AUTORIDAD. Las dos deciden si una
 * regla guardada se vuelve a encontrar, y las dos fallan en silencio: si la clave no coincide
 * el diccionario simplemente no acierta nunca y se sigue pagando la clasificación, sin que
 * nada se rompa ni aparezca en un log.
 */

describe('claveDeConcepto', () => {
  test('el mismo concepto escrito de tres formas da UNA sola clave', () => {
    // Es el caso que justifica normalizar: guardar estas tres por separado haría que el
    // diccionario creciera sin aprender nada.
    const a = claveDeConcepto('Pago a CLARO');
    const b = claveDeConcepto('pago claro');
    const c = claveDeConcepto('Pago  a  Claro.');

    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('los acentos no parten el concepto en dos', () => {
    expect(claveDeConcepto('electricidad')).toBe(claveDeConcepto('ELECTRICIDÁD'));
  });

  test('un texto sin nada normalizable devuelve null, no cadena vacía', () => {
    /*
     * Importa más de lo que parece: una clave vacía casaría con TODA fila sin descripción y
     * clasificaría media hoja por accidente. La base también lo ataja con un CHECK, pero el
     * primer filtro va acá.
     */
    expect(claveDeConcepto('')).toBeNull();
    expect(claveDeConcepto('   ')).toBeNull();
    expect(claveDeConcepto('...')).toBeNull();
    expect(claveDeConcepto(null)).toBeNull();
    expect(claveDeConcepto(42)).toBeNull();
  });

  test('dos conceptos distintos NO colapsan', () => {
    // El riesgo opuesto al de arriba, y el peor de los dos: si "transporte" y "servicios"
    // dieran la misma clave, una regla clasificaría plata en el rubro equivocado.
    expect(claveDeConcepto('flete de mercadería')).not.toBe(claveDeConcepto('pago a claro'));
  });
});

/** Un diccionario armado a mano, sin tocar la base. */
function conReglas(
  entradas: Array<{ texto: string; category: string; source?: string; version?: number }>,
): DiccionarioDeCategorias {
  const filas = entradas.map((e) => ({
    concepto: claveDeConcepto(e.texto)!,
    entity: 'transaction',
    type: 'opex',
    category: e.category,
    source: e.source ?? 'inferido',
    version: e.version ?? 1,
  }));
  // Se ejercita el MISMO camino de decisión que `cargar`, con las filas inyectadas.
  const db = {
    select: () => ({ from: () => ({ where: async () => filas }) }),
  } as never;
  return DiccionarioDeCategorias.cargar(db, 'c1') as never as DiccionarioDeCategorias;
}

describe('la regla vigente: autoridad primero, versión después', () => {
  test('lo que confirmó el cliente gana sobre lo que infirió el modelo', async () => {
    /*
     * El corazón del acuerdo con Semi: el cliente entra al flujo porque sabe qué es "Cropa"
     * en su propio libro. Si el modelo pudiera pisarlo, se le volvería a preguntar algo que
     * ya contestó — que es exactamente lo que este mecanismo viene a evitar.
     */
    const d = await (conReglas([
      { texto: 'flete cropa', category: 'servicios', source: 'inferido', version: 1 },
      {
        texto: 'flete cropa',
        category: 'transporte',
        source: 'confirmado_por_cliente',
        version: 1,
      },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('flete cropa')?.category).toBe('transporte');
  });

  test('la autoridad manda AUNQUE la versión inferida sea más alta', async () => {
    /*
     * El caso que decide el orden de los dos criterios. El cliente confirma en la versión 1;
     * el modelo vuelve a inferir en cargas posteriores y llega a la versión 9. Si se ordenara
     * por versión primero, la regla del cliente quedaría enterrada por antigüedad.
     */
    const d = await (conReglas([
      {
        texto: 'pago claro',
        category: 'servicios',
        source: 'confirmado_por_cliente',
        version: 1,
      },
      { texto: 'pago claro', category: 'otros', source: 'inferido', version: 9 },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('pago claro')?.category).toBe('servicios');
  });

  test('entre reglas del MISMO origen, gana la versión más alta', async () => {
    const d = await (conReglas([
      { texto: 'alquiler local', category: 'viejo', source: 'inferido', version: 1 },
      { texto: 'alquiler local', category: 'nuevo', source: 'inferido', version: 2 },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('alquiler local')?.category).toBe('nuevo');
  });

  test('staff gana al modelo pero NO al cliente', async () => {
    // Un operador puede arreglar un disparate evidente; si el dueño ya dijo qué es, sabe algo
    // que nosotros no.
    const d = await (conReglas([
      { texto: 'cuota gremial', category: 'del staff', source: 'corregido_por_staff' },
      { texto: 'cuota gremial', category: 'del cliente', source: 'confirmado_por_cliente' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('cuota gremial')?.category).toBe('del cliente');
  });

  test('un concepto que el diccionario no conoce devuelve null', async () => {
    // Y eso es lo que hace que la fila vaya al modelo: sin regla, no se inventa una.
    const d = await (conReglas([
      { texto: 'pago claro', category: 'servicios' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('compra de vitrinas')).toBeNull();
  });

  test('el diccionario vacío no acierta nada y no revienta', () => {
    const d = DiccionarioDeCategorias.vacio();
    expect(d.tamano).toBe(0);
    expect(d.buscar('cualquier cosa')).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SALTARSE LA LLAMADA CUANDO EL LOTE YA ESTÁ EN EL DICCIONARIO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Este es el ahorro que el acuerdo con Semi dejó pendiente, y también el punto donde el
 * diccionario deja de ser un renombrador y empieza a decidir la clasificación de plata real
 * sin que nadie mire. Lo que se prueba acá no es que ahorre: es que **no clasifique de más**.
 *
 * Los tres candados son el test. Si alguno se cae, el modo de fallo no es un error: es un
 * renglón de TOTAL sumado como una venta, o una fila clasificada por la columna equivocada,
 * en el dashboard de un cliente, sin que nada se rompa.
 */
const MAPA: ColumnMap = {
  date: 0,
  amount: 1,
  currency: null,
  description: 2,
  counterparty: null,
  product: null,
  quantity: null,
  productCategory: null,
  store: null,
  dueDate: null,
  costTotal: null,
  costUnit: null,
};

/** Serial de Excel plausible (2025-01-15) — `filaAptaParaCortocircuito` exige fecha legible. */
const FECHA = 45672;

function diccionarioCon(
  entradas: Array<{ texto: string; category: string; source?: string; type?: string }>,
): DiccionarioDeCategorias {
  return conReglas(
    entradas.map((e) => ({ texto: e.texto, category: e.category, source: e.source })),
  ) as never as DiccionarioDeCategorias;
}

describe('resolverLoteConDiccionario', () => {
  test('un lote cuyas filas ya se conocen se resuelve sin llamar al modelo', async () => {
    /*
     * El caso que justifica todo: `Gastos_Operativos` nunca va a ser homogénea (13 categorías,
     * la más frecuente cubre el 11 %), así que el consenso de hoja no la cubre nunca. Pero sus
     * conceptos son los mismos proveedores de la semana pasada.
     */
    const d = await (diccionarioCon([
      { texto: 'pago a claro', category: 'servicios' },
      { texto: 'flete cropa', category: 'transporte' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    const lote = [
      [FECHA, 1500, 'Pago a CLARO'],
      [FECHA, 320, 'Flete Cropa'],
      [FECHA, 890, 'pago claro'],
    ];
    const r = resolverLoteConDiccionario(lote, MAPA, d);

    expect(r).not.toBeNull();
    expect(r!.size).toBe(3);
    // Cada fila trae SU veredicto, no uno para todo el lote. Es toda la diferencia con el
    // cortocircuito de hoja, y es lo que hace que sirva donde el consenso no llega.
    expect(r!.get(0)!.c).toBe('servicios');
    expect(r!.get(1)!.c).toBe('transporte');
    expect(r!.get(2)!.c).toBe('servicios');
  });

  test('si UNA sola fila no se conoce, el lote entero va al modelo', async () => {
    /*
     * Todo-o-nada, y no es rigor de más: el lote es la unidad de LLAMADA. Resolver 2 filas en
     * código y preguntar por la tercera cuesta lo mismo que preguntar por las tres, así que no
     * hay premio por el 99 % — y sí riesgo en partir el lote.
     */
    const d = await (diccionarioCon([
      { texto: 'pago a claro', category: 'servicios' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    const r = resolverLoteConDiccionario(
      [
        [FECHA, 1500, 'Pago a CLARO'],
        [FECHA, 700, 'Compra de vitrinas'], // nunca visto
      ],
      MAPA,
      d,
    );

    expect(r).toBeNull();
  });

  test('CANDADO: un renglón de TOTAL no se resuelve acá aunque su texto se reconozca', async () => {
    /*
     * El fallo más caro de los tres, y el menos evidente. La última fila de una hoja de ventas
     * dice "Ventas" o "Total ventas" —texto que el diccionario reconoce perfectamente— y trae
     * el total del mes en la columna de monto. Sin este candado se sumaría como una venta más,
     * duplicando el mes en el dashboard.
     *
     * Lo que lo delata no es el texto sino la FORMA: al renglón de total le falta la fecha.
     * Es el mismo candado del cortocircuito de hoja (`filaAptaParaCortocircuito`) y está acá
     * por el mismo motivo.
     */
    const d = await (diccionarioCon([
      { texto: 'ventas', category: 'sales' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    const r = resolverLoteConDiccionario(
      [
        [FECHA, 1500, 'Ventas'],
        [null, 480000, 'Ventas'], // el renglón de TOTAL: sin fecha
      ],
      MAPA,
      d,
    );

    expect(r).toBeNull();
  });

  test('CANDADO: sin columna de descripción no se resuelve nada', async () => {
    // Es de donde sale el concepto. Buscarlo en otra columna sería clasificar por la columna
    // equivocada: plata en el rubro equivocado, sin que nada falle.
    const d = await (diccionarioCon([
      { texto: 'pago a claro', category: 'servicios' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    const r = resolverLoteConDiccionario(
      [[FECHA, 1500, 'Pago a CLARO']],
      { ...MAPA, description: null },
      d,
    );

    expect(r).toBeNull();
  });

  test('un diccionario vacío no cubre nada (la primera carga paga entera)', () => {
    const r = resolverLoteConDiccionario(
      [[FECHA, 1500, 'Pago a CLARO']],
      MAPA,
      DiccionarioDeCategorias.vacio(),
    );
    expect(r).toBeNull();
  });

  test('un lote vacío devuelve null, no un mapa vacío', () => {
    /*
     * Un mapa vacío diría "cubierto" y el llamador daría el lote por hecho sin haber escrito
     * una sola fila. `null` lo manda al modelo, que con cero filas tampoco escribe nada — pero
     * por el camino que sí lleva contabilidad de lo que pasó.
     */
    const d = DiccionarioDeCategorias.vacio();
    expect(resolverLoteConDiccionario([], MAPA, d)).toBeNull();
  });

  test('el veredicto lleva entity y type de la REGLA, no un default', async () => {
    // Una regla sin ellos es ambigua: "flete" puede ser costo directo (traer mercadería) o
    // gasto operativo (mandar una muestra), y son rubros distintos del dashboard.
    const filas = [
      {
        concepto: claveDeConcepto('flete cropa')!,
        entity: 'bill',
        type: 'cogs',
        category: 'transporte',
        source: 'inferido',
        version: 1,
      },
    ];
    const db = { select: () => ({ from: () => ({ where: async () => filas }) }) } as never;
    const d = await DiccionarioDeCategorias.cargar(db, 'c1');

    const r = resolverLoteConDiccionario([[FECHA, 320, 'Flete Cropa']], MAPA, d);

    expect(r!.get(0)!.e).toBe('bill');
    expect(r!.get(0)!.t).toBe('cogs');
  });
});

describe('la confianza de una fila resuelta por diccionario', () => {
  /*
   * No se inventa: sale del ORIGEN de la regla. Y el piso está ATADO a
   * `CONFIDENCE_THRESHOLD`, no escrito a mano — si alguien sube el umbral, un 0,7 literal
   * mandaría a revisión interna todas las filas de todas las cargas, en silencio.
   */
  async function confianzaDe(source: string): Promise<number> {
    const d = await (diccionarioCon([
      { texto: 'pago a claro', category: 'servicios', source },
    ]) as never as Promise<DiccionarioDeCategorias>);
    const r = resolverLoteConDiccionario([[FECHA, 1500, 'Pago a CLARO']], MAPA, d);
    return r!.get(0)!.cf;
  }

  test('lo que el modelo infirió vale exactamente el umbral, ni más ni menos', async () => {
    /*
     * Ni más: no se guardó el valor original del veredicto, así que afirmar 0,9 sería inventar.
     * Ni menos: por debajo del umbral, `staging-rules` marca la fila y el mecanismo entero se
     * vuelve en contra — mandaría a revisión interna justo lo que vino a resolver.
     */
    expect(await confianzaDe('inferido')).toBe(CONFIDENCE_THRESHOLD);
  });

  test('nada resuelto por diccionario cae en revisión interna por confianza', async () => {
    // Es la propiedad que de verdad importa, y la que se rompería sola si el umbral sube.
    for (const s of ['inferido', 'corregido_por_staff', 'confirmado_por_cliente']) {
      expect(await confianzaDe(s)).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    }
  });

  test('lo que el cliente confirmó vale más que lo que infirió el modelo', async () => {
    // El dueño hablando de su propio libro es la mejor fuente que hay.
    expect(await confianzaDe('confirmado_por_cliente')).toBeGreaterThan(
      await confianzaDe('corregido_por_staff'),
    );
    expect(await confianzaDe('corregido_por_staff')).toBeGreaterThan(await confianzaDe('inferido'));
  });
});
