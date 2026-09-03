import { filaEsRenglonDeTotal } from './sheet-unpivot';
/**
 * Decide POR REGLA, leyendo los encabezados, si una hoja contiene movimientos financieros.
 *
 * ═══ POR QUÉ EXISTE ═══
 *
 * Los archivos reales de los clientes no son exportes contables: son volcados operativos
 * completos de su sistema. Los tres de prueba (2026-08-12) traen ocho hojas cada uno:
 *
 *     Ventas · LineasOC · OrdenesCompra   → movimientos financieros    (~800 filas)
 *     Clientes · Proveedores · Tiendas
 *     Productos · Inventario              → CATÁLOGOS, no movimientos  (~370 filas)
 *
 * Hoy las ocho van a Claude, incluidas las cinco de catálogo, para que el modelo conteste
 * que no son transacciones. Con el 95,7 % del costo en tokens de SALIDA (medido 2026-08-12),
 * eso es pagar por que nos digan que no hay nada que clasificar — y encima esperar por ello.
 *
 * Una hoja cuyos encabezados son `IDCliente, Nombre, Apellido, Email, Telefono` no necesita
 * un modelo de lenguaje para descartarse. Es la regla de oro del costo: no mandarle a la IA
 * lo que resuelve el código.
 *
 * ═══ EL SESGO ES DELIBERADO Y VA HACIA PAGAR DE MÁS ═══
 *
 * `unknown` significa "no estoy seguro" y SIEMPRE va al modelo. Solo se descarta una hoja
 * cuando la evidencia es clara y positiva.
 *
 * El motivo es la asimetría de los dos errores. Descartar de más pierde datos financieros
 * del cliente EN SILENCIO: no aparecen en su dashboard, nadie lo nota, y el cliente toma
 * decisiones sobre números incompletos. Descartar de menos solo cuesta lo que ya cuesta hoy.
 * Entre pagar de más y perder contabilidad, se paga de más.
 *
 * ═══ POR QUÉ ENCABEZADOS Y NO NOMBRE DE HOJA ═══
 *
 * El nombre es una pista débil: un cliente puede llamarle "Hoja1" a sus ventas o "Datos" a
 * su catálogo. Los encabezados describen lo que la hoja CONTIENE, y esa señal sobrevive a
 * que el archivo venga de otro sistema o en otro idioma.
 */

export type SheetKind =
  /** Movimientos financieros: va al modelo. */
  | 'financial'
  /** Catálogo o maestro: NO va al modelo. */
  | 'catalog'
  /** No se puede afirmar. Va al modelo, que es el lado seguro. */
  | 'unknown';

/**
 * Normaliza un encabezado: sin paréntesis, sin acentos, sin separadores, en minúsculas.
 *
 * LO DE LOS PARÉNTESIS NO ES COSMÉTICO. "Precio Unitario (Q)" se normalizaba a
 * `preciounitarioq`, con la moneda pegada al final, y eso NO coincide con `preciounitario`
 * —que sí está en la lista de señales de dinero—. Toda hoja que rotule sus montos con la
 * moneda entre paréntesis, que es lo normal en Guatemala, se quedaba sin ninguna señal.
 *
 * Medido sobre un archivo real (2026-08-14): la hoja de ventas de una cafetería, con `Fecha`,
 * `Precio Unitario (Q)`, `Ingreso Total (Q)` y `Costo Total (Q)`, salía `unknown` — o sea que
 * el pre-filtro no reconocía como financiera una hoja que es puramente financiera.
 *
 * Lo que va entre paréntesis es una anotación de unidad o moneda, no parte del nombre de la
 * columna. Se quita ANTES de borrar la puntuación, porque después ya es indistinguible.
 */
export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Señales de que la hoja SÍ es un movimiento: algo que pasó, con dinero y una fecha.
 *
 * Se piden las dos familias juntas —dinero Y fecha— porque cada una sola aparece también en
 * catálogos: `Productos` tiene precio y costo sin ser un movimiento, y `Clientes` tiene
 * fecha de registro sin serlo tampoco. Un movimiento es dinero CON momento.
 */
/**
 * Vocabulario de columnas de dinero.
 *
 * Se EXPORTA para que `lib/sheet-money.ts` estime cuánto dinero trae una hoja que el modelo
 * nunca vio. Tiene que ser la misma lista: dos vocabularios de dinero que se separan producen
 * una hoja que se clasifica como financiera por una y se mide con la otra, o al revés — y esa
 * incoherencia sería invisible, porque las dos cifras seguirían pareciendo razonables.
 */
export const MONEY_HINTS = [
  'total',
  'totallinea',
  'monto',
  'montototal',
  'importe',
  'precio',
  'preciounitario',
  'costo',
  'costounitario',
  'debe',
  'haber',
  'debito',
  'credito',
  'cargo',
  'abono',
  'utilidadbruta',
  'subtotal',
];

