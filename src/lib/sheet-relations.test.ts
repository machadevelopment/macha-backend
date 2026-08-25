import { describe, expect, test } from 'bun:test';
import { analizarEsquema, type HojaParaComparar } from '@/lib/sheet-relations';

/**
 * El libro que motivó el módulo, recortado a lo que decide: `Concesionaria_Guatemala`, CarsGT,
 * 2026-08-24. Las proporciones se conservan (el inventario tiene más unidades que ventas, y
 * solo una parte de las ventas llega a cuenta por cobrar) porque de esa asimetría sale la
 * dirección de la relación.
 */
function libroDeConcesionaria(vendidos = 20, enPatio = 6, porCobrar = 8): HojaParaComparar[] {
  const inventario: unknown[][] = [['ID Vehiculo', 'VIN', 'Marca', 'Costo Adquisicion (Q)']];
  for (let i = 0; i < vendidos + enPatio; i++) {
    inventario.push([`VH-${i}`, `VIN${i}`, 'Mazda', 150_000 + i]);
  }

  const ventas: unknown[][] = [['ID Venta', 'Fecha', 'ID Vehiculo', 'Precio Venta (Q)']];
  for (let i = 0; i < vendidos; i++) {
    ventas.push([`V-${i}`, 45_000 + i, `VH-${i}`, 200_000 + i]);
  }

  const cxc: unknown[][] = [['ID CxC', 'ID Venta', 'Monto Total (Q)']];
  for (let i = 0; i < porCobrar; i++) {
    cxc.push([`C-${i}`, `V-${i}`, 50_000 + i]);
  }

  return [
    { nombre: 'Ventas', rows: ventas },
    { nombre: 'Inventario', rows: inventario },
    { nombre: 'CuentasPorCobrar', rows: cxc },
  ];
}

describe('esquema relacional del libro', () => {
  test('el inventario es tabla de entidades; el libro de ventas NO', () => {
    const e = analizarEsquema(libroDeConcesionaria());

    expect([...e.entidades]).toEqual(['Inventario']);
    /*
     * `Ventas` también es destino (CxC apunta a ella) y aun así no puede contar como catálogo:
     * es justamente el libro de movimientos que no hay que silenciar. Si este test se pone en
     * verde marcando las dos, el cliente pierde sus ventas.
     */
    expect(e.entidades.has('Ventas')).toBe(false);
  });

  test('la dirección va hacia la tabla que CONTIENE a la otra', () => {
    const e = analizarEsquema(libroDeConcesionaria());
    const r = e.referencias.find((x) => x.desde === 'Ventas' || x.hacia === 'Ventas');

    // Toda venta tiene su vehículo; no todo vehículo se vendió.
    expect(r?.desde).toBe('Ventas');
    expect(r?.hacia).toBe('Inventario');
  });

  test('se detecta que las cuentas por cobrar apuntan a una venta ya registrada', () => {
    const e = analizarEsquema(libroDeConcesionaria());
    const r = e.referencias.find((x) => x.desde === 'CuentasPorCobrar');

    expect(r?.hacia).toBe('Ventas');
    expect(r?.cobertura).toBe(1);
  });

  test('una sola relación por par de hojas, aunque compartan varias claves', () => {
    // El libro real relaciona Ventas e Inventario por `ID Vehiculo` Y por `VIN`: es el mismo
    // hecho dicho dos veces, y contarlo dos veces le daría doble peso a una sola relación.
    const e = analizarEsquema(libroDeConcesionaria());
    const entrePares = e.referencias.filter(
      (r) =>
        (r.desde === 'Ventas' && r.hacia === 'Inventario') ||
        (r.desde === 'Inventario' && r.hacia === 'Ventas'),
    );

    expect(entrePares).toHaveLength(1);
  });
});

