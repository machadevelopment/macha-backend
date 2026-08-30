/**
 * Arma el payload de una fila a partir del MAPA DE COLUMNAS y la fila cruda.
 *
 * ═══ POR QUÉ EXISTE ESTE ARCHIVO ═══
 *
 * Hasta ahora el modelo devolvía la fila entera reconstruida: fecha, monto, moneda,
 * descripción, producto, cantidad. Nueve campos por fila, con structured outputs obligando a
 * que vinieran los nueve incluso en null, y la descripción copiada palabra por palabra.
 *
 * El costo medido el 2026-08-12 dijo que el 95,7 % del recibo eran tokens de SALIDA — unos
 * 71 por fila. Y como el modelo genera la salida token por token, esos mismos tokens son los
 * 40-50 minutos de espera. El desperdicio y la lentitud eran la misma cosa.
 *
 * Lo perverso: SIETE de esos nueve campos ya los tenía el backend. Se los había mandado él
 * en la fila cruda. Estaba pagando USD 10 por millón de tokens para que se los devolvieran
 * copiados.
 *
 * ═══ QUÉ SIGUE HACIENDO EL MODELO ═══
 *
 * Lo que de verdad requiere criterio y no se puede resolver con código:
 *
 *   · UNA VEZ POR HOJA — el mapa de columnas: qué índice es la fecha, cuál el monto, cuál
 *     la descripción. Antes lo resolvía implícitamente en cada fila; ahora lo dice una vez.
 *   · POR FILA — a qué entidad va (transaction/invoice/bill), el tipo contable, la
 *     categoría, y su confianza. Cuatro campos cortos en vez de nueve con valores.
 *
 * El código hace el resto: leer la celda que el mapa señala. Eso no es criterio, es indexar.
 *
 * ═══ LO QUE NO CAMBIA ═══
 *
 * La forma del payload que sale de acá es EXACTAMENTE la de antes, campo por campo. Todo lo
 * de aguas abajo —`staging-rules.ts`, la promoción, la pantalla de revisión— sigue viendo lo
 * mismo. El cambio es de dónde salen los valores, no cuáles son.
 */

/**
 * Índices de columna que el modelo identifica una vez por hoja. `null` = la hoja no trae esa
 * columna, que es información legítima y distinta de "no la encontré".
 */
export type ColumnMap = {
  date: number | null;
  amount: number | null;
  currency: number | null;
  description: number | null;
  counterparty: number | null;
  product: number | null;
  quantity: number | null;
  productCategory: number | null;
  /**
   * CU-868kt8kk9: la TIENDA/sucursal de la fila. `stores` y `transactions.store_id`
   * existían desde el data model; lo que faltaba era este campo, sin el cual el modelo no
   * podía mapear la columna aunque la viera.
   */
  store: number | null;
  dueDate: number | null;
  /*
   * ═══ EL COSTO DE LA PROPIA FILA DE VENTA ═══
   *
   * Muchos libros de PYME traen el ingreso Y el costo en la MISMA fila:
   *
   *   Fecha | Producto | Unidades | Ingreso Total (Q) | Costo Total (Q) | Utilidad (Q)
   *   46174 | Café Am. | 6        | 108               | 27              | 81
   *
   * Hasta acá esa columna no la leía nadie: una fila producía UNA transacción, la de
   * ingreso, y el costo se perdía. Consecuencia observada en producción (2026-08-14):
   * `cogs = 0` para todos los productos y margen 100 % en toda la pantalla de Ventas por
   * producto — con el dato ahí, en la celda de al lado.
   *
   * Dos índices y no uno porque las hojas reales traen las dos formas y confundirlas
   * multiplica o divide el costo por las unidades:
   *   · `costTotal` — el costo de ESTA línea completa ("Costo Total (Q)" = 27).
   *   · `costUnit`  — el costo de UNA unidad ("CostoUnitario" = 135,52 con Cantidad 2).
   */
  costTotal: number | null;
  costUnit: number | null;
};

