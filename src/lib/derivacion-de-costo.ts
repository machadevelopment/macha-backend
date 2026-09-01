/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL COSTO DE UNA CUENTA POR PAGAR, DERIVADO POR LOS DOS CAMINOS QUE PUEDEN CREARLO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La regla ya existía y estaba a medias. `construirFilas` deriva el costo de una `bill`
 * CUANDO EL MODELO da el tipo (`anthropic.ts`, punto 14 del prompt); si no lo da, la cuenta
 * por pagar se registra igual y la fila se va a revisión — que es lo correcto, porque elegir
 * entre `cogs` y `opex` por defecto mueve el margen bruto.
 *
 * Lo que faltaba es el OTRO camino. Desde el acuerdo con Semi (2026-08-20) esa fila la
 * contesta EL CLIENTE, y el handler de `POST /documents/:id/conceptos` solo actualizaba
 * `payload.type`, limpiaba el flag y promovía. La fila iba a `bills`, nadie derivaba su
 * transacción, y `rollups.ts` suma `cogs`/`opex` únicamente de `transactions`.
 *
 * MEDIDO EN PRODUCCIÓN (2026-09-01, archivo `12-la-ceiba.xlsx`): 12 órdenes de compra por
 * **GTQ 56.391,00** — el 82 % del costo real de ese libro. El cliente contestó "es un costo",
 * las filas marcadas bajaron de 15 a 3, el panel dijo que estaba listo, y el estado de
 * resultados **no se movió**; el rubro que escribió no aparecía en ninguna categoría y el
 * margen bruto salía en 55,4 % cuando el real era mucho menor.
 *
 * Es la forma exacta del bug de U3TECH —dato bien leído, bien clasificado, bien guardado, y
 * el dashboard no lo muestra— pero peor: acá le dijimos al cliente que lo había resuelto. La
 * pantalla existe para que su contabilidad quede 100 % atinada; una respuesta que no mueve la
 * cifra es la única forma de fallo que no puede tener.
 *
 * ═══ POR QUÉ VIVE ACÁ Y NO EN CADA LLAMADOR ═══
 *
 * Porque son DOS productores de la misma fila del ledger, y si divergen el mismo archivo da
 * cifras distintas según quién clasificó la fila —el modelo o el dueño—. Es la lección que
 * este repo ya aprendió con `esArreglablePorCategoria` (el correo prometía un número y la
 * pantalla mostraba otro) y con `cumpleFirma`.
 */

/**
 * Marca que la ingesta puso en el payload de una `bill` cuya derivación SUPRIMIÓ a propósito
 * porque el libro ya registraba esa compra en otra hoja (`compraYaRegistradaEnOtraHoja`).
 *
 * ⚠️ Sin esta marca el arreglo se come su propia guarda: la fila llega a revisión sin tipo
 * —igual que una que el modelo no supo clasificar— y son INDISTINGUIBLES desde el handler de
 * la respuesta, que no ve el esquema del libro. El cliente contestaría y el costo entraría
 * por segunda vez, que es exactamente lo que `compraYaRegistradaEnOtraHoja` existe para
 * evitar. El caso real que la motivó (`Compras` + `CuentasPorPagar` apuntando a las mismas
 * compras) volvería con otra puerta.
 */
export const SIN_DERIVAR = 'derivacionSuprimida';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MARCA DE FILA DERIVADA: SU TIPO LO DECIDIÓ UNA REGLA CONTABLE, NO EL NOMBRE DEL PRODUCTO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El pipeline crea filas que NO están en el archivo: el costo de una venta que trae su costo en
 * la línea, el ingreso devengado de una factura emitida, el costo de una cuenta por pagar. Su
 * tipo no es una interpretación del texto de la fila — es una regla contable, y por eso no se
 * le pregunta al cliente.
 *
 * ⚠️ SIN ESTA MARCA, LA RESPUESTA DEL CLIENTE LAS PISA. Medido en producción el 2026-09-01: el
 * concepto "Aceite 1 L" agrupaba DOS filas —la venta de GTQ 1.890 y su costo derivado de
 * GTQ 1.160, que comparten `product`—. El dueño contestó "es un ingreso", que es CIERTO de su
 * venta, y con eso convirtió el costo en ingreso: **+1.160 de ingreso y −1.160 de costo**. El
 * total del archivo cuadraba al centavo, así que era invisible; lo que se movía era el MARGEN
 * BRUTO, que es cifra de portada.
 *
 * Y agrupar por producto es correcto y no se va a cambiar: es lo que hace contestable la
 * pantalla cuando la hoja no trae descripción. Lo que estaba mal era aplicarle al costo una
 * respuesta que el dueño dio sobre la venta.
 */
