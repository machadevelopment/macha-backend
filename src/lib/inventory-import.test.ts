import { describe, expect, test } from 'bun:test';
import {
  cuentaComoExistencia,
  mapearColumnasDeInventario,
  mapearInventarioSerializado,
  mapearInventarioForzado,
} from './inventory-import';
import { firmaDeCatalogo, canSkipSheet } from './sheet-classifier';

/**
 * CU-868krkfrh — mapear la hoja de existencias SIN pasar por el modelo.
 *
 * Es la mitad barata del arreglo: una hoja de inventario tiene encabezados predecibles, y el
 * pre-filtro existe justamente para que los catálogos no cuesten tokens. Lo que estos tests
 * defienden es que el mapeo acierte sobre las formas reales… y que se rinda cuando no puede,
 * en vez de inventar.
 */

// Encabezados tomados de la hoja "Inventario" que aparece en los archivos reales de los
// tres clientes (la que producción descarta hoy: 211 filas por carga).
const REAL = ['ID_Insumo', 'Insumo', 'Unidad de Medida', 'Stock Actual', 'Stock Mínimo'];

describe('la hoja de existencias se reconoce como tal', () => {
  test('el clasificador la nombra `existencias`, no solo "catálogo"', () => {
    // Sin este nombre, el worker no puede tratarla distinto de `Clientes` o `Tiendas` — que
    // es exactamente por qué se tiraba.
    expect(firmaDeCatalogo(REAL)).toBe('existencias');
  });

  test('los otros catálogos siguen siendo catálogo y se siguen descartando', () => {
    const clientes = ['ID', 'Nombre', 'Apellido', 'Email', 'Telefono'];
    const tiendas = ['ID', 'Ciudad', 'Pais', 'Gerente', 'Fecha Apertura'];
    expect(firmaDeCatalogo(clientes)).toBe('contactos');
    expect(firmaDeCatalogo(tiendas)).toBe('ubicaciones');
    // El pre-filtro no cambió: siguen sin llegar al modelo.
    expect(canSkipSheet(clientes)).toBe(true);
    expect(canSkipSheet(tiendas)).toBe(true);
  });

  test('una hoja de movimientos NO es catálogo', () => {
    const ventas = ['Fecha', 'Producto', 'Cantidad', 'Ingreso Total (Q)'];
    expect(firmaDeCatalogo(ventas)).toBeNull();
  });
});

describe('mapearColumnasDeInventario', () => {
  test('mapea la hoja real de los clientes', () => {
    const mapa = mapearColumnasDeInventario(REAL)!;
    expect(mapa.sku).toBe(0); // ID_Insumo
    expect(mapa.name).toBe(1); // Insumo
    expect(mapa.quantity).toBe(3); // Stock Actual
    expect(mapa.reorderPoint).toBe(4); // Stock Mínimo
  });

  test('acepta la nomenclatura del otro sistema', () => {
    const otro = [
      'SKU',
      'Nombre Producto',
      'Cantidad Disponible',
      'Punto Reorden',
      'Costo Unitario',
      'Ubicacion',
      'Proveedor',
    ];
    const mapa = mapearColumnasDeInventario(otro)!;
    expect(mapa).toEqual({
      sku: 0,
      name: 1,
      quantity: 2,
      reorderPoint: 3,
      unitCost: 4,
      location: 5,
      supplier: 6,
      // Esa hoja no trae columna de estado; el camino fungible tampoco la consulta.
      status: null,
    });
  });

  test('gana la pista MÁS ESPECÍFICA cuando la hoja trae las dos', () => {
    // "Stock Actual" es la existencia; "Stock" a secas podría ser cualquier cosa. Con el
    // orden invertido en la lista de pistas, esta hoja se quedaría con la columna genérica.
    const ambas = ['SKU', 'Stock', 'Stock Actual'];
    expect(mapearColumnasDeInventario(ambas)!.quantity).toBe(2);
  });

  test('NO confunde precio de venta con costo', () => {
    // Es el mismo cuidado que el prompt del modelo exige: el precio unitario es lo que el
    // negocio COBRA, el costo es lo que le COSTÓ. Confundirlos infla el valor del
    // inventario por el margen completo.
    const conPrecio = ['SKU', 'Stock Actual', 'Precio Unitario'];
    expect(mapearColumnasDeInventario(conPrecio)!.unitCost).toBeNull();
  });

  test('sin CANTIDAD no se puede importar', () => {
    // Un catálogo de productos sin existencias no es un inventario. Importarlo crearía
    // artículos con stock cero que nadie pidió.
    expect(mapearColumnasDeInventario(['SKU', 'Nombre', 'Categoria'])).toBeNull();
  });

  test('sin IDENTIFICADOR tampoco', () => {
    // Cantidades sin saber de qué artículo son.
    expect(mapearColumnasDeInventario(['Stock Actual', 'Punto Reorden'])).toBeNull();
  });

  test('basta el NOMBRE si no hay SKU', () => {
    // El cliente que lleva su bodega por nombre de producto — común en una PYME. Sin este
    // camino su inventario no se podría importar nunca.
    const porNombre = ['Producto', 'Existencia'];
    const mapa = mapearColumnasDeInventario(porNombre)!;
    expect(mapa.sku).toBeNull();
    expect(mapa.name).toBe(0);
    expect(mapa.quantity).toBe(1);
  });
});

