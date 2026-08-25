import { describe, expect, test } from 'bun:test';
import { canSkipSheet, classifySheet } from './sheet-classifier';

/**
 * Los encabezados son los REALES de los tres archivos de prueba que entregó el cliente el
 * 2026-08-12 (Joyería Lunaria, Bella Piel, Luz de Cera). No están inventados: se leyeron con
 * el mismo parser que usa el worker de ingesta.
 *
 * Ese es el punto del archivo. Sin un set de casos reales, cambiar el pre-filtro sería a
 * ciegas, y el modo de fallo —descartar una hoja financiera— es silencioso: el cliente
 * simplemente no vería esos datos en su dashboard.
 */

const VENTAS = ['IDOrden','IDLinea','FechaOrden','IDTienda','Canal','IDCliente','SKU','Cantidad','PrecioUnitario','PorcentajeDescuento','MetodoPago','CostoUnitario','Categoría','TotalLinea','UtilidadBruta','MesOrden']; // prettier-ignore
const ORDENES_COMPRA = ['IDOC','IDProveedor','FechaOrden','FechaEntregaEsperada','FechaEntregaReal','Estado','MontoTotal']; // prettier-ignore
const LINEAS_OC = ['IDLineaOC', 'IDOC', 'SKU', 'CantidadPedida', 'CostoUnitario', 'TotalLinea'];

const CLIENTES = ['IDCliente','Nombre','Apellido','Email','Telefono','Ciudad','Estado','Pais','Género','AñoNacimiento','NivelLealtad','FechaRegistro','CanalPreferido']; // prettier-ignore
const PROVEEDORES = ['IDProveedor','NombreProveedor','Contacto','Email','Telefono','Pais','DiasEntrega','CondicionesPago','CategoriaSuministrada']; // prettier-ignore
const TIENDAS = ['IDTienda','NombreTienda','TipoTienda','Ciudad','Estado','Pais','FechaApertura','Gerente','SuperficieM2','RentaMensual']; // prettier-ignore
const INVENTARIO = ['SKU','IDTienda','CantidadDisponible','PuntoReorden','CantidadReorden','FechaÚltimoReabasto','Ubicación','NombreTienda','AlertaReorden']; // prettier-ignore
const PRODUCTOS = ['SKU','NombreProducto','Categoría','Subcategoría','Marca','MaterialYPiedra','Acabado','Colección','IDProveedor','CostoUnitario','PrecioVenta','Estado','FechaAlta','Margen$','Margen%','UnidadesVendidas','IngresoTotal']; // prettier-ignore

describe('hojas de CATÁLOGO — no deben llegar al modelo', () => {
  test.each([
    ['Clientes', CLIENTES],
    ['Proveedores', PROVEEDORES],
    ['Tiendas', TIENDAS],
    ['Inventario', INVENTARIO],
    // `Productos` ES un catálogo aunque traiga precio, costo e ingreso acumulado: son
    // AGREGADOS de la ficha, no un movimiento. Y sobre todo, las tres entidades destino son
    // `transaction`, `invoice` y `bill` — una ficha de producto no puede ser ninguna, así
    // que mandarla al modelo solo puede producir filas que no mapean a nada.
    ['Productos', PRODUCTOS],
  ])('%s se descarta por regla', (_nombre, headers) => {
    expect(classifySheet(headers)).toBe('catalog');
    expect(canSkipSheet(headers)).toBe(true);
  });
});

describe('hojas FINANCIERAS — nunca se descartan', () => {
  test.each([
    ['Ventas', VENTAS],
    ['OrdenesCompra', ORDENES_COMPRA],
    ['LineasOC', LINEAS_OC],
  ])('%s NO se salta', (_nombre, headers) => {
    // Lo único que este test exige es que NO se descarte. Que sea `financial` o `unknown`
    // da igual: las dos van al modelo, que es lo seguro. `LineasOC` cae en `unknown` por
    // diseño (ver el empate en sheet-classifier.ts) y está bien así.
    expect(canSkipSheet(headers)).toBe(false);
  });
});

describe('el empate se resuelve a favor del modelo', () => {
  test('LineasOC parece catálogo por el SKU pero es un movimiento', () => {
    // Trae `sku` y `costounitario` como el catálogo de productos, pero cada fila es una
    // compra real. Descartarla borraría los costos del cliente.
    expect(canSkipSheet(LINEAS_OC)).toBe(false);
  });

  test('Productos trae dinero pero su fecha es de ALTA, no de movimiento', () => {
    // La distinción que hace que la regla acierte: `FechaAlta` es cuándo se creó la ficha,
    // no cuándo pasó algo. Por eso no cuenta como señal de movimiento y la hoja se descarta
    // pese a tener `CostoUnitario` y `PrecioVenta`. Si contara, se pagaría por 43 filas que
    // no pueden mapear a ninguna de las tres entidades destino.
    expect(classifySheet(PRODUCTOS)).toBe('catalog');
  });
});

