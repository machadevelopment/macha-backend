import { describe, expect, test } from 'bun:test';
import {
  agruparCandidatos,
  aEjemploFewShot,
  esCorreccionQueEnseña,
  type Correccion,
} from './learning-loop';

/**
 * El ciclo de aprendizaje estaba cortado: el staff corrige una fila, la corrección se guarda
 * en `admin_audit_log` y ahí se muere. La plantilla de industria nunca se entera, así que el
 * sistema comete el mismo error para siempre.
 *
 * Lo que estos tests protegen NO es que el ciclo exista — es que sea EXIGENTE. Cada ejemplo
 * que entra a la plantilla vive dentro del bloque cacheado del prompt y se paga en cada
 * llamada de ingesta, para siempre. Un filtro flojo infla el costo de todas las
 * clasificaciones futuras para enseñar un caso que pasó una vez.
 */

const correccion = (before: object, after: object): Correccion => ({
  before: { type: 'other', category: 'sin_clasificar', description: 'Pago mensual', ...before },
  after: { type: 'other', category: 'sin_clasificar', description: 'Pago mensual', ...after },
  targetEntity: 'transaction',
});

describe('qué corrección enseña algo', () => {
  test('cambiar el tipo contable enseña', () => {
    expect(esCorreccionQueEnseña(correccion({ type: 'other' }, { type: 'opex' }))).toBe(true);
  });

  test('cambiar la categoría enseña', () => {
    expect(esCorreccionQueEnseña(correccion({ category: 'otros' }, { category: 'alquiler' }))).toBe(
      true,
    );
  });

  test('corregir un MONTO no enseña nada', () => {
    /*
     * El filtro más importante, y el menos obvio. Desde que el modelo dejó de reconstruir las
     * filas (lib/row-assembly.ts), el monto lo arma el código leyendo la celda que el mapa
     * señala — el modelo no lo decide.
     *
     * Un ejemplo construido sobre esa corrección le enseñaría al modelo algo sobre lo que ya
     * no controla, y ocuparía espacio en el prompt de todas las llamadas futuras a cambio de
     * nada.
     */
    expect(
      esCorreccionQueEnseña(correccion({ originalAmount: 100 }, { originalAmount: 1000 })),
    ).toBe(false);
  });

  test('corregir una fecha o una descripción tampoco', () => {
    expect(esCorreccionQueEnseña(correccion({ date: '2026-01-01' }, { date: '2026-02-01' }))).toBe(
      false,
    );
    expect(esCorreccionQueEnseña(correccion({ description: 'a' }, { description: 'b' }))).toBe(
      false,
    );
  });

  test('aprobar sin tocar nada no enseña', () => {
    // Es la mayoría de las revisiones: confirma que el modelo acertó. No hay lección, y
    // convertirlo en ejemplo llenaría la plantilla de ruido caro.
    expect(esCorreccionQueEnseña(correccion({}, {}))).toBe(false);
  });

  test('un cambio de solo mayúsculas no enseña', () => {
    // "Alquiler" y "alquiler" son la misma decisión escrita distinto. Sin esto, la plantilla
    // acumularía pares casi idénticos que solo suben el costo del prompt.
    expect(
      esCorreccionQueEnseña(correccion({ category: 'alquiler' }, { category: 'Alquiler' })),
    ).toBe(false);
  });

  test('BORRAR la categoría no enseña', () => {
    // Enseñaría a no clasificar, y el prompt exige clasificar siempre (inventando el nombre
    // si hace falta). Un ejemplo con categoría vacía contradice la instrucción principal.
    expect(esCorreccionQueEnseña(correccion({ category: 'alquiler' }, { category: null }))).toBe(
      false,
    );
  });
});