/**
 * ═══ INVENTARIO SERIALIZADO (CarsGT, 2026-08-24) ═══
 *
 * La hoja de una concesionaria no tiene columna de cantidad porque cada fila ES una unidad.
 * Sin este camino no mapeaba, no importaba nada, y seguía de largo hacia el modelo — que
 * razonablemente concluía que 260 vehículos en stock eran Q 36,4 M de costo de ventas.
 */
describe('inventario serializado: una fila, una unidad', () => {
  const encabezado = ['ID Vehiculo', 'VIN', 'Marca', 'Modelo', 'Costo Adquisicion (Q)', 'Sucursal'];

  test('mapea usando la columna de serie que da el esquema del libro', () => {
    const mapa = mapearInventarioSerializado(encabezado, 0);

    expect(mapa).not.toBeNull();
    expect(mapa!.sku).toBe(0);
    // `quantity: null` es la marca de "serializado": el llamador cuenta 1 por fila.
    expect(mapa!.quantity).toBeNull();
  });

  test('la MISMA hoja no mapea por vocabulario — que es justo el agujero que tapa', () => {
    // Si algún día `mapearColumnasDeInventario` la reconociera, este camino sobraría. Mientras
    // devuelva null, la vía serializada es la única que salva estas filas.
    expect(mapearColumnasDeInventario(encabezado)).toBeNull();
  });

  test('una columna de serie fuera de rango no inventa un mapa', () => {
    expect(mapearInventarioSerializado(encabezado, 99)).toBeNull();
    expect(mapearInventarioSerializado(encabezado, -1)).toBeNull();
  });
});

/**
 * ═══ UN SKU EN VARIAS TIENDAS SE SUMA, NO SE PISA (auditoría 2026-08-24) ═══
 *
 * El archivo de una joyería trae 210 filas de inventario para 42 productos: una por cada
 * combinación de producto y tienda. Cada fila se trataba como un conteo nuevo del mismo
 * artículo y cada una pisaba a la anterior:
 *
 *     JYL-ANI-0001   130 · 42 · 35 · 1 · 0   →  quedaba en 0, donde hay 208
 *
 * El rastro de movimientos lo dejaba escrito y nadie lo leía: "Conteo importado del archivo
 * (24 → 9)", cuatro veces seguidas para el mismo artículo. Afectaba a empresas reales — 55
 * artículos de Electro Hogar.
 *
 * Estos tests fijan el mapeo de columnas; el agrupado en sí se comprueba end-to-end en
 * `tests/integration`, que es donde hay base de datos.
 */
