import { and, eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { companyCategoryRules } from '@/db/schema';
import { conceptoDeCategoria } from '@/lib/sheet-consensus';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DICCIONARIO DE CATEGORÍAS POR EMPRESA — acuerdo Keneth–Semi, 2026-08-20
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `company_column_profiles` (migración 0027) ya resolvió DÓNDE está cada dato, y con eso el
 * modelo dejó de leer las 18.000 filas: devuelve el mapa una vez por hoja y el código arma el
 * resto. Eso bajó un archivo real de 216 llamadas a 15, y de USD 15 a USD 1.
 *
 * Lo que sigue costando es CLASIFICAR. Que "pago a Claro" sea servicios no está en la forma
 * del archivo —un parser del layout no puede deducirlo— sino en el significado del texto. Y
 * es lo que se le vuelve a preguntar al modelo en cada carga, con la misma respuesta.
 *
 * Semi lo planteó como un camino de ida y vuelta: que la clasificación devuelva lo que
 * descubrió, se guarde, y "el script futuro ya sea más directo". Este módulo es ese guardado.
 *
 * ═══ LA IDEA ECONÓMICA ═══
 *
 * El diccionario NO crece con las filas del archivo: crece con los conceptos DISTINTOS del
 * negocio, que son decenas y se estabilizan. Un cliente sube su contabilidad cada semana con
 * los mismos proveedores y los mismos rubros — la primera carga paga la clasificación, las
 * siguientes la leen de acá.
 *
 * ═══ POR QUÉ ESTO NO ES EL CORTOCIRCUITO DE HOJA ═══
 *
 * `sheet-consensus.ts` decide dejar de preguntar por una HOJA ENTERA cuando resultó homogénea
 * (18.034 ventas, todas `revenue`). Sirve para la hoja de ventas y no sirve para
 * `Gastos_Operativos`, donde cada fila requiere criterio de verdad: 13 categorías y la más
 * frecuente cubre el 11 %.
 *
 * El diccionario ataca justamente ese caso: la hoja NO es homogénea, pero sus conceptos se
 * repiten entre cargas. Son complementarios y actúan en distinto eje — uno por hoja, el otro
 * por concepto.
 */

/** A qué resuelve un concepto ya conocido. */
export interface ReglaDeCategoria {
  entity: string;
  type: string | null;
  category: string;
  source: 'inferido' | 'confirmado_por_cliente' | 'corregido_por_staff';
}

/**
 * Autoridad de cada origen. Mayor gana.
 *
 * El cliente gana sobre el modelo porque es quien conoce su propio libro — es toda la razón
 * de que Semi quisiera meterlo en el flujo. Y staff gana sobre el modelo pero NO sobre el
 * cliente: un operador puede arreglar un disparate evidente, pero si el dueño dijo que
 * "Cropa" es transporte, sabe algo que nosotros no.
 */
const AUTORIDAD: Record<ReglaDeCategoria['source'], number> = {
  inferido: 0,
  corregido_por_staff: 1,
  confirmado_por_cliente: 2,
};

/**
 * Palabras funcionales que sobreviven a `conceptoDeCategoria` y NO deberían llegar a la clave.
 *
 * Su lista de palabras genéricas (`de`, `del`, `la`, `por`…) se calibró para nombres de
 * CATEGORÍA —`costo_de_ventas`, `gastos_operativos`— que son etiquetas cortas. Acá la entrada
 * es la DESCRIPCIÓN de una fila, que viene en prosa y trae preposiciones que esa lista no
 * cubre. Lo encontró un test: "Pago a CLARO" daba `a|claro|pago` y "pago claro" daba
 * `claro|pago`, o sea DOS reglas para el mismo concepto — y el diccionario habría crecido sin
 * aprender nada, que es justo lo que normalizar viene a evitar.
 *
 * Se filtra acá y no en `conceptoDeCategoria` a propósito: esa función tiene su propio test
 * que fija su comportamiento para nombres de categoría, y ampliarle la lista cambiaría cómo
 * se unifican categorías, que es otro problema con otras consecuencias.
 */
const PALABRAS_FUNCIONALES = new Set([
  'a',
  'al',
  'con',
  'en',
  'para',
  'sin',
  'sobre',
  'un',
  'una',
  'unos',
  'unas',
  'to',
  'for',
  'from',
  'with',
  'at',
  'on',
  'in',
]);

/**
 * Normaliza el texto de una fila a la clave del diccionario.
 *
 * Reusa `conceptoDeCategoria` —la misma normalización que ya decide si dos categorías son el
 * mismo concepto— en vez de escribir otra. Dos normalizaciones distintas para el mismo texto
 * es cómo se llega a que una regla guardada nunca vuelva a encontrarse.
 *
 * `null` cuando no queda nada normalizable. Una clave vacía casaría con cualquier fila sin
 * descripción y clasificaría media hoja por accidente (la base también lo ataja con un CHECK).
 */
export function claveDeConcepto(texto: unknown): string | null {
  if (typeof texto !== 'string') return null;
  const limpio = texto.trim();
  if (limpio === '') return null;

  /*
   * Las funcionales se quitan ANTES de normalizar, no después: `conceptoDeCategoria` devuelve
   * las palabras ya unidas por `|`, y volver a partir esa cadena para filtrarla sería deshacer
   * su trabajo para rehacerlo.
   */
  const sinFuncionales = limpio
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '' && !PALABRAS_FUNCIONALES.has(t))
    .join(' ');

  // Todo funcional (una descripción que dice solo "a la"): se normaliza el texto original en
  // vez de devolver null. Es un concepto inútil, pero es UN concepto — y colapsarlo con el
  // resto de los inútiles sería peor que guardarlo aparte.
  const clave = conceptoDeCategoria(sinFuncionales === '' ? limpio : sinFuncionales);
  return clave === '' ? null : clave;
}