const DATE_HINTS = [
  'fecha',
  'fechaorden',
  'fechaemision',
  'fechavencimiento',
  'fechapago',
  'fechamovimiento',
  'fechatransaccion',
  'date',
  'periodo',
  'mes',
  'mesorden',
];

/**
 * Señales de CATÁLOGO: describen una entidad que existe, no algo que pasó.
 *
 * Son deliberadamente específicas. `nombre` o `email` sueltos no bastan —una fila de venta
 * puede traer el nombre del cliente— así que se exige un conjunto que solo tiene sentido en
 * un maestro: datos de contacto, de ubicación física, o de existencias.
 */
const CATALOG_SIGNATURES: {
  name: string;
  needed: string[];
  min: number;
  /** Además de `needed`, la hoja tiene que traer AL MENOS UNA de estas. */
  ademas?: string[];
  /** Y al menos una de estas otras. */
  yTambien?: string[];
  /** Si trae alguna de estas, la firma NO aplica. Ver la firma de existencias sin bodega. */
  prohibidas?: string[];
}[] = [
  {
    /*
     * Clientes / Proveedores: contacto de una persona o empresa.
     *
     * ═══ `nit` Y `condiciones` SE AGREGARON POR UNA CARTERA QUE SE VOLVIÓ INGRESOS ═══
     *
     * La hoja `Clientes_B2B` de un archivo real (2026-08-28) es una cartera de clientes con
     * DATOS FISCALES en vez de personales:
     *
     *     Cliente · NIT · Tipo · Contacto · Teléfono · Condiciones ·
     *     Venta neta acumulada · Unidades · Última compra · Saldo por cobrar
     *
     * Daba 2 coincidencias contra el mínimo de 3 —`contacto` y `telefono`, pero NO `nombre`,
     * porque la columna se llama "Cliente"— así que se fue al modelo. Y el modelo hizo lo
     * único que podía con ella: leyó `Última compra` como la fecha y `Saldo por cobrar` como
     * el monto, y registró Q 13.362,75 de INGRESOS que no son una venta del período sino la
     * cartera pendiente de cobro. Fue la única cifra que llegó al dashboard de ese cliente.
     *
     * Las dos columnas nuevas son de la MISMA naturaleza que el resto de la firma —cómo se
     * ficha a una contraparte, no cómo se registra un hecho— y no aparecen en una hoja de
     * movimientos: una línea de venta no lleva las condiciones de crédito de su cliente.
     * `nombre` se queda porque sigue cubriendo los catálogos de personas.
     *
     * El empate con `looksFinancial` sigue mandando al modelo, así que una hoja que ADEMÁS
     * traiga columna de dinero Y de fecha reconocidas no se descarta por esto.
     */
    name: 'contactos',
    needed: [
      'email',
      'telefono',
      'contacto',
      'nombre',
      'apellido',
      'nivellealtad',
      'genero',
      'nit',
      'condiciones',
    ],
    min: 3,
  },
  {
    // Tiendas / sucursales: ubicación física.
    name: 'ubicaciones',
    needed: ['ciudad', 'pais', 'superficiem2', 'gerente', 'tipotienda', 'fechaapertura'],
    min: 3,
  },
  {
    // Inventario: existencias, no movimientos.
    name: 'existencias',
    needed: [
      'cantidaddisponible',
      'puntoreorden',
      'cantidadreorden',
      'ubicacion',
      'alertareorden',
      'stock',
      'existencia',
      // Los mismos conceptos con los nombres que usa otro sistema (archivo real de una
      // cafetería): "Stock Actual", "Stock Mínimo", "Unidad de Medida", "ID_Insumo".
      'stockactual',
      'stockminimo',
      'unidaddemedida',
      'idinsumo',
      'insumo',
    ],
    min: 2,
  },
  {
    /*
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * EXISTENCIAS SIN VOCABULARIO DE BODEGA: LA SEÑAL ES QUE NO HAY FECHA
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * La firma de arriba busca cómo una BODEGA nombra sus columnas (`stock`, `punto de
     * reorden`, `unidad de medida`), y nació de una cafetería. Un inventario de mostrador no
     * usa ninguna de esas palabras:
     *
     *     Ferretería   SKU · Producto · Categoria · Cantidad · Costo Unitario · Precio Lista
     *     Boutique     SKU · Prenda · Talla · Cantidad · Costo Unitario · Precio Venta
     *
     * Las dos daban 0 coincidencias y se iban a MOVIMIENTOS: 154 artículos de la ferretería
     * como si fueran transacciones, sumando Q 9.438.823 de costo que nadie gastó. Es el bug
     * de CarsGT otra vez —el inventario contado como costo de ventas— por otra puerta.
     *
     * ═══ POR QUÉ NO ALCANZA "CANTIDAD + COSTO + PRODUCTO" ═══
     *
     * Porque una hoja de ventas por producto tiene exactamente eso. El restaurante del mismo
     * corpus trae `Fecha · Producto · Cantidad · Total · Costo · Area`, y capturarla como
     * inventario le borraría las ventas — el error simétrico y peor.
     *
     * Lo que sí los separa no es una palabra más: es que **una lista de existencias es un
     * conteo en un MOMENTO y no tiene fecha por fila**. Un movimiento siempre la tiene, porque
     * un hecho ocurre en el tiempo. Por eso `prohibidas` y no otra pista: la ausencia de la
     * dimensión temporal es la señal, y funciona en cualquier rubro y en cualquier idioma.
     *
     * `Fecha Ingreso` del inventario de una concesionaria SÍ es una fecha, y por eso esa hoja
     * no cae acá — se resuelve por el esquema del libro, que es su camino.
     */
    name: 'existencias',
    needed: ['cantidad', 'existencias', 'unidades', 'piezas'],
    min: 1,
    /*
     * Un COSTO POR UNIDAD, no un costo cualquiera. `costo` y `precio` a secas son demasiado
     * genéricos: capturaban una hoja de análisis de márgenes con columnas como
     * "PRECIO INDIVIDUAL MENSUAL - ENERO", que el corpus de hojas reales espera como `unknown`
     * — y ese test es justamente lo que lo atrapó antes de llegar a producción.
     */
    /*
     * ⚠️ `costounitario` SALIÓ TAMBIÉN (2026-08-31), por el MISMO motivo y con el mismo caso.
     *
     * Quitar `preciounitario` cerró la puerta por la que entraba una línea de FACTURA; la de
     * una línea de ORDEN DE COMPRA quedó abierta, y es la más común de las dos: una OC no
     * lleva precio de venta, lleva COSTO. `LineasOC` (`IDLineaOC · IDOC · SKU · Cantidad ·
     * Costo Unitario · Total Línea`) cumplía la firma entera y se iba a INVENTARIO — 48
     * artículos inventados en el inventario del cliente, y la hoja fuera de `vivas`, así que
     * el dedup cabecera/detalle que existe exactamente para ese par nunca llegaba a verla.
     *
     * La premisa que falla es la misma: "un movimiento siempre tiene fecha por fila". Una
     * LÍNEA de documento no la tiene — la hereda de su cabecera.
     *
     * ═══ POR QUÉ SACARLO NO ROMPE LOS DOS CASOS QUE MOTIVARON LA FIRMA ═══
     *
     * `ademas` es "al menos UNA de éstas", y los dos inventarios de mostrador que la firma
     * existe para capturar traen además la columna de PRECIO DE VENTA, que una línea de compra
     * no puede tener: la ferretería `Costo Unitario` + **`Precio Lista`**, la boutique
     * `Costo Unitario` + **`Precio Venta`**. O sea que lo que de verdad separa una lista de
     * existencias de una línea de compra no es el costo —lo tienen las dos— sino que la
     * existencia se VENDE y por eso lleva su precio.
     *
     * Medido antes de tocarlo, con el mismo criterio que exige CLAUDE.md: los 10 archivos
     * reales de clientes dan **veredicto idéntico hoja por hoja**, y las tres hojas de
     * existencias reales (ferretería, boutique, restaurante) siguen yendo a inventario.
     */
    /*
     * ⚠️ `preciounitario` SALIÓ de esta lista (2026-08-30), y el motivo es el mismo que la puso
     * acá: es demasiado genérico. Es la columna de una LÍNEA DE DOCUMENTO —una línea de orden
     * de compra, una línea de factura—, no de una lista de existencias.
     *
     * Medido: `LineasOC` (`No. Orden · Producto · Cantidad · Precio Unitario · Total`) cumplía
     * la firma entera y se iba a INVENTARIO. No duplicaba dinero (la cabecera `OrdenesCompra`
     * lo aporta bien), pero metía 36 artículos inventados en el inventario del cliente Y, peor,
     * la sacaba de `vivas` — o sea que el dedup cabecera/detalle, que existe exactamente para
     * este par, nunca llegaba a verla. Un filtro que se equivoca temprano apaga a los de abajo.
     *
     * La premisa que falla es la que justifica esta firma: "un movimiento siempre tiene fecha
     * por fila". Una LÍNEA de documento no la tiene — la hereda de su cabecera.
     *
     * Los dos casos reales que la motivaron no la necesitan: la ferretería trae `Costo
     * Unitario` + `Precio Lista` y la boutique `Costo Unitario` + `Precio Venta`. El corpus de
     * hojas reales lo confirma.
     */
    ademas: ['costopromedio', 'preciolista', 'precioventa'],
    /* Y algo que identifique al ARTÍCULO: sin eso no hay a qué atribuir la existencia. */
    yTambien: ['sku', 'codigo', 'producto', 'articulo', 'insumo', 'idproducto', 'idinsumo'],
    prohibidas: DATE_HINTS,
  },
  {
    // Catálogo de productos: ficha del artículo. `sku` solo NO basta — las líneas de venta
    // también lo traen.
    name: 'productos',
    needed: ['sku', 'nombreproducto', 'subcategoria', 'marca', 'presentacion', 'estado', 'linea'],
    min: 4,
  },
];