/**
 * Las claves de `ColumnMap`, en una lista recorrible.
 *
 * ═══ POR QUÉ NO SE USA `Object.keys(unMapa)` ═══
 *
 * Porque un `ColumnMap` que vuelve de la base NO trae las claves en el orden en que se
 * escribieron: Postgres guarda `jsonb` normalizado y las reordena (por longitud y después
 * alfabéticamente). Comparar dos mapas con `JSON.stringify` da distinto aunque sean idénticos
 * campo por campo — lo atrapó el test de integración del perfil de columnas
 * (CU-868krmrcj): "reguardar lo mismo no crea una versión nueva" fallaba porque el mapa leído
 * nunca era igual al mapa en memoria, así que cada carga escribía una versión nueva diciendo
 * exactamente lo mismo.
 *
 * El `Record` de arriba es lo que hace que esto no se pueda desincronizar: agregar un campo a
 * `ColumnMap` sin agregarlo acá **no compila**. Una lista escrita a mano sí se habría
 * desincronizado, y el síntoma habría sido que el campo nuevo se ignora en silencio al
 * comparar dos mapas.
 */
const COBERTURA_DE_COLUMNAS: Record<keyof ColumnMap, true> = {
  date: true,
  amount: true,
  currency: true,
  description: true,
  counterparty: true,
  product: true,
  quantity: true,
  productCategory: true,
  store: true,
  dueDate: true,
  costTotal: true,
  costUnit: true,
};

export const CLAVES_DE_COLUMNA = Object.keys(COBERTURA_DE_COLUMNAS) as Array<keyof ColumnMap>;

/** Lo que el modelo devuelve POR FILA. Cuatro campos cortos, sin valores copiados. */
export type RowVerdict = {
  /** Índice de la fila dentro del lote, tal como se le presentó. */
  i: number;
  targetEntity: 'transaction' | 'invoice' | 'bill';
  /** Solo para `transaction`; en invoice/bill se ignora. */
  type: 'revenue' | 'cogs' | 'opex' | 'other' | null;
  /** Texto libre, igual que antes: si nada aplica, el modelo inventa un nombre corto. */
  category: string | null;
  confidence: number;
};

const cell = (row: unknown[], idx: number | null): unknown =>
  idx === null || idx < 0 || idx >= row.length ? null : row[idx];

/**
 * Un texto o `null`. Nunca `""`: la cadena vacía pasaría la validación de "hay categoría"
 * de `staging-rules.ts` sin serlo, y la fila entraría a producción sin categoría real en vez
 * de irse a revisión.
 */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Un número o `null`.
 *
 * Se aceptan las dos formas en que Excel entrega dinero: número nativo, o texto con
 * separadores de miles y símbolo ("Q 1,234.50"). Lo que NO se hace es adivinar: si tras
 * limpiar no queda un número, devuelve `null` y la fila se marca por `invalid_amount`. Eso
 * es correcto — la alternativa sería inventar un monto.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * UN CÓDIGO DE PRODUCTO NO ES UN MONTO
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Antes se borraba TODO lo que no fuera dígito, coma, punto o guion. Medido (2026-08-25):
   *
   *     "SKU-4567"  →  -4567
   *     "CLI-0001"  →      -1
   *     "Zona 10"   →      10
   *
   * O sea que un identificador de catálogo salía convertido en un monto negativo plausible.
   * Es el mismo defecto que `asDate` tenía con `new Date("CLI-0001")`, sobre la otra mitad de
   * la fila, y con la misma consecuencia: si el mapa de columnas apunta a una columna de
   * código —y `ID Cliente` es la primera columna de media base de archivos— cada fila entra
   * con una cifra inventada que ninguna validación puede desmentir, porque es un número.
   *
   * Ahora solo se quita la decoración de moneda que un archivo real trae, y lo que queda
   * tiene que ser un número Y NADA MÁS. Una cadena con letras pegadas a los dígitos es un
   * código, no plata, y vale `null` — la fila se marca para revisión en vez de inventarle un
   * monto.
   */
  let texto = value.trim();
  if (texto === '') return null;

  // Paréntesis contables: `(1,234.56)` es un negativo, no un adorno.
  let negativo = false;
  if (/^\(.*\)$/.test(texto)) {
    negativo = true;
    texto = texto.slice(1, -1).trim();
  }

  // Símbolo o código de moneda, delante o detrás. Los códigos largos van primero: sin eso,
  // `GTQ 100` perdería solo la `Q` y quedaría `GT 100`, que ya no es un número.
  const MONEDA = /US\$|GTQ|USD|EUR|MXN|[Q$€]/i;
  texto = texto
    .replace(new RegExp(`^\\s*(?:${MONEDA.source})\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*(?:${MONEDA.source})\\s*$`, 'i'), '')
    .trim();

  // Lo que queda: signo opcional, dígitos y separadores. Cualquier letra lo descalifica.
  if (!/^-?[\d.,\s]*\d[\d.,\s]*$/.test(texto)) return null;

  const limpio = (negativo ? `-${texto}` : texto).replace(/\s/g, '');
  if (limpio === '' || limpio === '-') return null;

  /*
   * La coma puede ser separador de miles (1,234.50) o decimal (1234,50). Se decide por
   * cuál aparece de último: en "1.234,50" la coma va después del punto y es la decimal.
   * Es la heurística que acierta en los dos formatos sin preguntar la configuración
   * regional, que el archivo no trae.
   */
  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  const normalizado =
    ultimaComa > ultimoPunto
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, '');

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fecha a `YYYY-MM-DD`.
 *
 * Excel entrega las fechas como NÚMERO DE SERIE (45878 = 2025-08-09), no como texto — se ve
 * en los archivos reales del cliente. Convertirlo mal desplazaría todos los movimientos de
 * fecha en silencio, que es de los peores errores posibles en un producto contable.
 *
 * La época de Excel es el 1899-12-30 (no el 31, por el bug del año bisiesto de Lotus 1-2-3
 * que Excel conserva a propósito).
 */
