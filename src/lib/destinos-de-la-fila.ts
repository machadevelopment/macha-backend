/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * A QUÉ PANTALLAS LLEGA CADA FILA — EL MAPA COMPLETO (reporte de Jose, 2026-09-01/02)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"La data no va únicamente al dashboard: cargamos un Excel y esa data viaja tanto al
 * dashboard como a las otras secciones que tenemos… si ponemos solo los del dashboard y el
 * campo va a cuentas por pagar, no lo estamos registrando."*
 *
 * Y la segunda vuelta, que es la que fija el alcance de este archivo: *"solo añadiste dos,
 * debería ser bueno mostrar absolutamente todas las que tenemos en Macha. En Analítica tenemos
 * ingresos, flujo de caja, costos, por cobrar y por pagar. Luego ventas por producto, y luego
 * inventario. No solo los campos del dashboard."*
 *
 * Tiene razón, y el hueco es exactamente ese. El portón (migración 0042) le enseña al dueño el
 * DINERO de cada hoja y con qué TIPO entró —ingreso, costo, gasto—, que son los rubros del
 * dashboard. Pero una fila también aterriza en `invoices` (Por cobrar), en `bills` (Por pagar),
 * en la serie mensual (Flujo de caja), en Ventas por producto, en Ventas por tienda o en el
 * inventario, y de eso la pantalla no decía nada. El dueño aprobaba su archivo mirando una
 * parte de lo que ese archivo hace.
 *
 * Y no hace falta inventar nada: **el destino ya está determinado en la fila de staging**. Lo
 * único que faltaba era decirlo, entero.
 *
 *   · `targetEntity` decide la tabla: `transaction` → ledger, `invoice` → Por cobrar,
 *     `bill` → Por pagar.
 *   · `type` decide el rubro (`revenue` → Ingresos, `cogs`/`opex` → Costos).
 *   · `product` decide si la fila alimenta Ventas por producto; `store`, Ventas por tienda.
 *
 * ═══ POR QUÉ VIVE ACÁ Y NO EN EL HANDLER NI EN EL FRONTEND ═══
 *
 * Porque la misma pregunta la hacen TRES lados —el portón, que la muestra por hoja antes de
 * publicar; el resumen de lectura, que la explica después; y la tarjeta de conceptos, que
 * ahora enseña a dónde va a parar cada respuesta ANTES de contestarla— y este repo ya pagó
 * varias veces la lección de las dos copias que se separan (`esArreglablePorCategoria`,
 * `cumpleFirma`, `mesPorNombre`). Si el portón dijera "esto va a Por pagar" y la tarjeta no,
 * el cliente dejaría de creerle a las dos.
 *
 * ⚠️ En particular, la lista de OPCIONES de la tarjeta se calcula acá y viaja al frontend ya
 * resuelta. Escribirla en el componente sería la copia número dos del mapa de destinos, en el
 * único lugar donde una divergencia se le muestra al cliente como una promesa.
 *
 * ⚠️ NO se derivan destinos de la ENTIDAD sola cuando el tipo los precisa. Una `bill` va a Por
 * pagar **y** a Costos, porque desde el 2026-08-30 una factura recibida produce su costo; una
 * `invoice` va a Por cobrar **y** a Ingresos, porque emitirla devenga. Listar solo la cuenta
 * escondería justamente la mitad que el cliente ve en su dashboard.
 */

/** Las pantallas del producto, con el nombre que el cliente lee en el menú. */
export type Destino =
  /** Panorama y Analítica → Ingresos. */
  | 'ingresos'
  /** Panorama y Analítica → Costos: costo de ventas y gastos operativos. */
  | 'costos'
  /**
   * Analítica → Flujo de caja.
   *
   * ⚠️ Lo alcanza TODA fila que suma en el estado de resultados, incluidas las facturas: la
   * serie mensual sale de `monthly_rollups`, que se calcula sobre `transactions` (verificado:
   * las tres consultas de `rollups.ts` leen esa tabla), y una factura emitida deriva su fila de
   * ingreso igual que una recibida deriva su costo. Se lista aparte y no se da por sobrentendido
   * porque es una entrada propia del menú y el dueño la nombró como tal.
   */
  | 'flujo'
  /** Analítica → Por cobrar, con su antigüedad y su concentración por cliente. */
  | 'porCobrar'
  /** Analítica → Por pagar, con su antigüedad y su concentración por proveedor. */
  | 'porPagar'
  /** Ventas por producto. */
  | 'productos'
  /** Ventas por producto → el desglose por tienda. */
  | 'tiendas'
  /** Inventario. */
  | 'inventario'
  /**
   * Entró al ledger pero ninguna pantalla lo suma.
   *
   * ⚠️ Es el caso de `type: 'other'`, y decirlo es el punto: `rollups.ts` suma `revenue`,
   * `cogs` y `opex`, así que una fila `other` se guarda y **no aparece en ninguna cifra**. Jose
   * preguntó por escrito dónde caía eso ("¿y si fuera otro movimiento, en dónde lo registra?")
   * y la respuesta honesta es "en ningún lado que se vea". Mostrarlo es lo que le permite
   * corregirlo ANTES de publicar en vez de descubrirlo por una cifra que no cuadra.
   */
  | 'sinPantalla';