const has = (headers: Set<string>, hints: string[]) => hints.some((h) => headers.has(h));

/**
 * Clasifica una hoja por su fila de encabezados.
 *
 * Recibe la primera fila cruda tal como la entrega `sheet_to_json(..., { header: 1 })`.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LAS FIRMAS DE CATÁLOGO TOLERAN UN TYPO POR COLUMNA (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Las firmas se buscan por vocabulario exacto, así que un archivo escrito a mano las apaga
 * enteras: `Contactoo`, `Telefonoo`, `Condicionees` no coinciden con nada y una cartera de
 * clientes se va al modelo. Ahí el modelo hace lo ÚNICO que puede con ella —leer `Última
 * compra` como fecha y `Saldo por cobrar` como monto— y la cobranza pendiente aparece como
 * ingresos del período. Es el bug de KapePrueba (Q 13.362,75) por otra puerta, y la puerta la
 * abre cualquiera que escriba mal un encabezado.
 *
 * ═══ POR QUÉ ACÁ SÍ Y EN LAS LISTAS DE DINERO NO ═══
 *
 * Aflojar una coincidencia siempre corre el riesgo de descartar contabilidad real, que es el
 * daño que esta casa se niega a hacer en silencio. Acá el riesgo está acotado por tres cosas
 * que ya existían y no se tocan: hacen falta `min` columnas (3 en la firma de contactos), el
 * vocabulario es de FICHA y no de hecho (`telefono`, `contacto`, `condiciones` no aparecen en
 * una línea de venta), y el empate con `looksFinancial` sigue mandando al modelo. Para que un
 * libro de movimientos se descarte por esto tendrían que fallar las tres a la vez.
 *
 * Distancia 1 y no 2, y solo desde 6 caracteres: con 2 sobre palabras cortas, `nit` alcanzaría
 * a `mes` y `pais` a `plan`. Un typo de verdad es una letra —cambiada, de más, de menos— o dos
 * transpuestas, que es lo mismo a distancia 1 en la forma en que se compara acá.
 */
