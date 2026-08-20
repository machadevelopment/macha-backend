import { describe, expect, test } from 'bun:test';
import { DiccionarioDeCategorias, claveDeConcepto } from '@/lib/category-dictionary';

/**
 * Diccionario de categorías por empresa — acuerdo Keneth–Semi, 2026-08-20.
 *
 * Lo que se prueba acá es la NORMALIZACIÓN y la regla de AUTORIDAD. Las dos deciden si una
 * regla guardada se vuelve a encontrar, y las dos fallan en silencio: si la clave no coincide
 * el diccionario simplemente no acierta nunca y se sigue pagando la clasificación, sin que
 * nada se rompa ni aparezca en un log.
 */

describe('claveDeConcepto', () => {
  test('el mismo concepto escrito de tres formas da UNA sola clave', () => {
    // Es el caso que justifica normalizar: guardar estas tres por separado haría que el
    // diccionario creciera sin aprender nada.
    const a = claveDeConcepto('Pago a CLARO');
    const b = claveDeConcepto('pago claro');
    const c = claveDeConcepto('Pago  a  Claro.');

    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('los acentos no parten el concepto en dos', () => {
    expect(claveDeConcepto('electricidad')).toBe(claveDeConcepto('ELECTRICIDÁD'));
  });

  test('un texto sin nada normalizable devuelve null, no cadena vacía', () => {
    /*
     * Importa más de lo que parece: una clave vacía casaría con TODA fila sin descripción y
     * clasificaría media hoja por accidente. La base también lo ataja con un CHECK, pero el
     * primer filtro va acá.
     */
    expect(claveDeConcepto('')).toBeNull();
    expect(claveDeConcepto('   ')).toBeNull();
    expect(claveDeConcepto('...')).toBeNull();
    expect(claveDeConcepto(null)).toBeNull();
    expect(claveDeConcepto(42)).toBeNull();
  });

  test('dos conceptos distintos NO colapsan', () => {
    // El riesgo opuesto al de arriba, y el peor de los dos: si "transporte" y "servicios"
    // dieran la misma clave, una regla clasificaría plata en el rubro equivocado.
    expect(claveDeConcepto('flete de mercadería')).not.toBe(claveDeConcepto('pago a claro'));
  });
});

/** Un diccionario armado a mano, sin tocar la base. */
function conReglas(
  entradas: Array<{ texto: string; category: string; source?: string; version?: number }>,
): DiccionarioDeCategorias {
  const filas = entradas.map((e) => ({
    concepto: claveDeConcepto(e.texto)!,
    entity: 'transaction',
    type: 'opex',
    category: e.category,
    source: e.source ?? 'inferido',
    version: e.version ?? 1,
  }));
  // Se ejercita el MISMO camino de decisión que `cargar`, con las filas inyectadas.
  const db = {
    select: () => ({ from: () => ({ where: async () => filas }) }),
  } as never;
  return DiccionarioDeCategorias.cargar(db, 'c1') as never as DiccionarioDeCategorias;
}

describe('la regla vigente: autoridad primero, versión después', () => {
  test('lo que confirmó el cliente gana sobre lo que infirió el modelo', async () => {
    /*
     * El corazón del acuerdo con Semi: el cliente entra al flujo porque sabe qué es "Cropa"
     * en su propio libro. Si el modelo pudiera pisarlo, se le volvería a preguntar algo que
     * ya contestó — que es exactamente lo que este mecanismo viene a evitar.
     */
    const d = await (conReglas([
      { texto: 'flete cropa', category: 'servicios', source: 'inferido', version: 1 },
      {
        texto: 'flete cropa',
        category: 'transporte',
        source: 'confirmado_por_cliente',
        version: 1,
      },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('flete cropa')?.category).toBe('transporte');
  });

  test('la autoridad manda AUNQUE la versión inferida sea más alta', async () => {
    /*
     * El caso que decide el orden de los dos criterios. El cliente confirma en la versión 1;
     * el modelo vuelve a inferir en cargas posteriores y llega a la versión 9. Si se ordenara
     * por versión primero, la regla del cliente quedaría enterrada por antigüedad.
     */
    const d = await (conReglas([
      {
        texto: 'pago claro',
        category: 'servicios',
        source: 'confirmado_por_cliente',
        version: 1,
      },
      { texto: 'pago claro', category: 'otros', source: 'inferido', version: 9 },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('pago claro')?.category).toBe('servicios');
  });

  test('entre reglas del MISMO origen, gana la versión más alta', async () => {
    const d = await (conReglas([
      { texto: 'alquiler local', category: 'viejo', source: 'inferido', version: 1 },
      { texto: 'alquiler local', category: 'nuevo', source: 'inferido', version: 2 },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('alquiler local')?.category).toBe('nuevo');
  });

  test('staff gana al modelo pero NO al cliente', async () => {
    // Un operador puede arreglar un disparate evidente; si el dueño ya dijo qué es, sabe algo
    // que nosotros no.
    const d = await (conReglas([
      { texto: 'cuota gremial', category: 'del staff', source: 'corregido_por_staff' },
      { texto: 'cuota gremial', category: 'del cliente', source: 'confirmado_por_cliente' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('cuota gremial')?.category).toBe('del cliente');
  });

  test('un concepto que el diccionario no conoce devuelve null', async () => {
    // Y eso es lo que hace que la fila vaya al modelo: sin regla, no se inventa una.
    const d = await (conReglas([
      { texto: 'pago claro', category: 'servicios' },
    ]) as never as Promise<DiccionarioDeCategorias>);

    expect(d.buscar('compra de vitrinas')).toBeNull();
  });

  test('el diccionario vacío no acierta nada y no revienta', () => {
    const d = DiccionarioDeCategorias.vacio();
    expect(d.tamano).toBe(0);
    expect(d.buscar('cualquier cosa')).toBeNull();
  });
});