export const ES_DERIVADA = 'derivadaDelPipeline';

/** ¿Esta fila la creó el pipeline a partir de otra? Su tipo no lo contesta el cliente. */
export function esFilaDerivada(payload: Record<string, unknown>): boolean {
  return payload[ES_DERIVADA] === true;
}

/** Los dos únicos tipos que una factura de proveedor puede producir. */
export type TipoDeEgreso = 'cogs' | 'opex';

export function esTipoDeEgreso(v: unknown): v is TipoDeEgreso {
  return v === 'cogs' || v === 'opex';
}

/**
 * ¿Esta `bill` YA tiene su transacción de costo en el ledger?
 *
 * Se responde mirando el payload tal como quedó de la INGESTA, antes de aplicarle la
 * respuesta del cliente. Dos casos, y los dos significan "no derivar":
 *
 *  · trae un tipo válido → `construirFilas` ya la derivó en su momento (el modelo dio `t`);
 *  · trae la marca de supresión → el libro ya registra esa compra en otra hoja.
 *
 * Cualquier otro caso es el que este módulo vino a cubrir: la cuenta por pagar existe y su
 * costo no.
 */
export function yaTieneSuCosto(payloadOriginal: Record<string, unknown>): boolean {
  if (payloadOriginal[SIN_DERIVAR] === true) return true;
  return esTipoDeEgreso(payloadOriginal.type);
}

/**
 * El payload de la transacción de costo que corresponde a una cuenta por pagar.
 *
 * Se ARMA DE NUEVO a partir de los campos de la `bill`, nunca por spread: las dos formas son
 * distintas —la cuenta por pagar lleva `issueDate` y `counterparty`, la transacción lleva
 * `date`, `type` y `category`— y un spread deja la fila sin `date`, marcada entera por
 * `invalid_date`. Es el error exacto que cometió el primer intento de la factura emitida y
 * que su comentario dejó escrito.
 *
 * LA FECHA ES LA DE EMISIÓN, nunca la de vencimiento: el costo se devenga cuando se recibe la
 * factura, y usar el vencimiento lo movería de período — el error que comete la contabilidad
 * de caja y que este producto no debería.
 *
 * Devuelve `null` cuando no hay con qué armar una fila válida (sin monto o sin fecha). No se
 * inventa nada: la cuenta por pagar ya quedó registrada y es preferible un costo ausente y
 * visible a uno inventado que nadie puede desmentir.
 */
export function costoDeCuentaPorPagar(params: {
  payload: Record<string, unknown>;
  type: TipoDeEgreso;
  category: string;
}): Record<string, unknown> | null {
  const { payload, type, category } = params;

  const monto = payload.originalAmount;
  if (typeof monto !== 'number' || !Number.isFinite(monto) || monto === 0) return null;

  const fecha = payload.issueDate;
  if (typeof fecha !== 'string' || fecha === '') return null;

  return {
    type,
    category,
    date: fecha,
    // La contraparte de la factura es lo único que describe el hecho: sin esto la fila del
    // ledger queda sin nombre y el cliente no puede reconocerla en su propio dashboard.
    description: typeof payload.counterparty === 'string' ? payload.counterparty : null,
    originalAmount: Math.abs(monto),
    originalCurrency:
      typeof payload.originalCurrency === 'string' ? payload.originalCurrency : null,
    product: null,
    quantity: null,
    productCategory: null,
    store: null,
  };
}
