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
const MONEY_HINTS = [
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
    // Clientes / Proveedores: contacto de una persona o empresa.
    name: 'contactos',
    needed: ['email', 'telefono', 'contacto', 'nombre', 'apellido', 'nivellealtad', 'genero'],
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
    ademas: ['costounitario', 'costopromedio', 'preciolista', 'precioventa', 'preciounitario'],
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
export function classifySheet(headerRow: unknown[]): SheetKind {
  const headers = new Set(headerRow.map(normalizeHeader).filter(Boolean));

  // Una hoja sin encabezados legibles no se puede juzgar: al modelo.
  if (headers.size < 2) return 'unknown';

  const looksFinancial = has(headers, MONEY_HINTS) && has(headers, DATE_HINTS);

  const cumple = (sig: (typeof CATALOG_SIGNATURES)[number]): boolean => {
    if (sig.needed.filter((h) => headers.has(h)).length < sig.min) return false;
    if (sig.ademas && !sig.ademas.some((h) => headers.has(h))) return false;
    if (sig.yTambien && !sig.yTambien.some((h) => headers.has(h))) return false;
    if (sig.prohibidas && sig.prohibidas.some((h) => headers.has(h))) return false;
    return true;
  };
  const catalogMatch = CATALOG_SIGNATURES.find(cumple);

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
 * SIN UNA SOLA FECHA EN TODA LA HOJA NO HAY MOVIMIENTO POSIBLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El pre-filtro de catálogos reconoce vocabulario de CONTACTO (`email`, `teléfono`,
 * `apellido`) porque nació de los catálogos de clientes que traían los primeros archivos. Un
 * catálogo moderno no trae nada de eso:
 *
 *     Clientes   ID Cliente · Nombre · Industria · Plan
 *     Rutas      ID Ruta · Ruta · Distancia (km) · Tiempo Estimado
 *     Flota      ID Unidad · Placa · Marca · Modelo · Anio · Estado
 *
 * Las tres se iban al modelo: se paga por clasificarlas y sus filas quedan a un veredicto de
 * convertirse en movimientos que el cliente nunca tuvo. Encontrado en un corpus de diez libros
 * reales (2026-08-25), donde la mitad de los archivos traía al menos una.
 *
 * ═══ POR QUÉ ESTA SEÑAL NO CONTRADICE EL SESGO DE LA CASA ═══
 *
 * El pre-filtro descarta con el sesgo explícito de PAGAR DE MÁS: ante la duda, al modelo,
 * porque descartar de más pierde contabilidad del cliente en silencio. Esta comprobación no
 * rompe ese sesgo, y el motivo es que **no descarta nada que hoy sobreviva**.
 *
 * Un movimiento sin fecha no se promueve: `staging-rules` lo rechaza entero por `invalid_date`
 * y queda en revisión interna. O sea que una hoja donde NINGUNA celda parece una fecha produce,
 * en el mejor de los casos, filas marcadas — pagando el modelo para llegar ahí. Lo único que
 * cambia es dónde se detiene: antes de la llamada en vez de después.
 *
 * ═══ SE MIRA EL CONTENIDO, NO LOS NOMBRES ═══
 *
 * Y eso es lo que la hace segura. Una hoja de movimientos cuya columna se llame `Emisión` o
 * `Corte` no tiene ninguna palabra que el vocabulario reconozca, pero SUS CELDAS siguen
 * trayendo fechas. Juzgar por el nombre habría vuelto a apostar a una lista; juzgar por los
 * valores no puede equivocarse en esa dirección.
 *
 * Basta UNA celda con pinta de fecha en toda la muestra para que la hoja siga su camino.
 */
export function sinNingunaFecha(rows: unknown[][], leerFecha: (v: unknown) => unknown): boolean {
  // `rows` viene desde el encabezado; los datos empiezan en la 1.
  const muestra = rows.slice(1, 60);
  // Con muy pocas filas no se puede afirmar nada: una hoja chica se manda igual.
  if (muestra.length < 5) return false;
  for (const fila of muestra) {
    for (const celda of fila) {
      if (leerFecha(celda) !== null && leerFecha(celda) !== undefined) return false;
    }
  }
  return true;
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
  return (
    CATALOG_SIGNATURES.find((sig) => {
      if (sig.needed.filter((h) => headers.has(h)).length < sig.min) return false;
      if (sig.ademas && !sig.ademas.some((h) => headers.has(h))) return false;
      if (sig.yTambien && !sig.yTambien.some((h) => headers.has(h))) return false;
      if (sig.prohibidas && sig.prohibidas.some((h) => headers.has(h))) return false;
      return true;
    })?.name ?? null
  );
}