export type EntidadDeFila = 'transaction' | 'invoice' | 'bill';

/** Lo que la fila trae y que decide destinos además del tipo. */
export type SenalesDeFila = {
  /** Trae una columna de producto con valor: alimenta Ventas por producto. */
  producto?: boolean;
  /** Trae una columna de tienda con valor: alimenta el desglose por tienda. */
  tienda?: boolean;
};

/**
 * El núcleo: a qué pantallas llega una fila con esta entidad, este tipo y estas señales.
 *
 * Vive separado de `destinosDeLaFila` porque la tarjeta de conceptos necesita responder la
 * misma pregunta sobre una fila que TODAVÍA NO EXISTE — "si contestás que esto es un gasto,
 * ¿dónde va a aparecer?" — y no hay payload que mirar. Un segundo cálculo para ese caso sería
 * la copia que este archivo existe para no tener.
 */
export function destinosDe(params: {
  entity: EntidadDeFila;
  type: string | null;
  senales?: SenalesDeFila;
}): Destino[] {
  const { entity, type } = params;
  const senales = params.senales ?? {};
  const out = new Set<Destino>();

  if (entity === 'invoice') out.add('porCobrar');
  if (entity === 'bill') out.add('porPagar');

  /*
   * El rubro del estado de resultados. Va para las tres entidades y no solo para `transaction`:
   * la factura emitida devenga su ingreso y la recibida produce su costo, así que las dos
   * aparecen en el estado de resultados además de en su cuenta.
   */
  if (type === 'revenue') out.add('ingresos');
  if (type === 'cogs' || type === 'opex') out.add('costos');

  /*
   * Flujo de caja es la MISMA serie mensual que alimentan los rubros de arriba, así que se
   * agrega exactamente cuando alguno de los dos entró. Derivarlo de la entidad daría el
   * resultado equivocado en las dos direcciones: una `transaction` de tipo `other` no aparece
   * en la serie, y una `invoice` sí.
   */
  if (out.has('ingresos') || out.has('costos')) out.add('flujo');

  /*
   * `other` entra al ledger y NO lo suma ninguna pantalla. Se dice explícitamente en vez de
   * omitirlo: una fila sin destino visible es lo que el dueño necesita ver antes de publicar.
   */
  if (type === 'other') out.add('sinPantalla');

  /*
   * Ventas por producto agrupa por `product` sobre los INGRESOS. Una compra con producto no
   * aparece ahí, así que se exige el ingreso además de la columna. Y el desglose por tienda
   * vive dentro de esa misma pantalla, sobre las mismas ventas: sin ingreso no hay tienda que
   * mostrar, por más que la fila traiga la columna.
   */
  if (out.has('ingresos')) {
    if (senales.producto) out.add('productos');
    if (senales.tienda) out.add('tiendas');
  }

  return [...out];
}