const LARGO_MINIMO_PARA_TOLERAR_TYPO = 6;

function aUnaEdicion(a: string, b: string): boolean {
  const d = a.length - b.length;
  if (d > 1 || d < -1) return false;
  if (a.length === b.length) {
    // Sustitución (una sola letra distinta) o transposición de dos contiguas.
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (i === a.length) return true;
    let j = a.length - 1;
    while (j > i && a[j] === b[j]) j--;
    if (i === j) return true;
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  // Inserción o borrado: el más largo con una letra menos tiene que dar el más corto.
  const [largo, corto] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < corto.length && largo[i] === corto[i]) i++;
  return largo.slice(i + 1) === corto.slice(i);
}

/** Pertenencia tolerante a un typo, para el vocabulario de las firmas de catálogo. */
function tiene(headers: Set<string>, palabra: string): boolean {
  if (headers.has(palabra)) return true;
  if (palabra.length < LARGO_MINIMO_PARA_TOLERAR_TYPO) return false;
  for (const h of headers) if (aUnaEdicion(h, palabra)) return true;
  return false;
}

/**
 * Si el encabezado cumple una firma de catálogo.
 *
 * Vive UNA sola vez: `classifySheet` y `firmaDeCatalogo` tienen que dar el mismo veredicto o
 * una hoja de existencias se declara catálogo y después no se sabe CUÁL, con lo que se
 * descarta en vez de irse a inventario.
 */
function cumpleFirma(sig: (typeof CATALOG_SIGNATURES)[number], headers: Set<string>): boolean {
  if (sig.needed.filter((h) => tiene(headers, h)).length < sig.min) return false;
  if (sig.ademas && !sig.ademas.some((h) => tiene(headers, h))) return false;
  if (sig.yTambien && !sig.yTambien.some((h) => tiene(headers, h))) return false;
  // Las PROHIBIDAS se comparan exacto: un typo no puede VETAR una firma que sí se cumple.
  if (sig.prohibidas && sig.prohibidas.some((h) => headers.has(h))) return false;
  return true;
}