/**
 * Nombre de mes → número, en español e inglés, con y sin acento, completo y abreviado.
 *
 * Se escribe la tabla en vez de confiar en `Intl` o en `new Date`: el parseo de nombres de mes
 * no está en la especificación de JavaScript, así que depende del motor y de la configuración
 * regional del contenedor — dos cosas que no se controlan desde acá y que pueden cambiar en un
 * deploy sin que nada avise.
 */
const MESES_POR_NOMBRE: Record<string, number> = (() => {
  const t: Record<string, number> = {};
  const es = [
    ['enero', 'ene'],
    ['febrero', 'feb'],
    ['marzo', 'mar'],
    ['abril', 'abr'],
    ['mayo', 'may'],
    ['junio', 'jun'],
    ['julio', 'jul'],
    ['agosto', 'ago'],
    ['septiembre', 'sep', 'sept', 'setiembre', 'set'],
    ['octubre', 'oct'],
    ['noviembre', 'nov'],
    ['diciembre', 'dic'],
  ];
  const en = [
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
  ];
  for (const grupo of [es, en]) {
    grupo.forEach((nombres, i) => {
      for (const n of nombres) t[n] ??= i + 1;
    });
  }
  return t;
})();

const sinAcentos = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * `15 de enero de 2026`, `5 May 2025`, `05-may-2025`, `May 5, 2025` → `YYYY-MM-DD`.
 * `null` si no es una de esas formas o si el día no existe en ese mes.
 */