/**
 * El diccionario vigente de una empresa, listo para consultar en memoria.
 *
 * Se carga UNA vez por documento y no una consulta por fila: con 18.000 filas, preguntarle a
 * Postgres por cada una serían 18.000 idas a la base para ahorrar llamadas al modelo, o sea
 * cambiar un costo por otro. El diccionario completo de una empresa son decenas de reglas.
 */
export class DiccionarioDeCategorias {
  private constructor(private readonly reglas: Map<string, ReglaDeCategoria>) {}

  /**
   * Carga las reglas vigentes. "Vigente" se decide en dos pasos y el orden importa:
   * primero la AUTORIDAD del origen, y solo entre iguales, la versión más alta.
   *
   * Al revés —versión primero— una regla inferida por el modelo la semana siguiente pisaría
   * lo que el cliente confirmó, y el diccionario le volvería a preguntar algo que ya
   * contestó. Eso es justo lo que este mecanismo viene a evitar.
   */
  static async cargar(db: DB, companyId: string): Promise<DiccionarioDeCategorias> {
    const filas = await db
      .select({
        concepto: companyCategoryRules.concepto,
        entity: companyCategoryRules.entity,
        type: companyCategoryRules.type,
        category: companyCategoryRules.category,
        source: companyCategoryRules.source,
        version: companyCategoryRules.version,
      })
      .from(companyCategoryRules)
      .where(eq(companyCategoryRules.companyId, companyId));

    const mejores = new Map<string, ReglaDeCategoria & { version: number }>();
    for (const f of filas) {
      const source = f.source as ReglaDeCategoria['source'];
      const candidata = {
        entity: f.entity,
        type: f.type,
        category: f.category,
        source,
        version: f.version,
      };
      const actual = mejores.get(f.concepto);
      if (
        actual === undefined ||
        AUTORIDAD[source] > AUTORIDAD[actual.source] ||
        (AUTORIDAD[source] === AUTORIDAD[actual.source] && f.version > actual.version)
      ) {
        mejores.set(f.concepto, candidata);
      }
    }

    const reglas = new Map<string, ReglaDeCategoria>();
    for (const [k, v] of mejores) {
      reglas.set(k, { entity: v.entity, type: v.type, category: v.category, source: v.source });
    }
    return new DiccionarioDeCategorias(reglas);
  }

  /** Diccionario vacío, para los caminos que no tocan la base (tests, primera carga). */
  static vacio(): DiccionarioDeCategorias {
    return new DiccionarioDeCategorias(new Map());
  }

