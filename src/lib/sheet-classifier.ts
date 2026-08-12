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

/** Normaliza un encabezado: sin acentos, sin separadores, en minúsculas. */
function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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
const CATALOG_SIGNATURES: { name: string; needed: string[]; min: number }[] = [
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
    ],
    min: 2,
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

  const catalogMatch = CATALOG_SIGNATURES.find(
    (sig) => sig.needed.filter((h) => headers.has(h)).length >= sig.min,
  );

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

/** `true` si la hoja se puede saltar sin llamar al modelo. */
export function canSkipSheet(headerRow: unknown[]): boolean {
  return classifySheet(headerRow) === 'catalog';
}