function MES_EN_PALABRAS(s: string): string | null {
  const t = sinAcentos(s.trim()).replace(/\s+/g, ' ');

  // `15 de enero de 2026` · `5 may 2025` · `05-may-2025`
  const m = /^(\d{1,2})[\s-]*(?:de\s+)?([a-z]{3,10})\.?[\s-]*(?:de\s+)?(\d{2,4})$/.exec(t);
  // `mayo 5, 2025` · `May 5 2025` — mismo dato, mes y día al revés.
  let partes: [string, string, string] | null = m ? [m[1]!, m[2]!, m[3]!] : null;
  if (!partes) {
    const b = /^([a-z]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
    if (b) partes = [b[2]!, b[1]!, b[3]!];
  }
  if (!partes) return null;

  const dia = Number(partes[0]);
  const mes = MESES_POR_NOMBRE[partes[1]];
  if (!mes) return null;

  // Un año de dos dígitos es de este siglo: un movimiento de PYME no es de 1926.
  let anio = Number(partes[2]);
  if (anio < 100) anio += 2000;
  if (anio < 1990 || anio > 2100) return null;

  const d = new Date(Date.UTC(anio, mes - 1, dia));
  // Un 31 de febrero desborda al mes siguiente: eso no es una fecha, es un dato malo.
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return d.toISOString().slice(0, 10);
}

export function asDate(value: unknown, orden: 'dmy' | 'mdy' = 'dmy'): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    /*
     * RANGO DE PLAUSIBILIDAD DE NEGOCIO, no el rango técnico de Excel.
     *
     * El rango técnico (1 = 1899-12-31 en adelante) es demasiado permisivo y deja pasar el
     * error que de verdad ocurre: un MONTO en la columna equivocada. El serial 491 es una
     * fecha válida —1901-05-05— así que un monto de 491.38 se convertiría en una fecha
     * perfectamente creíble y entraría a la contabilidad del cliente sin marcarse.
     *
     * Lo encontró un test con un monto real de los archivos de prueba.
     *
     * Se acota a lo que puede ser un movimiento de una PYME: 32874 = 1990-01-01 y
     * 73415 = 2101-01-01. Un monto típico (cientos o miles) queda fuera por abajo, que es
     * el caso que importa. Una fecha real de contabilidad nunca cae ahí.
     */
    if (value < 32_874 || value > 73_415) return null;
    const ms = Math.round(value) * 86_400_000;
    const epoca = Date.UTC(1899, 11, 30);
    return new Date(epoca + ms).toISOString().slice(0, 10);
  }

  const s = asText(value);
  if (!s) return null;

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * "01/05/2025" ES EL 1 DE MAYO, NO EL 5 DE ENERO
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * `new Date(s)` interpreta `DD/MM/YYYY` como `MM/DD/YYYY`, que es la convención de Estados
   * Unidos. Este producto factura en Guatemala, donde se escribe el día primero.
   *
   * El daño es el peor de todos los que se han encontrado, porque NO borra ni inventa plata:
   * la mueve de mes. Medido sobre el archivo de una agencia de marketing (2026-08-25):
   *
   *   · 61 de 150 filas entraban con la fecha INVERTIDA y sin que nada fallara — el 1 de mayo
   *     registrado el 5 de enero, o sea en otro trimestre del dashboard;
   *   · las otras 89 se marcaban por `invalid_date` y no entraban a la contabilidad, que son
   *     exactamente las que tienen día > 12 y por eso no pueden fingir ser un mes.
   *
   * O sea que el 41 % de sus ingresos quedaba mal fechado y el 59 % no quedaba.
   *
   * ═══ NO SE PUEDE DECIDIR FILA POR FILA, PERO SÍ POR COLUMNA ═══
   *
   * "01/05" es genuinamente ambiguo mirándolo solo. Lo que resuelve la ambigüedad es la
   * COLUMNA: basta que UNA fila traiga un valor > 12 en la primera posición para saber que ahí
   * van días, y con eso se lee toda la columna igual. Ver `detectarOrdenDeFecha`.
   *
   * ═══ Y EL DEFAULT ES `dmy`, QUE ES UNA DECISIÓN DE PRODUCTO ═══
   *
   * Cuando la columna no da evidencia —todos sus días son ≤ 12— hay que elegir, y se elige el
   * formato del mercado al que se le factura. Es además el sesgo seguro: leer `MM/DD` donde va
   * `DD/MM` es lo que produjo el bug, y el error inverso solo puede ocurrir con un archivo
   * exportado de un sistema en inglés cuya columna, encima, no tenga ni un día mayor a 12.
   */
  const conBarras = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (conBarras) {
    const a = Number(conBarras[1]);
    const b = Number(conBarras[2]);
    const anio = Number(conBarras[3]);
    const [dia, mes] = orden === 'mdy' ? [b, a] : [a, b];
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    // Un 31 de febrero desborda al mes siguiente: eso no es una fecha, es un dato malo.
    if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
    return d.toISOString().slice(0, 10);
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * `new Date(string)` CONVIERTE UN CÓDIGO DE CLIENTE EN UNA FECHA CREÍBLE
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Medido (2026-08-25), y no es un caso raro:
   *
   *     new Date("CLI-0001")  →  2001-01-01
   *     new Date("RUT-001")   →  2001-01-01
   *     new Date("PRY-002")   →  2001-02-01
   *
   * La especificación de JavaScript solo garantiza el parseo de ISO 8601; para cualquier otra
   * cadena el comportamiento queda a criterio del motor, y el de V8 es tan permisivo que un
   * identificador de catálogo sale convertido en una fecha perfectamente plausible.
   *
   * El daño es el mismo que el bloque de arriba ya evita para los NÚMEROS con su rango de
   * plausibilidad: si el mapa de columnas apunta a una columna de ID —y eso pasa: `ID Cliente`
   * es la primera columna de media base de archivos— cada fila entra con una fecha inventada
   * que ninguna validación puede desmentir, porque es una fecha válida. El camino de texto no
   * tenía esa guarda.
   *
   * Y encima desarma el filtro de catálogos: una hoja de clientes o de rutas "tiene fechas" en
   * su columna de código, así que no se reconoce como catálogo y se va al modelo. Fueron las
   * siete discrepancias que destapó la auditoría contra el validador de extracción.
   *
   * ═══ LISTA BLANCA, NO LISTA NEGRA ═══
   *
   * No se puede enumerar lo que `new Date` acepta de más — es la definición del problema. Se
   * enumera lo que SÍ es una fecha: los formatos que aparecen en los archivos reales. Todo lo
   * demás es `null`, y `staging-rules` marca la fila para revisión en vez de inventarle un día.
   */
  const FORMATOS_DE_FECHA = [
    // ISO, con o sin hora: `2025-05-01`, `2025-05-01T10:30:00`
    /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
    // Año primero con barras: `2025/05/01`
    /^\d{4}[/.]\d{1,2}[/.]\d{1,2}$/,
    // Mes en palabras: `05-May-2025`, `5 May 2025`, `May 5, 2025`, `1 de mayo de 2025`
    /^\d{1,2}[\s-]*(?:de\s+)?[a-zA-Z]{3,10}\.?[\s-]*(?:de\s+)?\d{2,4}$/,
    /^[a-zA-Z]{3,10}\.?\s+\d{1,2},?\s+\d{4}$/,
  ];
  if (!FORMATOS_DE_FECHA.some((re) => re.test(s))) return null;

  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * EL MES EN PALABRAS SE RESUELVE ACÁ, PORQUE `new Date` SOLO SABE INGLÉS
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * La lista blanca de arriba dice, textualmente, que acepta `1 de mayo de 2025`. **Nunca
   * funcionó.** El formato pasaba el regex —o sea que la forma se reconocía— y después
   * `new Date("15 de enero de 2026")` devolvía `Invalid Date`, así que la fila salía con
   * `date: null` y `staging-rules` la marcaba por `invalid_date`.
   *
   * Medido (2026-08-30): una hoja de nómina de 24 filas con fechas escritas
   * `15 de enero de 2026` perdía el 100 % de sus filas. Y como la hoja entera se queda sin
   * columna de fecha legible, `noPuedeProducirMovimientos` la descarta ANTES del modelo: no
   * son 24 filas marcadas que alguien pueda revisar, es una hoja que desaparece sin dejar
   * rastro en el dashboard.
   *
   * Esto no es un caso exótico: es un producto que factura en Guatemala y no sabía leer una
   * fecha escrita en español. `new Date` solo parsea nombres de mes en inglés, y de eso no
   * avisa — devuelve `Invalid Date` igual que ante basura.
   *
   * Se resuelve con una tabla explícita en vez de delegar, y de paso queda determinista: el
   * parseo de nombres de mes en `new Date` depende del motor, no de la especificación.
   */
  const conMesEnPalabras = MES_EN_PALABRAS(s);
  if (conMesEnPalabras) return conMesEnPalabras;

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  /*
   * Rango de plausibilidad de negocio, igual que en el camino numérico: un movimiento de una
   * PYME no ocurrió en 1901 ni va a ocurrir en 2200. Acota lo que un formato reconocido pero
   * mal escrito puede producir.
   */
  const anio = parsed.getUTCFullYear();
  if (anio < 1990 || anio > 2100) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * En qué orden vienen día y mes en una columna de fechas escritas con barras.
 *
 * Se decide con la COLUMNA entera porque una fila sola no alcanza: `01/05` es ambiguo, pero si
 * alguna fila de la misma columna dice `25/09`, ese 25 solo puede ser un día — y entonces todas
 * se leen igual. Basta UNA fila con evidencia; el resto de la columna la hereda.
 *
 * `dmy` cuando no hay evidencia: ver el bloque de `asDate`.
 */
export function detectarOrdenDeFecha(valores: unknown[]): 'dmy' | 'mdy' {
  let pruebaDMY = 0;
  let pruebaMDY = 0;

  for (const v of valores) {
    const s = asText(v);
    if (!s) continue;
    const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{4}$/.exec(s);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Solo cuenta lo que NO puede ser un mes. Un 13 en primera posición es un día, y punto.
    if (a > 12 && b <= 12) pruebaDMY++;
    if (b > 12 && a <= 12) pruebaMDY++;
  }

  /*
   * Si la columna se contradice —hay filas que exigen `dmy` y otras `mdy`— no hay orden que
   * la explique entera y el archivo está mal. Se elige `dmy` igual, que es el del mercado: la
   * alternativa sería inventar un criterio para datos que ya son inconsistentes.
   */
  return pruebaMDY > pruebaDMY ? 'mdy' : 'dmy';
}

/**
 * Moneda de la fila.
 *
 * Si la hoja no trae columna de moneda —el caso normal en los archivos reales— se usa la
 * moneda BASE de la empresa. Eso no es una suposición arriesgada: es el mismo default que
 * el modelo aplicaba antes, solo que ahora está escrito donde se puede leer y probar.
 */
/**
 * Cómo escribe la gente las dos monedas que el producto sí maneja.
 *
 * Reconocerlas no es cosmético: sin esto, una hoja que rotula la columna `Q` o `US$` caía al
 * `else` de abajo y se marcaba como moneda inválida — o, antes de este arreglo, se relabelaba
 * en silencio.
 */
const ALIAS_DE_MONEDA: Record<string, string> = {
  GTQ: 'GTQ', Q: 'GTQ', QTZ: 'GTQ', QUETZAL: 'GTQ', QUETZALES: 'GTQ', 'Q.': 'GTQ',
  USD: 'USD', US$: 'USD', 'US.': 'USD', DOLAR: 'USD', DOLARES: 'USD', DÓLAR: 'USD',
  'DÓLARES': 'USD', DOLLAR: 'USD', DOLLARS: 'USD', 'U$S': 'USD', USS: 'USD',
}; // prettier-ignore

/**
 * Monedas que EXISTEN y que este producto no sabe convertir.
 *
 * Se enumeran para poder DISTINGUIRLAS de un rótulo ilegible, y esa distinción es todo el
 * punto de la lista: ver el bloque de `asCurrency`.
 */
const OTRAS_MONEDAS = new Set([
  'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'MXN', 'COP', 'CRC', 'HNL', 'NIO',
  'BZD', 'SVC', 'PAB', 'DOP', 'PEN', 'CLP', 'ARS', 'BRL', 'UYU', 'BOB', 'PYG', 'VES',
]); // prettier-ignore

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA MONEDA QUE NO SOPORTAMOS NO SE RENOMBRA A LA NUESTRA (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La versión anterior era `return upper === 'GTQ' || upper === 'USD' ? upper : baseCurrency`,
 * o sea que **cualquier cosa que no fuera esas dos se relabelaba a la moneda de la empresa**.
 * Una fila que dice `EUR` se guardaba como `GTQ`: €100 entraban como Q100, subestimando ~8,4
 * veces, y `staging-rules` no podía desmentirlo porque el payload ya decía `GTQ`, que es
 * válido. El dato quedaba mal y nada fallaba.
 *
 * La confusión estaba en tratar igual dos cosas distintas:
 *
 *   · **La celda está vacía** → la hoja no dice la moneda, y usar la de la empresa es
 *     correcto: es la suposición que el cliente haría. Sigue igual.
 *   · **La celda dice una moneda que no soportamos** → la hoja SÍ lo dice, y nosotros lo
 *     estamos ignorando. Ahí la respuesta honesta es dejar el valor tal cual para que
 *     `staging-rules` la marque `invalid_currency` y la fila vaya a revisión: visible, en vez
 *     de silenciosamente mal.
 *
 * Un rótulo que no es NINGUNA moneda conocida (basura, un encabezado repetido, una nota) sigue
 * cayendo a la base, que es el comportamiento de siempre: ahí no hay una afirmación que
 * respetar. Por eso hacen falta las dos listas y no bastaría con una.
 */
function asCurrency(value: unknown, baseCurrency: string): string {
  const s = asText(value);
  if (!s) return baseCurrency;
  const upper = s.toUpperCase().replace(/\s+/g, '');
  const alias = ALIAS_DE_MONEDA[upper];
  if (alias) return alias;
  if (OTRAS_MONEDAS.has(upper)) return upper;
  return baseCurrency;
}

/**
 * Construye el payload de una fila, con la MISMA forma que devolvía el modelo antes.
 *
 * `quantity` sigue distinguiendo `null` de `0`: null es "esta fila no habla de unidades" (un
 * alquiler, un total) y 0 son cero unidades. Sobre el primero no se puede promediar. Es la
 * misma regla que el prompt le exigía al modelo, ahora garantizada por código en vez de por
 * instrucción — que es estrictamente más fiable.
 */
/**
 * El costo de ESTA fila, si la hoja lo trae. `null` = no hay costo que registrar.
 *
 * Se prefiere el total de línea cuando existe: es un dato directo del archivo. El unitario
 * solo se usa multiplicado por las unidades, y **solo si la fila trae unidades** — sin ellas
 * no se puede saber el costo de la línea, y la respuesta correcta es no inventarlo. Esa es la
 * misma regla que el prompt ya exige para `quantity`: si la fila no dice cuántas, no sabemos
 * cuántas.
 */
export function costoDeLaFila(row: unknown[], columns: ColumnMap): number | null {
  const total = asNumber(cell(row, columns.costTotal));
  if (total !== null) return Math.abs(total);

  const unitario = asNumber(cell(row, columns.costUnit));
  const unidades = asNumber(cell(row, columns.quantity));
  if (unitario === null || unidades === null) return null;
  return Math.abs(unitario * unidades);
}

export function assemblePayload(params: {
  verdict: RowVerdict;
  row: unknown[];
  columns: ColumnMap;
  baseCurrency: string;
  /**
   * En qué orden vienen día y mes en las fechas con barras de ESTA hoja, deducido de la
   * columna entera (`detectarOrdenDeFecha`). Sin él se usa `dmy`, el formato del mercado.
   *
   * No es un ajuste: leer `MM/DD` donde va `DD/MM` no falla, mueve el movimiento de MES — y
   * eso no lo detecta nadie hasta que el cliente no reconoce su propio trimestre.
   */
  ordenDeFecha?: 'dmy' | 'mdy';
}): Record<string, unknown> {
  const { verdict, row, columns, baseCurrency, ordenDeFecha } = params;

  /*
   * EL SIGNO SE DESCARTA, Y ES OBLIGATORIO — no una comodidad.
   *
   * Muchos exportes traen los gastos en negativo ("Planilla enero, -18.000"). La dirección
   * del movimiento no la lleva el signo: la lleva `type` (revenue vs. cogs/opex). Y aguas
   * abajo `staging-rules.ts` exige `isPositiveFiniteNumber` en las dos formas de payload,
   * así que un monto negativo NO se guarda con el signo — se marca `invalid_amount` y la
   * fila se va a revisión interna.
   *
   * Esto lo hacía el modelo sin que estuviera escrito en ningún lado (se ve en los ejemplos
   * few-shot: entra -18000, sale 18000). Al dejar de pedirle los valores había que traerlo
   * al código, o una hoja de gastos exportada en negativo se habría marcado ENTERA. No lo
   * atrapó ningún test: lo atrapó leer qué valida `staging-rules` antes de dar por bueno el
   * cambio.
   */
  const bruto = asNumber(cell(row, columns.amount));
  const amount = bruto === null ? null : Math.abs(bruto);
  const currency = asCurrency(cell(row, columns.currency), baseCurrency);

  if (verdict.targetEntity === 'transaction') {
    return {
      type: verdict.type ?? 'other',
      category: verdict.category,
      date: asDate(cell(row, columns.date), ordenDeFecha),
      description: asText(cell(row, columns.description)),
      originalAmount: amount,
      originalCurrency: currency,
      product: asText(cell(row, columns.product)),
      quantity: asNumber(cell(row, columns.quantity)),
      productCategory: asText(cell(row, columns.productCategory)),
      store: asText(cell(row, columns.store)),
    };
  }

  // invoice / bill comparten forma (AR/AP).
  return {
    counterparty: asText(cell(row, columns.counterparty)),
    issueDate: asDate(cell(row, columns.date), ordenDeFecha),
    dueDate: asDate(cell(row, columns.dueDate), ordenDeFecha),
    originalAmount: amount,
    originalCurrency: currency,
  };
}