  /** La regla de este texto, si el diccionario ya la sabe. */
  buscar(texto: unknown): ReglaDeCategoria | null {
    const clave = claveDeConcepto(texto);
    if (clave === null) return null;
    return this.reglas.get(clave) ?? null;
  }

  get tamano(): number {
    return this.reglas.size;
  }
}

/** Lo que la ingesta aprendió de una fila y quiere guardar. */
export interface ReglaAprendida {
  /** El texto CRUDO de la fila. Se normaliza acá, no en el llamador. */
  texto: unknown;
  entity: string;
  type: string | null;
  category: string;
}

/**
 * Guarda lo aprendido en una carga, sin duplicar lo que ya estaba.
 *
 * ═══ POR QUÉ NO SE ESCRIBE UNA FILA POR CADA FILA CLASIFICADA ═══
 *
 * Una hoja de 18.000 movimientos tiene decenas de conceptos distintos. Insertar una regla por
 * movimiento haría del diccionario una copia del ledger —y como la tabla es append-only, para
 * siempre— así que se deduplica por concepto ANTES de escribir y solo se inserta lo que el
 * diccionario todavía no sabía.
 *
 * ═══ LO INFERIDO NO PISA LO CONFIRMADO ═══
 *
 * Si el concepto ya tiene una regla del cliente o de staff, no se escribe nada aunque el
 * modelo haya dicho otra cosa. Escribir una versión nueva "inferido" sería inofensivo para la
 * LECTURA (la autoridad la descarta) pero llenaría la tabla de ruido en cada carga, y
 * enterraría la regla buena bajo cientos de filas al momento de diagnosticar.
 */
export async function guardarReglasAprendidas(
  db: DB,
  companyId: string,
  aprendidas: ReglaAprendida[],
  opciones: { source?: ReglaDeCategoria['source']; createdBy?: string } = {},
): Promise<number> {
  const source = opciones.source ?? 'inferido';

  // Deduplicación en memoria: la primera aparición de cada concepto gana, igual que hace el
  // canonizador por hoja. Con la misma razón: elegir "la más frecuente" exigiría recorrer
  // todo antes de decidir, y el resultado no es mejor.
  const porConcepto = new Map<string, ReglaAprendida & { clave: string }>();
  for (const a of aprendidas) {
    const clave = claveDeConcepto(a.texto);
    if (clave === null) continue;
    if (a.category.trim() === '') continue;
    if (!porConcepto.has(clave)) porConcepto.set(clave, { ...a, clave });
  }
  if (porConcepto.size === 0) return 0;

  const yaSabidas = await DiccionarioDeCategorias.cargar(db, companyId);

  let escritas = 0;
  for (const [clave, a] of porConcepto) {
    const existente = yaSabidas.buscar(a.texto);
    if (existente !== null) {
      // Ya hay regla. Solo se escribe si la nueva tiene MÁS autoridad — o sea, cuando el
      // cliente corrige lo que el modelo había inferido.
      if (AUTORIDAD[source] <= AUTORIDAD[existente.source]) continue;
    }

    /*
     * La versión se calcula leyendo el máximo y sumando uno, y eso es una carrera conocida:
     * dos cargas simultáneas de la misma empresa pueden llegar al mismo número. El árbitro
     * es el índice UNIQUE de la migración, no este cálculo — la segunda falla, y falla
     * RUIDOSAMENTE, que es lo correcto para una tabla que decide cómo se clasifica el dinero
     * de alguien.
     */
    const previas = await db
      .select({ version: companyCategoryRules.version })
      .from(companyCategoryRules)
      .where(
        and(
          eq(companyCategoryRules.companyId, companyId),
          eq(companyCategoryRules.concepto, clave),
        ),
      );
    const siguiente = previas.reduce((max, p) => Math.max(max, p.version), 0) + 1;

    await db.insert(companyCategoryRules).values({
      companyId,
      concepto: clave,
      entity: a.entity,
      type: a.type,
      category: a.category.trim(),
      source,
      version: siguiente,
      createdBy: opciones.createdBy ?? null,
    });
    escritas++;
  }

  return escritas;
}
