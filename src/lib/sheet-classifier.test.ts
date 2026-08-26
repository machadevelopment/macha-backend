import { describe, expect, test } from 'bun:test';
import {
  canSkipSheet,
  classifySheet,
  firmaDeCatalogo,
  pareceLibroDeMovimientos,
  noPuedeProducirMovimientos,
} from './sheet-classifier';

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

/**
 * ═══ EL SET DE ENTIDADES TIENE DOS CONSUMIDORES Y AMBOS DEBEN LEER LO MISMO ═══
 *
 * `analizarEsquema` marca como tabla de entidades a toda hoja referenciada que no referencia a
 * nadie — y eso incluye a un libro de VENTAS cuando el archivo no trae inventario. El worker
 * corrige ese set con `classifySheet !== 'financial'`, UNA vez, porque el veredicto lo
 * consultan dos decisiones distintas:
 *
 *   1. si la hoja va a inventario en vez de a movimientos;
 *   2. si las facturas de OTRA hoja ya tienen su venta registrada (y no deben devengar).
 *
 * La primera versión del arreglo puso el candado solo en (1). Medido en producción DESPUÉS de
 * ese arreglo, en el archivo de HeladosGT: las ventas ya no se perdían, pero (2) seguía leyendo
 * el set sin corregir, así que las 43 cuentas por cobrar volvieron a sumar Q 58.334 de ingreso
 * que la hoja `Ventas` ya había registrado.
 *
 * Este test fija la ÚNICA condición de la que dependen las dos: que una hoja de ventas se
 * distinga de un catálogo de inventario.
 */