describe('el sesgo va SIEMPRE hacia pagar de más', () => {
  test('una hoja sin encabezados legibles va al modelo', () => {
    expect(classifySheet([])).toBe('unknown');
    expect(classifySheet(['', null])).toBe('unknown');
    expect(canSkipSheet([null, undefined])).toBe(false);
  });

  test('encabezados desconocidos van al modelo', () => {
    // Un exporte de un sistema contable raro, en otro idioma, con nombres propios.
    expect(canSkipSheet(['Col1', 'Col2', 'Col3'])).toBe(false);
    expect(canSkipSheet(['Concepto', 'Ref', 'Observaciones'])).toBe(false);
  });

  test('dinero SIN fecha no alcanza para descartar ni para afirmar', () => {
    // Cada señal sola aparece en catálogos: `Productos` tiene precio sin ser movimiento.
    expect(canSkipSheet(['Producto', 'Precio', 'Costo'])).toBe(false);
  });
});

describe('robustez del encabezado', () => {
  test('acentos, mayúsculas y separadores no cambian el resultado', () => {
    // El mismo archivo exportado por dos sistemas puede traer "Teléfono", "TELEFONO" o
    // "telefono_contacto". Si eso cambiara la decisión, la regla sería inservible.
    const a = ['IDCliente', 'Nombre', 'Apellido', 'Email', 'Teléfono'];
    const b = ['id_cliente', 'NOMBRE', 'apellido', 'E-Mail', 'TELEFONO'];
    expect(classifySheet(a)).toBe(classifySheet(b));
    expect(classifySheet(a)).toBe('catalog');
  });
});

describe('el ahorro sobre los archivos reales', () => {
  test('de las 8 hojas, 5 no llegan al modelo', () => {
    const libro = [
      ['Productos', PRODUCTOS],
      ['Tiendas', TIENDAS],
      ['Clientes', CLIENTES],
      ['Proveedores', PROVEEDORES],
      ['OrdenesCompra', ORDENES_COMPRA],
      ['LineasOC', LINEAS_OC],
      ['Inventario', INVENTARIO],
      ['Ventas', VENTAS],
    ] as const;

    const saltadas = libro.filter(([, h]) => canSkipSheet([...h]));
    expect(saltadas.map(([n]) => n).sort()).toEqual([
      'Clientes',
      'Inventario',
      'Productos',
      'Proveedores',
      'Tiendas',
    ]);
  });

  test('son ~370 filas de las ~1.170 del archivo', () => {
    // Conteos reales de los archivos de prueba.
    const filas: Record<string, number> = {
      Productos: 43,
      Tiendas: 6,
      Clientes: 101,
      Proveedores: 7,
      OrdenesCompra: 61,
      LineasOC: 221,
      Inventario: 211,
      Ventas: 521,
    };
    const saltadas = ['Clientes', 'Inventario', 'Productos', 'Proveedores', 'Tiendas'];
    const ahorro = saltadas.reduce((n, k) => n + filas[k]!, 0);
    const total = Object.values(filas).reduce((a, b) => a + b, 0);

    expect(total).toBe(1171);
    expect(ahorro).toBe(368);
    // Casi un tercio del archivo, sin tocar la calidad de clasificación de nada.
    expect(ahorro / total).toBeGreaterThan(0.3);
  });
});

/**
 * ═══ EL CANDADO QUE SALVA UN LIBRO DE MOVIMIENTOS (HeladosGT, 2026-08-24) ═══
 *
 * El worker manda una hoja a inventario cuando el esquema del libro la marca como tabla de
 * entidades Y `classifySheet` NO la ve como `financial`. Esta segunda condición es lo único
 * que evita que una hoja de ventas se registre como stock cuando su libro no trae inventario
 * — pasó en producción y dejó a una heladería con Q 58.334 de ingreso contra Q 1.797.772 de
 * gasto.
 *
 * Estos dos casos son los REALES de los dos archivos, y tienen que dar distinto.
 */
describe('financial vs catálogo: el candado del enrutado a inventario', () => {
  test('una hoja de ventas es financial, así que nunca va a inventario', () => {
    expect(classifySheet(['IDVenta', 'Fecha', 'Cliente', 'Monto (Q)'])).toBe('financial');
  });

  test('el inventario de una concesionaria NO es financial, así que puede ir', () => {
    // Trae dinero y fecha, pero también las señales de catálogo: el desempate lo saca de
    // `financial`, que es justo lo que lo habilita como tabla de entidades.
    expect(
      classifySheet([
        'ID Vehiculo',
        'VIN',
        'Marca',
        'Modelo',
        'Costo Adquisicion (Q)',
        'Precio Lista (Q)',
        'Fecha Ingreso',
        'Sucursal',
        'Estado',
      ]),
    ).not.toBe('financial');
  });
});