export function classifySheet(headerRow: unknown[]): SheetKind {
  const headers = new Set(headerRow.map(normalizeHeader).filter(Boolean));

  // Una hoja sin encabezados legibles no se puede juzgar: al modelo.
  if (headers.size < 2) return 'unknown';

  const looksFinancial = has(headers, MONEY_HINTS) && has(headers, DATE_HINTS);

  const catalogMatch = CATALOG_SIGNATURES.find((sig) => cumpleFirma(sig, headers));

  /*
   * EL EMPATE SE RESUELVE A FAVOR DEL MODELO, y es el caso que más importa.
   *
   * `LineasOC` (línea de orden de compra) trae `sku` y `costounitario` y se parece a un
   * catálogo de productos, pero es un movimiento real. Si una hoja da las dos señales, no
   * hay certeza — y sin certeza no se descarta.
   */
  if (catalogMatch && looksFinancial) return 'unknown';
  if (catalogMatch) return 'catalog';
  if (looksFinancial) return 'financial';
  return 'unknown';
}

/**
 * Nombres de columna que nombran a la CONTRAPARTE de un movimiento: a quién se le vendió, a
 * quién se le compró, a quién se le prestó el servicio. Ver `pareceLibroDeMovimientos`.
 *
 * ═══ POR QUÉ ACÁ EL VOCABULARIO SÍ ES ACEPTABLE, Y NO EN OTRAS LISTAS ═══
 *
 * Este módulo tiene varias listas de palabras y casi todas son deuda: las de columnas de dinero
 * o de existencias intentan adivinar cómo un negocio bautiza un CONCEPTO, y ese conjunto no
 * termina nunca — `Costo Adquisicion`, `Costo Importacion`, `Costo Flete`, uno nuevo por
 * cliente. Ahí la lista siempre va perdiendo y hay que buscar la señal estructural.
 *
 * Esta lista es de otra naturaleza: enumera cómo se le dice a UNA PERSONA que está del otro
 * lado de una transacción. Ese conjunto sí es acotado y cerrado — el español de negocios tiene
 * un puñado de palabras para eso y no inventa una nueva por cada PYME. Un rubro nuevo trae un
 * término nuevo (una clínica dice paciente, un hotel huésped, un colegio alumno), pero el
 * término es del RUBRO y no del cliente, así que la lista converge en vez de crecer.
 *
 * ═══ LO QUE COSTÓ NO TENERLA COMPLETA (2026-08-25) ═══
 *
 * La hoja `Consultas` de una clínica dental —sus 214 INGRESOS, con `Precio (Q)` y
 * `Forma de Pago`— se registró como INVENTARIO: 210 unidades en existencia y cero ingresos en
 * el dashboard. `CuentasPorCobrar` la referencia, así que el esquema la declaró tabla de
 * entidades, y lo único que podía desmentirlo era esta lista. Decía `cliente` y la hoja decía
 * `Paciente`.
 *
 * Es el mismo fallo que se llevó las ventas de HeladosGT, con otra palabra. Encontrado
 * corriendo el pipeline contra un corpus de diez libros de rubros distintos.
 */