describe('lo que NO debe detectarse', () => {
  test('dos hojas sin nada en común no se relacionan', () => {
    const ventas: unknown[][] = [['ID Venta', 'Monto']];
    const gastos: unknown[][] = [['ID Gasto', 'Monto']];
    for (let i = 0; i < 30; i++) {
      ventas.push([`V-${i}`, 100 + i]);
      gastos.push([`G-${i}`, 50 + i]);
    }

    const e = analizarEsquema([
      { nombre: 'Ventas', rows: ventas },
      { nombre: 'Gastos', rows: gastos },
    ]);

    expect(e.referencias).toHaveLength(0);
    expect(e.entidades.size).toBe(0);
  });

  /**
   * El falso positivo más barato de producir y el más caro de sufrir: dos hojas que comparten
   * una columna de ESTADO con tres valores se cubren al 100 % mutuamente. Si eso contara como
   * referencia, una hoja de movimientos quedaría marcada como catálogo y el cliente perdería
   * su contabilidad.
   */
  test('una columna de pocas etiquetas repetidas no es un identificador', () => {
    const a: unknown[][] = [['Fecha', 'Estado', 'Monto']];
    const b: unknown[][] = [['Fecha', 'Estado', 'Monto']];
    for (let i = 0; i < 40; i++) {
      a.push([45_000 + i, ['Pagado', 'Pendiente', 'Vencido'][i % 3], 100 + i]);
      b.push([45_000 + i, ['Pagado', 'Pendiente', 'Vencido'][i % 3], 200 + i]);
    }

    const e = analizarEsquema([
      { nombre: 'CxC', rows: a },
      { nombre: 'CxP', rows: b },
    ]);

    expect(e.referencias).toHaveLength(0);
  });

  test('la misma lista escrita dos veces no es una referencia', () => {
    // Eso es duplicación de otra clase y la resuelve `sheet-duplication.ts` comparando dinero.
    const filas = (): unknown[][] => {
      const r: unknown[][] = [['ID', 'Monto']];
      for (let i = 0; i < 30; i++) r.push([`X-${i}`, 100 + i]);
      return r;
    };

    const e = analizarEsquema([
      { nombre: 'Hoja1', rows: filas() },
      { nombre: 'Hoja2', rows: filas() },
    ]);

    expect(e.referencias).toHaveLength(0);
  });

  test('con pocos valores no se afirma nada (el azar alcanza para cubrir)', () => {
    const a: unknown[][] = [['ID'], ['A-1'], ['A-2'], ['A-3']];
    const b: unknown[][] = [['ID'], ['A-1'], ['A-2'], ['A-3'], ['A-4']];

    const e = analizarEsquema([
      { nombre: 'Chica', rows: a },
      { nombre: 'Grande', rows: b },
    ]);

    expect(e.referencias).toHaveLength(0);
  });

  test('una columna de fechas no se confunde con una clave', () => {
    // Las fechas tienen cardinalidad alta y valores cortos: sin el filtro de rango pasarían
    // por identificador, y dos hojas del mismo período se "referenciarían" entre sí.
    const a: unknown[][] = [['Fecha', 'Monto']];
    const b: unknown[][] = [['Fecha', 'Monto']];
    for (let i = 0; i < 40; i++) {
      a.push([45_000 + i, 100 + i]);
      b.push([45_000 + i, 900 + i]);
    }

    const e = analizarEsquema([
      { nombre: 'A', rows: a },
      { nombre: 'B', rows: b },
    ]);

    expect(e.referencias).toHaveLength(0);
  });
});

describe('tolerancias', () => {
  test('unas pocas filas nuevas no tumban la relación', () => {
    // Un archivo real trae ventas de vehículos que todavía no están en la hoja de inventario.
    // Exigir totalidad haría que una sola fila reciente apagara la detección del libro entero.
    const hojas = libroDeConcesionaria(20, 6, 8);
    const ventas = hojas.find((h) => h.nombre === 'Ventas')!;
    ventas.rows.push(['V-999', 46_000, 'VH-NUEVO', 210_000]);

    const e = analizarEsquema(hojas);
    expect(e.entidades.has('Inventario')).toBe(true);
  });
});

/**
 * ═══ EL AGUJERO QUE SE COMIÓ LAS VENTAS DE UN CLIENTE (HeladosGT, 2026-08-24) ═══
 *
 * Unas horas después de desplegar el esquema relacional, Jose subió el archivo de una
 * heladería y reportó "ninguna información pasó bien": la hoja `Ventas` —435 filas— se
 * registró como INVENTARIO, y su dashboard quedó con Q 58.334 de ingreso contra Q 1.797.772
 * de gasto.
 *
 * El defecto es exacto: una hoja cuenta como tabla de entidades si otra la referencia y ella
 * no referencia a nadie. En el archivo que motivó el mecanismo eso separaba bien —`Ventas`
 * apuntaba a `Inventario`, así que quedaba excluida— pero **ese enlace es una casualidad de
 * ese libro**. Sin hoja de inventario, `Ventas` queda terminal en el grafo.
 *
 * El test de arriba ("el libro de ventas NO") pasaba, porque su fixture tiene las tres hojas.
 * Este cubre el libro de DOS hojas, que es donde el grafo solo no alcanza.
 */
describe('un libro sin hoja de inventario', () => {
  /** Ventas referenciada por CuentasPorCobrar, y nada más. La forma de HeladosGT. */
  const libroSinInventario = (): HojaParaComparar[] => {
    const ventas: unknown[][] = [['IDVenta', 'Fecha', 'Cliente', 'Monto (Q)']];
    for (let i = 0; i < 40; i++) ventas.push([`V-${i}`, 45_800 + i, `Cliente ${i}`, 100 + i]);

    const cxc: unknown[][] = [['IDCxC', 'IDVenta', 'Fecha Factura', 'Monto Total (Q)']];
    for (let i = 0; i < 12; i++) cxc.push([`C-${i}`, `V-${i}`, 45_810 + i, 50 + i]);

    return [
      { nombre: 'Ventas', rows: ventas },
      { nombre: 'CuentasPorCobrar', rows: cxc },
    ];
  };

  test('el grafo SOLO no alcanza: la hoja de ventas queda terminal', () => {
    /*
     * Se afirma el comportamiento REAL, no el deseado, y a propósito: este módulo lee la
     * forma del libro y no sabe de contabilidad. Quien tiene que salvar a `Ventas` es el
     * worker, con la segunda señal (`classifySheet`). Si algún día alguien "arregla" esto
     * acá, este test le avisa que está tocando la capa equivocada.
     */
    const e = analizarEsquema(libroSinInventario());
    expect(e.entidades.has('Ventas')).toBe(true);
  });

  test('y por eso el veredicto del esquema NUNCA basta solo', () => {
    // La contraparte del test de arriba: en los dos libros la hoja referenciada es la que
    // CONTIENE a la otra —el inventario contiene lo vendido, las ventas contienen lo que
    // quedó por cobrar— así que la forma del grafo no puede distinguirlas ni en principio.
    const e = analizarEsquema(libroSinInventario());
    const r = e.referencias.find((x) => x.desde === 'CuentasPorCobrar');
    expect(r?.hacia).toBe('Ventas');
  });
});