describe('cómo se arma el ejemplo', () => {
  const ej = aEjemploFewShot({
    before: { type: 'other', category: 'otros', description: 'Renta local zona 10' },
    after: {
      type: 'opex',
      category: 'alquiler',
      description: 'Renta local zona 10',
      originalAmount: 8500,
      originalCurrency: 'GTQ',
    },
    targetEntity: 'transaction',
  });

  test('la entrada NO incluye la respuesta', () => {
    // Si el `input` trajera la categoría corregida, el ejemplo le estaría regalando el
    // resultado y no enseñaría a deducirlo. Es el error clásico de armar few-shot desde un
    // registro de auditoría, donde antes y después están uno al lado del otro.
    expect(ej.input).not.toContain('alquiler');
    expect(ej.input).not.toContain('opex');
    expect(ej.input).toContain('Renta local zona 10');
  });

  test('la salida usa la forma COMPACTA que el modelo devuelve hoy', () => {
    // Los ejemplos viejos guardados con la forma anidada siguen funcionando —el bloque de
    // plantilla los proyecta— pero los nuevos nacen ya en el formato correcto.
    expect(ej.output).toEqual({ e: 'transaction', t: 'opex', c: 'alquiler' });
  });

  test('los campos vacíos no ensucian la entrada', () => {
    const vacio = aEjemploFewShot({
      before: {},
      after: { type: 'opex', category: 'alquiler', description: 'Renta', product: null },
      targetEntity: 'transaction',
    });
    expect(vacio.input).toBe('Descripción=Renta');
  });
});

describe('agrupar: la frecuencia es la señal', () => {
  const mismaLeccion = (n: number): Correccion[] =>
    Array.from({ length: n }, () => ({
      before: { type: 'other', category: 'otros', description: 'Renta local' },
      after: { type: 'opex', category: 'alquiler', description: 'Renta local' },
      targetEntity: 'transaction' as const,
    }));

  test('la misma corrección repetida es UN candidato con su conteo', () => {
    const [c] = agruparCandidatos(mismaLeccion(7));
    expect(c!.veces).toBe(7);
    expect(c!.ejemplo.output).toEqual({ e: 'transaction', t: 'opex', c: 'alquiler' });
  });

  test('lo más repetido va primero', () => {
    /*
     * Es lo que distingue una lección de una anécdota. Que un humano haya arreglado lo mismo
     * siete veces dice que el modelo se equivoca ahí sistemáticamente; una corrección única
     * puede ser un caso raro de UNA empresa, y un ejemplo malo empeora la clasificación de
     * toda la industria.
     */
    const otra: Correccion = {
      before: { type: 'other', category: 'otros', description: 'Comisión bancaria' },
      after: { type: 'opex', category: 'servicios_financieros', description: 'Comisión bancaria' },
      targetEntity: 'transaction',
    };
    const candidatos = agruparCandidatos([...mismaLeccion(3), otra]);
    expect(candidatos.map((c) => c.veces)).toEqual([3, 1]);
  });

  test('las revisiones que no enseñan no aparecen', () => {
    const soloAprobadas: Correccion[] = [
      { before: { type: 'opex' }, after: { type: 'opex' }, targetEntity: 'transaction' },
      {
        before: { type: 'opex', originalAmount: 1 },
        after: { type: 'opex', originalAmount: 2 },
        targetEntity: 'transaction',
      },
    ];
    expect(agruparCandidatos(soloAprobadas)).toEqual([]);
  });

  test('una corrección sin datos que mostrar no genera ejemplo', () => {
    // Sin descripción, producto ni monto no hay nada de lo que el modelo pueda deducir la
    // categoría: el ejemplo sería una respuesta sin pregunta.
    const sinDatos: Correccion[] = [
      {
        before: { category: 'otros' },
        after: { category: 'alquiler' },
        targetEntity: 'transaction',
      },
    ];
    expect(agruparCandidatos(sinDatos)).toEqual([]);
  });

  test('el orden es estable cuando empatan', () => {
    // Sin desempate, dos candidatos con el mismo conteo saldrían en orden arbitrario y la
    // pantalla del staff bailaría entre recargas.
    const a: Correccion = {
      before: { category: 'x' },
      after: { category: 'aaa', description: 'Alfa' },
      targetEntity: 'transaction',
    };
    const b: Correccion = {
      before: { category: 'x' },
      after: { category: 'bbb', description: 'Beta' },
      targetEntity: 'transaction',
    };
    expect(agruparCandidatos([b, a]).map((c) => c.ejemplo.input)).toEqual([
      'Descripción=Alfa',
      'Descripción=Beta',
    ]);
  });
});
