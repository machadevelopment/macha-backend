import { describe, expect, test } from 'bun:test';
import { mapearColumnasDeInventario, mapearInventarioSerializado } from './inventory-import';
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
  const encabezado = [
    'ID Vehiculo',
    'VIN',
    'Marca',
    'Modelo',
    'Costo Adquisicion (Q)',
    'Sucursal',
  ];

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
