import { describe, expect, test } from 'bun:test';
import { ameritaAdvertencia, diferenciasDeMapa } from './column-profile';
import type { ColumnMap } from './row-assembly';

/**
 * CU-868krmrcj — la parte PURA del perfil de columnas: qué cambió entre dos mapas y cuándo
 * eso amerita advertirle al cliente.
 *
 * La decisión que estos tests defienden (Keneth, 2026-08-16): **advertencia con confirmación,
 * nunca bloqueo duro**. Y para que una advertencia sirva tiene que ser rara — si salta en
 * cada carga, lo único que enseña es a hacer clic en "continuar" sin leer, y entonces no
 * existe el día que sí importa.
 *
 * Las funciones que tocan base (`perfilVigente`, `guardarPerfil`) se cubren en los tests de
 * integración, que corren contra Postgres real con el rol `macha_app` — que es donde se puede
 * comprobar de verdad que el append-only aguanta.
 */

const BASE: ColumnMap = {
  date: 0,
  amount: 4,
  currency: null,
  description: null,
  counterparty: null,
  product: 1,
  quantity: 2,
  productCategory: null,
  dueDate: null,
  costTotal: 5,
  costUnit: null,
};

describe('diferenciasDeMapa', () => {
  test('dos mapas iguales no tienen diferencias', () => {
    expect(diferenciasDeMapa(BASE, { ...BASE })).toEqual([]);
  });

  test('nombra el CAMPO, no el índice', () => {
    // Al cliente le importa "ya no encuentro la columna de fecha", no "el índice 4 pasó a 7".
    const movido = { ...BASE, amount: 7 };
    expect(diferenciasDeMapa(BASE, movido)).toEqual([{ campo: 'amount', antes: 4, ahora: 7 }]);
  });

  test('reporta varias a la vez', () => {
    const otro = { ...BASE, amount: 7, product: null };
    const campos = diferenciasDeMapa(BASE, otro).map((d) => d.campo);
    expect(campos.sort()).toEqual(['amount', 'product']);
  });
});

describe('ameritaAdvertencia', () => {
  test('GANAR un campo nuevo NO advierte', () => {
    // El archivo de esta semana trae costo y el de la pasada no. Es una mejora: se gana un
    // dato y el margen por producto pasa a calcularse. Advertir por esto entrenaría a
    // ignorar el aviso.
    const conCosto = { ...BASE, costUnit: 6 };
    expect(ameritaAdvertencia(diferenciasDeMapa(BASE, conCosto))).toBe(false);
  });

  test('PERDER un campo SÍ advierte', () => {
    // Algo que se venía leyendo dejó de leerse. El cliente tiene que saberlo antes de mirar
    // unas cifras que ya no incluyen ese dato.
    const sinCosto = { ...BASE, costTotal: null };
    expect(ameritaAdvertencia(diferenciasDeMapa(BASE, sinCosto))).toBe(true);
  });

  test('MOVER un campo de columna SÍ advierte — es el caso peligroso', () => {
    // Peor que perderlo: el dato sigue entrando, desde la columna equivocada, y nada falla.
    // Un monto leído de la columna de fechas es plausible y silencioso.
    const movido = { ...BASE, amount: 7 };
    expect(ameritaAdvertencia(diferenciasDeMapa(BASE, movido))).toBe(true);
  });

  test('sin diferencias no advierte', () => {
    expect(ameritaAdvertencia([])).toBe(false);
  });

  test('ganar varios campos y no perder ninguno sigue sin advertir', () => {
    // El caso del cliente que mejora su exportador: más columnas, ninguna movida.
    const enriquecido = { ...BASE, currency: 6, counterparty: 7, productCategory: 8 };
    expect(ameritaAdvertencia(diferenciasDeMapa(BASE, enriquecido))).toBe(false);
  });
});