describe('la señal que corrige el set de entidades', () => {
  /*
   * Encabezados COMPLETOS de los archivos que pasaron por producción. Recortarlos cambia el
   * veredicto —lo comprobé escribiendo la primera versión con cinco columnas— y es el mismo
   * modo de fallo que ya documenta el corpus de hojas reales.
   */
  const VENTAS_CONCESIONARIA = [
    'ID Venta', 'Fecha', 'Cliente', 'Vendedor', 'ID Vehiculo', 'VIN', 'Marca', 'Modelo',
    'Anio Modelo', 'Tipo', 'Precio Venta (Q)', 'Costo Vehiculo (Q)', 'Forma de Pago',
    'Sucursal', 'Utilidad Bruta (Q)',
  ]; // prettier-ignore
  const INVENTARIO_CONCESIONARIA = [
    'ID Vehiculo', 'VIN', 'Marca', 'Modelo', 'Anio Modelo', 'Tipo', 'Color',
    'Costo Adquisicion (Q)', 'Precio Lista (Q)', 'Fecha Ingreso', 'Sucursal', 'Estado',
    'Dias en Inventario',
  ]; // prettier-ignore
  const VENTAS_HELADERIA = [
    'ID Venta', 'Fecha', 'Cliente', 'Vendedor', 'ID Producto', 'Producto', 'Categoría',
    'Presentación', 'Unidades', 'Precio Unitario (Q)', 'Ventas Netas (Q)', 'Costo Venta (Q)',
    'Forma de Pago', 'Sucursal', 'Utilidad Bruta (Q)',
  ]; // prettier-ignore
  const INVENTARIO_HELADERIA = [
    'ID Producto', 'Producto', 'Categoría', 'Presentación', 'Sabor', 'Stock Actual',
    'Costo Unitario (Q)', 'Precio Lista (Q)',
  ]; // prettier-ignore

  test('un libro de ventas es de movimientos, decida lo que decida el grafo', () => {
    expect(pareceLibroDeMovimientos(VENTAS_CONCESIONARIA)).toBe(true);
    expect(pareceLibroDeMovimientos(VENTAS_HELADERIA)).toBe(true);
  });

  test('una lista de existencias NO lo es, así que puede ir a inventario', () => {
    expect(pareceLibroDeMovimientos(INVENTARIO_CONCESIONARIA)).toBe(false);
    expect(pareceLibroDeMovimientos(INVENTARIO_HELADERIA)).toBe(false);
  });

  /**
   * El caso que descarta los dos candidatos anteriores, y por eso vale como test.
   *
   * El inventario de una concesionaria trae `Costo Adquisicion` y `Fecha Ingreso`: tiene
   * dinero y fecha igual que una hoja de ventas. Cualquier regla basada en "tiene columna de
   * dinero" lo clasifica mal, y con él se pierde el caso que el mecanismo vino a resolver.
   */
  test('tener dinero y fecha NO alcanza: un inventario también los tiene', () => {
    const conDineroYFecha = ['Costo Adquisicion (Q)', 'Fecha Ingreso'];
    expect(pareceLibroDeMovimientos(conDineroYFecha)).toBe(false);
  });

  /**
   * Y el que descarta el PRIMER candidato (`classifySheet === 'financial'`), que funcionaba de
   * casualidad: la hoja de ventas de la concesionaria se salvaba por tener una columna llamada
   * exactamente "Utilidad Bruta". Con otro nombre igual de normal, se perdía.
   */
  test('la hoja de ventas se reconoce aunque ninguna columna de dinero coincida exacto', () => {
    const sinNombresExactos = VENTAS_CONCESIONARIA.map((c) =>
      c === 'Utilidad Bruta (Q)' ? 'Margen (Q)' : c,
    );
    expect(pareceLibroDeMovimientos(sinNombresExactos)).toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LO QUE ROMPIÓ UN CORPUS DE DIEZ LIBROS DE RUBROS DISTINTOS (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Corriendo el pipeline determinista contra diez archivos reales, siete salían mal. Estos son
 * los dos ejes que fallaban, con las hojas exactas que los destaparon.
 */
describe('la contraparte también se llama paciente, huésped o alumno', () => {
  /*
   * `Consultas` son los 214 INGRESOS de una clínica dental — `Precio (Q)` y `Forma de Pago`.
   * `CuentasPorCobrar` la referencia, así que el esquema la declaró tabla de entidades y se
   * registró como INVENTARIO: 210 unidades en existencia y CERO ingresos en el dashboard.
   *
   * Lo único que podía desmentirlo era la lista de contrapartes, que decía `cliente` mientras
   * la hoja decía `Paciente`. Es el mismo fallo que se llevó las ventas de HeladosGT.
   */
  test('la hoja de consultas de una clínica ES un libro de movimientos', () => {
    expect(
      pareceLibroDeMovimientos([
        'ID Consulta',
        'Fecha',
        'Paciente',
        'Odontologo',
        'Tratamiento',
        'Precio (Q)',
        'Forma de Pago',
        'Sucursal',
      ]),
    ).toBe(true);
  });

  test('y un inventario de concesionaria sigue SIN serlo', () => {
    // La contraparte aparece el día que se vende, y esa fila vive en la hoja de ventas.
    expect(
      pareceLibroDeMovimientos([
        'ID Vehiculo',
        'VIN',
        'Marca',
        'Costo Adquisicion (Q)',
        'Fecha Ingreso',
        'Estado',
      ]),
    ).toBe(false);
  });
});

describe('un inventario de mostrador no usa vocabulario de bodega', () => {
  /*
   * La firma de existencias nació de una cafetería y busca `stock`, `punto de reorden`,
   * `unidad de medida`. Un inventario de ferretería o de boutique no usa ninguna de esas
   * palabras: daban 0 coincidencias y se iban a MOVIMIENTOS — 154 artículos de la ferretería
   * como transacciones, sumando Q 9.438.823 de costo que nadie gastó.
   *
   * Lo que los separa de una hoja de ventas por producto —que también trae producto y
   * cantidad— no es otra palabra: es que una lista de existencias es un conteo en un MOMENTO
   * y NO TIENE FECHA por fila. Un movimiento siempre la tiene.
   */
  test('ferretería y boutique se reconocen como existencias', () => {
    expect(
      firmaDeCatalogo([
        'SKU',
        'Producto',
        'Categoria',
        'Cantidad',
        'Costo Unitario (Q)',
        'Precio Lista (Q)',
        'Sucursal',
      ]),
    ).toBe('existencias');
    expect(
      firmaDeCatalogo([
        'SKU',
        'Prenda',
        'Talla',
        'Cantidad',
        'Costo Unitario (Q)',
        'Precio Venta (Q)',
      ]),
    ).toBe('existencias');
  });

  /*
   * El error simétrico y PEOR: capturar una hoja de ventas como inventario le borraría los
   * ingresos al cliente. La fecha es lo que lo impide.
   */
  test('una hoja de ventas por producto NO se captura como inventario', () => {
    expect(
      firmaDeCatalogo(['Fecha', 'Producto', 'Cantidad', 'Total (Q)', 'Costo (Q)', 'Area']),
    ).toBe(null);
    expect(firmaDeCatalogo(['ID Orden', 'Producto', 'Cantidad', 'Monto Linea (Q)'])).toBe(null);
  });

  /*
   * `costo` y `precio` a secas eran demasiado genéricos: capturaban una hoja de análisis de
   * márgenes con columnas "PRECIO INDIVIDUAL MENSUAL - ENERO". Lo atrapó el corpus de hojas
   * reales antes de llegar a producción, que es exactamente para lo que existe.
   */
  test('exige un costo POR UNIDAD y un identificador de artículo', () => {
    expect(firmaDeCatalogo(['Cantidad', 'Precio'])).toBe(null);
    expect(firmaDeCatalogo(['Cantidad', 'Costo Unitario'])).toBe(null); // sin identificador
  });
});

/**
 * El catálogo moderno no trae vocabulario de contacto — y sin una fecha no hay movimiento.
 *
 * `Clientes: ID · Nombre · Industria · Plan`, `Rutas`, `Flota`: los tres se iban al modelo,
 * y la mitad de los diez libros del corpus traía al menos uno.
 *
 * No rompe el sesgo de "ante la duda, al modelo": un movimiento sin fecha lo rechaza
 * `staging-rules` por `invalid_date`. Lo único que cambia es dónde se detiene.
 */
describe('una hoja que no puede producir movimientos se descarta', () => {
  const leerFecha = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const leerNumero = (v: unknown) => (typeof v === 'number' ? v : null);
  const juzgar = (rows: unknown[][]) => noPuedeProducirMovimientos(rows, leerFecha, leerNumero);

  test('un catálogo de rutas: ni una fecha en toda la hoja', () => {
    expect(
      juzgar([
        ['ID Ruta', 'Ruta', 'Distancia (km)', 'Tiempo Estimado'],
        ...Array.from({ length: 10 }, (_, i) => [`R-${i}`, `Ruta ${i}`, 100 + i, 3]),
      ]),
    ).toBe(true);
  });

  /*
   * El catálogo de clientes de un bufete SÍ tiene una fecha real (`Fecha Alta`). Lo que no
   * tiene es plata en ninguna otra columna — y las dos mitades hacen falta.
   */
  test('un catálogo CON fecha pero sin dinero también se descarta', () => {
    expect(
      juzgar([
        ['ID Cliente', 'Nombre', 'Tipo', 'Area Principal', 'Fecha Alta'],
        ...Array.from({ length: 10 }, (_, i) => [
          `CLI-${i}`,
          `Cliente ${i}`,
          'Empresa',
          'Laboral',
          `2024-0${(i % 9) + 1}-15`,
        ]),
      ]),
    ).toBe(true);
  });

  /*
   * Lo que hace segura la señal: la fecha y el dinero se buscan en columnas DISTINTAS. Una
   * hoja de movimientos cuyos montos caen todos en el rango de seriales de Excel (decenas de
   * miles) NO se descarta, porque su fecha sigue siendo otra columna.
   */
  test('una hoja de movimientos con montos de cinco cifras NO se descarta', () => {
    expect(
      juzgar([
        ['Fecha', 'Concepto', 'Monto'],
        ...Array.from({ length: 10 }, (_, i) => [`2025-0${(i % 9) + 1}-10`, 'Venta', 45_000 + i]),
      ]),
    ).toBe(false);
  });

  test('una hoja de movimientos con la columna mal nombrada NO se descarta', () => {
    // Se juzga el CONTENIDO: `Emision` no está en ningún vocabulario, pero trae fechas.
    expect(
      juzgar([
        ['Ref', 'Emision', 'Detalle', 'Importe'],
        ...Array.from({ length: 10 }, (_, i) => [`F-${i}`, `2025-0${(i % 9) + 1}-15`, 'Serv', 100]),
      ]),
    ).toBe(false);
  });

  test('una hoja chica se manda igual: no se puede afirmar nada con tres filas', () => {
    expect(
      juzgar([
        ['A', 'B'],
        ['x', 'y'],
        ['x', 'y'],
      ]),
    ).toBe(false);
  });
});