describe('el mapa reconoce una hoja de (SKU, tienda)', () => {
  test('la hoja de la joyería mapea, con SKU repetido por tienda', () => {
    const mapa = mapearColumnasDeInventario([
      'SKU',
      'IDTienda',
      'CantidadDisponible',
      'PuntoReorden',
      'CantidadReorden',
      'FechaÚltimoReabasto',
    ]);

    expect(mapa).not.toBeNull();
    expect(mapa!.sku).toBe(0);
    expect(mapa!.quantity).toBe(2);
    /*
     * La tienda NO entra en la identidad del artículo, y ahí está el nudo: `inventory_items`
     * tiene un artículo por SKU y no por (SKU, tienda), así que no hay dónde guardar el
     * desglose. Por eso la cantidad se suma en vez de conservarse por tienda — se pierde saber
     * cuánto hay en cada una, y a cambio el total que ve el cliente es el correcto.
     */
    expect(mapa!.location).not.toBe(1);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNA UNIDAD VENDIDA NO ES EXISTENCIA (CarsGT, 2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Reporte de Keneth: "el inventario no estaba jalando bien". El detector de esquema SÍ
 * reconocía la hoja —`Ventas[ID Vehiculo] → Inventario[ID Vehiculo]`, cobertura 100 %— y el
 * camino serializado la importaba. El defecto estaba en el conteo: cada fila valía 1 sin
 * mirar el estado, así que los vehículos VENDIDOS entraban como existencia.
 *
 * Medido sobre el archivo real (260 filas): 240 `Vendido`, 18 `Disponible`, 2 `Reservado`.
 * El inventario del cliente decía 260 unidades donde hay 20, y Q 33,4 M de vehículos que ya
 * no están en el lote.
 */
describe('el estado decide si la unidad sigue en existencia', () => {
  const encabezadoCarsGT = [
    'ID Vehiculo',
    'VIN',
    'Marca',
    'Modelo',
    'Anio Modelo',
    'Tipo',
    'Color',
    'Costo Adquisicion (Q)',
    'Precio Lista (Q)',
    'Fecha Ingreso',
    'Sucursal',
    'Estado',
    'Dias en Inventario',
  ];

  /**
   * El mapa COMPLETO, no solo la columna que se acaba de tocar.
   *
   * La primera versión de este arreglo comprobó `status` y `quantity` y dio el trabajo por
   * bueno. En producción el inventario quedó con el nombre en "INV-0001", el costo unitario en
   * 0 y el valor del stock en Q 0,00 teniendo Q 3.016.924 — porque `Modelo`, `Costo Adquisicion
   * (Q)` y `Sucursal` no estaban en ninguna lista de pistas. Afirmar el mapa entero es lo que
   * habría hecho visible eso antes de desplegarlo.
   */
  test('la hoja de la concesionaria mapea TODAS sus columnas', () => {
    const mapa = mapearInventarioSerializado(encabezadoCarsGT, 0)!;
    expect(mapa.sku).toBe(0); // ID Vehiculo — la serie, que es la identidad
    expect(mapa.name).toBe(3); // Modelo, no el SKU repetido
    expect(mapa.unitCost).toBe(7); // "Costo Adquisicion (Q)", por PREFIJO
    expect(mapa.location).toBe(10); // Sucursal
    expect(mapa.status).toBe(11); // Estado
    // Sigue siendo serializada: la cantidad la pone el importador, no la hoja.
    expect(mapa.quantity).toBeNull();
  });

  test('lo vendido, entregado o dado de baja NO cuenta', () => {
    for (const v of ['Vendido', 'vendida', 'ENTREGADO', 'Facturado', 'Baja', 'Sold']) {
      expect(cuentaComoExistencia(v)).toBe(false);
    }
  });

  test('lo disponible y lo reservado SÍ cuentan', () => {
    // Reservado está físicamente en el lote: apartado, no vendido.
    for (const v of ['Disponible', 'En existencia', 'Reservado', 'Apartado']) {
      expect(cuentaComoExistencia(v)).toBe(true);
    }
  });

  /**
   * El sesgo, que es la mitad del diseño: solo se RESTA lo que se reconoce.
   *
   * `Estado` es un nombre de columna demasiado común para asumir que siempre habla de
   * disponibilidad. Contar de más deja un inventario inflado, que se ve y se reporta; contar
   * de menos le borra inventario real al cliente sin que nada falle, y eso no lo reporta
   * nadie porque se ve igual que "todavía no cargó".
   */
  /**
   * La CANTIDAD se busca solo por nombre exacto, y es la excepción a la búsqueda por prefijo.
   *
   * Por prefijo, `cantidad` también captura `Cantidad Vendida`. Un costo mal leído se ve en la
   * pantalla; una cantidad mal leída se ve como un inventario plausible y falso.
   */
  test('una columna de "Cantidad Vendida" NO se toma como existencia', () => {
    expect(mapearColumnasDeInventario(['SKU', 'Producto', 'Cantidad Vendida', 'Costo'])).toBeNull();
  });

  test('un estado desconocido o vacío cuenta como existencia', () => {
    for (const v of [
      'Activo',
      'Inactivo',
      'Nuevo',
      'Usado',
      'cualquier cosa',
      '',
      null,
      undefined,
    ]) {
      expect(cuentaComoExistencia(v)).toBe(true);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * "ESTA HOJA ES MI INVENTARIO" — EL MAPEO CUANDO LO AFIRMA EL DUEÑO (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Los dos caminos automáticos deciden solos y los dos tienen su hueco. Este no decide nada: el
 * dueño ya dijo que la hoja es su inventario y lo único que falta es leerla. Cierra el hueco
 * medido de *"un inventario serializado que ninguna otra hoja referencia entra como GASTO —
 * Q 1.864.500 de egreso que nadie desembolsó"*.
 */
describe('mapearInventarioForzado', () => {
  test('con columna de CANTIDAD usa el camino fungible', () => {
    const m = mapearInventarioForzado(
      ['sku', 'descripcion', 'existencia', 'costo unitario'],
      [
        ['CAF-001', 'Café en grano', 40, 55],
        ['CAF-002', 'Café molido', 12, 60],
      ],
    );
    expect(m).not.toBeNull();
    expect(m!.quantity).toBe(2);
    expect(m!.sku).toBe(0);
  });

  test('⚠️ el fungible GANA aunque el SKU sea único por fila', () => {
    /*
     * Es la decisión que más cuesta si se toma al revés. Una hoja de bodega tiene el SKU único
     * por fila, así que entraría por el camino serializado —UNA unidad por SKU— y el
     * inventario del cliente saldría en 1 donde hay cuarenta. La cantidad, cuando existe, es
     * la respuesta: la hoja la escribió para eso.
     */
    const m = mapearInventarioForzado(
      ['sku', 'nombre', 'existencia'],
      [
        ['A-1', 'Uno', 40],
        ['A-2', 'Dos', 12],
        ['A-3', 'Tres', 7],
        ['A-4', 'Cuatro', 3],
      ],
    );
    expect(m!.quantity).not.toBeNull();
  });

  test('SIN cantidad, cae al serializado por la columna única de más a la izquierda', () => {
    /*
     * La forma de una concesionaria: una fila por unidad, identificada por su serie. La
     * cantidad de cada una es 1 y escribirla sería redundante — `quantity: null` es lo que
     * marca este mapa como serializado.
     */
    const m = mapearInventarioForzado(
      ['vin', 'modelo', 'costo'],
      [
        ['VIN-9BW11000', 'Modelo 0', 150000],
        ['VIN-9BW11001', 'Modelo 1', 160000],
        ['VIN-9BW11002', 'Modelo 2', 170000],
        ['VIN-9BW11003', 'Modelo 3', 180000],
      ],
    );
    expect(m).not.toBeNull();
    expect(m!.quantity).toBeNull();
    expect(m!.sku).toBe(0);
  });

  test('sin cantidad y sin ninguna columna única, NO se inventa un inventario', () => {
    /*
     * Se devuelve `null` y el worker lo dice y descarta la hoja. Mandarla de vuelta al modelo
     * reintroduciría el costo falso que el dueño está corrigiendo, y adivinar una columna
     * metería artículos inventados en su bodega.
     */
    const m = mapearInventarioForzado(
      ['fecha', 'concepto'],
      [
        ['2026-07-01', 'Alquiler'],
        ['2026-08-01', 'Alquiler'],
        ['2026-09-01', 'Alquiler'],
        ['2026-10-01', 'Alquiler'],
      ],
    );
    expect(m).toBeNull();
  });
});