const CONTRAPARTE_HINTS = [
  'cliente',
  'idcliente',
  'nombrecliente',
  'proveedor',
  'idproveedor',
  'nombreproveedor',
  'vendedor',
  'customer',
  'client',
  'supplier',
  'vendor',
  'contraparte',
  'counterparty',
  // Servicios: la contraparte es una persona atendida, no un comprador de mercadería.
  'paciente',
  'idpaciente',
  'huesped',
  'alumno',
  'estudiante',
  'socio',
  'afiliado',
  'asegurado',
  'beneficiario',
  'inquilino',
  'arrendatario',
  'pasajero',
  'comprador',
  'destinatario',
  'remitente',
  'patient',
  'guest',
  'student',
  'member',
  'tenant',
  'buyer',
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ¿ESTA HOJA ES UN LIBRO DE MOVIMIENTOS? — LA PREGUNTA CUYO ERROR CUESTA LA CONTABILIDAD
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Existe para UNA decisión: el worker manda una hoja a inventario cuando el esquema del libro
 * la marca como tabla de entidades, y necesita una segunda señal que impida que eso le pase a
 * un libro de ventas. Ya pasó — HeladosGT perdió sus 435 ventas al stock (2026-08-24).
 *
 * ═══ POR QUÉ NO ALCANZA `classifySheet(...) === 'financial'` ═══
 *
 * Fue el primer arreglo y funcionaba por CASUALIDAD. `MONEY_HINTS` compara el encabezado
 * normalizado por IGUALDAD, así que de las quince columnas de la hoja `Ventas` de una
 * concesionaria:
 *
 *     'Precio Venta (Q)'    → precioventa      NO está en la lista (está `precio`)
 *     'Costo Vehiculo (Q)'  → costovehiculo    NO está en la lista (está `costo`)
 *     'Utilidad Bruta (Q)'  → utilidadbruta    SÍ está
 *
 * O sea que esa hoja se salvaba por una sola columna que da la casualidad de llamarse
 * exactamente "Utilidad Bruta". Con "Utilidad" o "Margen" —dos nombres igual de normales— la
 * hoja daba `unknown` y sus ventas se iban al inventario en silencio.
 *
 * ═══ QUÉ HACE DISTINTO ═══
 *
 * Compara por PREFIJO contra raíces de dinero, y exige además una columna de fecha: un libro de
 * movimientos registra hechos, y un hecho tiene cuándo. Es deliberadamente más generoso que el
 * pre-filtro, porque los dos errores no cuestan lo mismo:
 *
 *   · de más → una hoja de inventario no se detecta como tal y va al modelo: se paga de más;
 *   · de menos → las ventas del cliente se registran como stock y su dashboard queda en cero.
 *
 * `classifySheet` NO se toca: su comparación exacta gobierna el pre-filtro de catálogos, que
 * ahorra ~31 % de las filas de cada archivo, y aflojarla ahí sería pagar de más en todas las
 * cargas para arreglar un caso.
 */
export function pareceLibroDeMovimientos(headerRow: unknown[]): boolean {
  const headers = new Set(headerRow.map(normalizeHeader).filter(Boolean));

  /*
   * ═══ LA CONTRAPARTE ES LA SEÑAL, Y COSTÓ DOS INTENTOS LLEGAR A ELLA ═══
   *
   * Los dos primeros candidatos fallaron por el mismo motivo, y vale dejarlo escrito:
   *
   *   1. `classifySheet(...) === 'financial'` — funcionaba por CASUALIDAD. Ese veredicto exige
   *      una columna de dinero que coincida EXACTO con la lista de pistas, y de las quince
   *      columnas de la hoja `Ventas` de una concesionaria la única que coincide es
   *      `Utilidad Bruta`. Con "Utilidad" o "Margen" —dos nombres igual de normales— la hoja
   *      daba `unknown` y sus ventas se iban al inventario en silencio.
   *
   *   2. "tiene fecha Y dinero", comparando por prefijo. Más robusto para las ventas, pero se
   *      come el caso que el mecanismo vino a resolver: el inventario de una concesionaria
   *      trae `Costo Adquisicion` y `Fecha Ingreso`, así que también tiene fecha y dinero. Un
   *      inventario legítimamente los tiene, y por eso NINGUNA señal de dinero puede separarlos.
   *
   * Lo que sí los separa es semántico y no de formato: un MOVIMIENTO involucra a alguien —se le
   * vende a un cliente, se le compra a un proveedor— y una lista de existencias no. Un vehículo
   * en el patio no tiene contraparte hasta que se vende, y ese día la fila que la registra vive
   * en la hoja de ventas, no en la de stock.
   *
   * Medido sobre los dos archivos que motivaron esto:
   *
   *     CarsGT · Ventas        Cliente, Vendedor   → movimientos
   *     CarsGT · Inventario    —                   → puede ser catálogo
   *     Helados · Ventas       Cliente, Vendedor   → movimientos
   *     Helados · Inventario   —                   → puede ser catálogo
   *
   * ═══ ALCANCE: ESTO NO ES UN CLASIFICADOR GENERAL ═══
   *
   * Solo se le pregunta por hojas que el esquema del libro YA marcó como tabla de entidades, o
   * sea referenciadas por otra y terminales en el grafo. No sirve para decidir si una hoja
   * cualquiera es de movimientos —la de gastos de una PYME no nombra proveedor y lo es— y por
   * eso no reemplaza a `classifySheet`, que sigue gobernando el pre-filtro.
   */
  return CONTRAPARTE_HINTS.some((h) => headers.has(h));
}

/** `true` si la hoja se puede saltar sin llamar al modelo. */
export function canSkipSheet(headerRow: unknown[]): boolean {
  return classifySheet(headerRow) === 'catalog';
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA HOJA SIN COLUMNA DE FECHA, O SIN DINERO FUERA DE ELLA, NO PUEDE PRODUCIR MOVIMIENTOS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El pre-filtro de catálogos reconoce vocabulario de CONTACTO (`email`, `teléfono`, `apellido`)
 * porque nació de los catálogos de clientes que traían los primeros archivos. Un catálogo
 * moderno no trae nada de eso:
 *
 *     Clientes   ID Cliente · Nombre · Industria · Plan
 *     Clientes   ID Cliente · Nombre · Tipo · Área Principal · Fecha Alta
 *     Rutas      ID Ruta · Ruta · Distancia (km) · Tiempo Estimado
 *     Flota      ID Unidad · Placa · Marca · Modelo · Anio · Estado
 *
 * Los cuatro se iban al modelo: se paga por clasificarlos y sus filas quedan a un veredicto de
 * convertirse en movimientos que el cliente nunca tuvo. En la auditoría contra el validador de
 * extracción (2026-08-25), la mitad de los diez archivos traía al menos uno.
 *
 * ═══ POR QUÉ ESTA SEÑAL NO ROMPE EL SESGO DE LA CASA ═══
 *
 * El pre-filtro descarta con el sesgo explícito de PAGAR DE MÁS: ante la duda, al modelo,
 * porque descartar de más pierde contabilidad del cliente en silencio. Esto no rompe ese sesgo,
 * y el motivo es que **no descarta nada que hoy sobreviva**: `staging-rules` exige fecha legible
 * Y monto positivo, así que una hoja que no puede dar ninguna de las dos produce, en el mejor
 * de los casos, filas marcadas — pagando el modelo para llegar ahí. Lo único que cambia es
 * dónde se detiene.
 *
 * ═══ SE JUZGA POR COLUMNA, Y ESO ES LO QUE LO HACE SEGURO ═══
 *
 * Dos versiones anteriores miraban las celdas suelta por suelta y las dos se equivocaban, en
 * direcciones opuestas:
 *
 *   · "¿hay alguna celda con fecha?" — el catálogo de un bufete trae `Fecha Alta`, una fecha
 *     REAL, así que pasaba el filtro aunque no tuviera un centavo en ninguna columna.
 *   · "¿hay alguna celda con número?" — las fechas de Excel SON números, así que la columna de
 *     fecha fingía ser dinero y volvía a pasar.
 *
 * Lo que resuelve las dos es exigir que la fecha y el dinero estén en columnas DISTINTAS: se
 * busca la columna que es predominantemente fecha, y después dinero en cualquier OTRA. Un
 * catálogo con `Fecha Alta` y ninguna cifra más se descarta; y una hoja de movimientos cuyos
 * montos caen todos en el rango de seriales de Excel (32.874–73.415, o sea decenas de miles)
 * NO se descarta, porque su fecha y su monto siguen siendo dos columnas.
 *
 * Y se juzga por el CONTENIDO, no por los nombres: una hoja de movimientos cuya columna se
 * llame `Emisión` o `Corte` no tiene ninguna palabra que el vocabulario reconozca, pero sus
 * celdas siguen trayendo fechas. Juzgar por el nombre habría vuelto a apostar a una lista.
 *
 * Depende de que los lectores no INVENTEN valores, y eso hubo que arreglarlo antes:
 * `asDate("CLI-0001")` devolvía 2001-01-01 y `asNumber("SKU-4567")` devolvía -4567, así que
 * cualquier columna de código fingía ser las dos cosas. Ver `row-assembly`.
 */
export function noPuedeProducirMovimientos(
  rows: unknown[][],
  /*
   * Acepta el ORDEN de día/mes como segundo argumento —la firma de `asDate`— y este filtro lo
   * usa. Ver el bloque de abajo: sin eso, una hoja exportada en `MM/DD/YYYY` se descartaba
   * entera.
   */
  leerFecha: (v: unknown, orden?: 'dmy' | 'mdy') => unknown,
  leerNumero: (v: unknown) => unknown,
): boolean {
  const encabezado = rows[0] ?? [];
  /*
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * EL RENGLÓN DE TOTAL Y EL PIE DE PÁGINA NO CUENTAN EN CONTRA (2026-09-01)
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Este filtro exige que el 80 % de una columna se lea como fechas. Las dos suciedades más
   * comunes de un Excel hecho a mano —un renglón de `TOTAL` al final y un pie de página de
   * tres celdas— no traen fecha, así que **restan cobertura** y pueden empujar a una hoja
   * legítima por debajo del umbral. Y este filtro corre ANTES del modelo: cuando descarta, la
   * hoja entera desaparece sin dejar una sola fila que alguien pueda revisar, que es el fallo
   * más caro de esta casa.
   *
   * Medido con `libro-el-infierno`: `Ventas` con ocho movimientos buenos escritos en cuatro
   * formatos de fecha distintos, más una fecha imposible, un `TOTAL` y un pie de página,
   * quedaba en 9/12 = 75 % y se descartaba ENTERA — ocho ventas reales y su costo.
   *
   * El resto del pipeline ya tolera las dos: el modelo declara `skip` sobre un TOTAL y
   * `sheet-header` sabe que un pie de página no es un encabezado. Lo que faltaba era que este
   * filtro no las contara como evidencia EN CONTRA. `filaEsRenglonDeTotal` se consume de
   * `sheet-unpivot` en vez de reescribirse: si los tres juzgaran distinto qué es un total, la
   * misma fila se excluiría de un lado y no del otro.
   *
   * ⚠️ Solo se excluyen del DENOMINADOR. No se descartan ni se marcan acá — eso lo decide
   * `staging-rules` con toda la fila delante.
   */
  const esSuciedad = (f: unknown[]): boolean => {
    if (filaEsRenglonDeTotal(f)) return true;
    // Un pie de página rotula la hoja, no la tabla: ocupa mucho menos que el encabezado.
    const llenas = f.filter((c) => c !== null && c !== undefined && c !== '').length;
    const anchoEncabezado = encabezado.filter(
      (c) => c !== null && c !== undefined && c !== '',
    ).length;
    return anchoEncabezado >= 4 && llenas > 0 && llenas <= anchoEncabezado / 2;
  };

  const muestra = rows.slice(1, 60).filter((f) => !esSuciedad(f));
  // Con muy pocas filas no se puede afirmar nada: una hoja chica se manda igual.
  if (muestra.length < 5) return false;

  const ancho = Math.max(...muestra.map((f) => f.length), 0);
  let columnaDeFecha = -1;
  let mejorProporcion = 0;
  const conNumeros = new Set<number>();

  for (let c = 0; c < ancho; c++) {
    const valores = muestra
      .map((f) => f[c])
      .filter((v) => v !== null && v !== undefined && v !== '');
    if (valores.length === 0) continue;

    /*
     * ═════════════════════════════════════════════════════════════════════════════════════
     * SE PRUEBAN LOS DOS ÓRDENES Y GANA EL MEJOR (2026-08-30)
     * ═════════════════════════════════════════════════════════════════════════════════════
     *
     * `asDate` lee `DD/MM/YYYY` por defecto, que es lo correcto para Guatemala. Pero un libro
     * exportado de un sistema en inglés trae `MM/DD/YYYY`, y ahí `01/14/2026` da mes 14 →
     * `null`. Con suficientes días mayores a 12 —o sea, en cualquier hoja de un año entero—
     * la columna baja del 80 % exigido, la hoja se queda **sin columna de fecha** y este
     * filtro la descarta ANTES del modelo.
     *
     * Medido sobre un `LibroDiario` de 176 movimientos con fechas `MM/DD/YYYY`: la hoja
     * entera desaparecía, sin una fila marcada que alguien pudiera revisar. Y es la forma más
     * común en una PYME chica — ingresos, costos y gastos en una sola hoja.
     *
     * Acá NO se decide cuál orden es el correcto: eso lo hace `detectarOrdenDeFecha` sobre la
     * columna entera, más tarde y con toda la evidencia. La única pregunta de este filtro es
     * "¿esta columna PUEDE leerse como fechas?", y para eso basta el mejor de los dos.
     */
    const cuentaConOrden = (orden: 'dmy' | 'mdy') =>
      valores.filter((v) => {
        const f = leerFecha(v, orden);
        return f !== null && f !== undefined;
      }).length;
    const fechas = Math.max(cuentaConOrden('dmy'), cuentaConOrden('mdy'));
    // El cero no cuenta: `staging-rules` exige monto POSITIVO.
    const numeros = valores.filter((v) => {
      const n = leerNumero(v);
      return typeof n === 'number' && n !== 0;
    }).length;

    const proporcion = fechas / valores.length;
    // 0,8 y no 1,0: un archivo real trae una fila a medio llenar en la columna de fecha.
    if (proporcion >= 0.8 && proporcion > mejorProporcion) {
      mejorProporcion = proporcion;
      columnaDeFecha = c;
    }
    if (numeros > 0) conNumeros.add(c);
  }

  if (columnaDeFecha === -1) return true;
  // El dinero tiene que estar en OTRA columna. Ver el bloque de arriba.
  conNumeros.delete(columnaDeFecha);
  return conNumeros.size === 0;
}

/**
 * QUÉ catálogo es, cuando es catálogo. `null` si no lo es.
 *
 * Hasta acá la clasificación solo decía sí/no y toda hoja de catálogo terminaba igual: en la
 * basura. Pero no todos los catálogos son igual de inútiles — el de EXISTENCIAS es el
 * inventario del cliente, y descartarlo es exactamente el bug que reportó Macha
 * (CU-868krkfrh: "Inventario no carga datos con ningún archivo"). En producción se veía así,
 * en cada carga de cada empresa:
 *
 *   hoja "Inventario" descartada por encabezados (catálogo, no movimientos): 211 filas
 *
 * Esta función es lo que permite tratar `existencias` distinto SIN tocar el pre-filtro, que
 * sigue ahorrando el 50 % de las filas de cada archivo. Los otros catálogos —contactos,
 * ubicaciones, productos— se siguen descartando, y eso está bien: no hay nada en el producto
 * que los consuma.
 */
export function firmaDeCatalogo(headerRow: unknown[]): string | null {
  if (classifySheet(headerRow) !== 'catalog') return null;
  const headers = new Set(headerRow.map(normalizeHeader).filter(Boolean));
  return CATALOG_SIGNATURES.find((sig) => cumpleFirma(sig, headers))?.name ?? null;
}