/** Si la celda trae algo que valga como señal. Un `0` no es un producto ni una tienda. */
function conTexto(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/** Las señales que trae un payload de staging. */
export function senalesDelPayload(payload: Record<string, unknown>): SenalesDeFila {
  return { producto: conTexto(payload.product), tienda: conTexto(payload.store) };
}

/**
 * A qué pantallas llega una fila de staging.
 *
 * Devuelve un conjunto porque una sola fila llega a varias: una factura emitida es a la vez
 * ingreso del período, cuenta por cobrar y un punto de la serie de flujo.
 */
export function destinosDeLaFila(fila: {
  targetEntity: EntidadDeFila;
  payload: Record<string, unknown>;
}): Destino[] {
  return destinosDe({
    entity: fila.targetEntity,
    type: typeof fila.payload.type === 'string' ? fila.payload.type : null,
    senales: senalesDelPayload(fila.payload),
  });
}

/** Los destinos de una hoja entera: la unión de los de sus filas. */
export function destinosDeLaHoja(
  filas: { targetEntity: EntidadDeFila; payload: Record<string, unknown> }[],
): Destino[] {
  const out = new Set<Destino>();
  for (const f of filas) for (const d of destinosDeLaFila(f)) out.add(d);
  return [...out];
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * LAS OPCIONES QUE VE EL CLIENTE EN LA TARJETA DE CONCEPTOS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"Que se muestren todas siempre, de una manera bonita y ordenada… todas las opciones en
 * donde registremos data."*
 *
 * Antes eran cuatro tarjetas —los `type` del estado de resultados— y dos más que aparecían
 * **solo a veces**, cuando el concepto era un movimiento y salía de una sola hoja. Que una
 * opción aparezca o no según la fila es lo que el dueño reportó como inconsistente, y tiene
 * razón por una razón más profunda que la estética: una lista que cambia no se puede aprender.
 * El cliente no llega a saber qué puede contestar.
 *
 * Ahora la lista es SIEMPRE la misma y completa. Lo que cambia es si una opción está
 * disponible, y cuando no lo está **se dice por qué** en vez de desaparecer.
 */

/** Cada respuesta que el cliente puede dar, con el efecto que tiene. */
export type ClaveDeOpcion = 'revenue' | 'cogs' | 'opex' | 'other' | 'invoice' | 'bill';

export type OpcionDeRespuesta = {
  clave: ClaveDeOpcion;
  /**
   * Cómo se aplica.
   *
   * ⚠️ `tipo` contesta el concepto por el POST de siempre; `entidad` REPROCESA la hoja. No son
   * dos sabores de lo mismo y la tarjeta tiene que poder distinguirlos: cambiar la entidad
   * exige releer el archivo, porque el payload de una `transaction` no guarda `counterparty`
   * ni `dueDate` — y sin el vencimiento el aging manda la cartera entera a "corriente"
   * (medido: GTQ 6.250 en `current` para una hoja sin esa columna).
   */
  aplica: 'tipo' | 'entidad';
  /** A qué pantallas va a llegar el concepto si el cliente elige esto. */
  destinos: Destino[];
  /** `false` pinta la tarjeta apagada, nunca la esconde. */
  disponible: boolean;
  /** Por qué no se puede elegir. Solo cuando `disponible` es `false`. */
  motivo?: 'yaEsAsi' | 'variasHojas';
};

/** Las cuatro que se contestan con el POST de conceptos, en el orden en que se leen. */
const TIPOS: ClaveDeOpcion[] = ['revenue', 'cogs', 'opex', 'other'];

/**
 * La lista completa de respuestas para un concepto, con los destinos de cada una ya resueltos.
 *
 * ⚠️ Los destinos de las cuatro primeras se calculan sobre la entidad ACTUAL del concepto, y
 * ahí está la mitad del pedido de Jose: para una fila que ya es una cuenta por cobrar,
 * contestar "es un ingreso" no la manda solo al dashboard — la deja en Por cobrar Y en
 * Ingresos. Calcularlas siempre como `transaction` volvería a mostrar únicamente los rubros
 * del dashboard, que es exactamente el hueco que se está cerrando.
 */
export function opcionesParaConcepto(params: {
  entity: EntidadDeFila;
  /** `null` si sus filas salen de varias hojas: ahí la entidad no se puede cambiar. */
  hoja: string | null;
  senales?: SenalesDeFila;
}): OpcionDeRespuesta[] {
  const { entity, hoja } = params;
  const senales = params.senales ?? {};

  const deTipo: OpcionDeRespuesta[] = TIPOS.map((clave) => ({
    clave,
    aplica: 'tipo',
    destinos: destinosDe({ entity, type: clave, senales }),
    disponible: true,
  }));

  const deEntidad: OpcionDeRespuesta[] = (['invoice', 'bill'] as const).map((clave) => {
    /*
     * El tipo que va a tener después del reproceso lo decide el modelo al releer la hoja, así
     * que acá se declara el que la regla contable GARANTIZA: una factura emitida devenga
     * ingreso (2026-08-19) y una recibida produce su costo (2026-08-30). Es lo único que se
     * puede prometer sin adivinar.
     */
    const tipo = clave === 'invoice' ? 'revenue' : 'cogs';
    /*
     * `yaEsAsi` gana a `variasHojas`: si el concepto YA es una cuenta por cobrar, el motivo
     * útil es ese y no de cuántas hojas sale. Al revés, un concepto que ya está donde debe
     * mostraría un impedimento que no le importa a nadie.
     */
    const motivo = entity === clave ? 'yaEsAsi' : hoja === null ? 'variasHojas' : undefined;
    return {
      clave,
      aplica: 'entidad',
      destinos: destinosDe({ entity: clave, type: tipo, senales }),
      disponible: motivo === undefined,
      ...(motivo ? { motivo } : {}),
    };
  });

  return [...deTipo, ...deEntidad];
}
