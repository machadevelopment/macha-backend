import { describe, expect, test } from 'bun:test';
import { destinosDeLaFila, destinosDeLaHoja } from './destinos-de-la-fila';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * A QUÉ PANTALLAS LLEGA CADA FILA (reporte de Jose, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"La data no va únicamente al dashboard… si ponemos solo los del dashboard y el campo va a
 * cuentas por pagar, no lo estamos registrando."*
 *
 * Lo que se prueba acá son las combinaciones donde una fila llega a MÁS de una pantalla, que es
 * justo lo que el portón no decía: listar solo la cuenta esconde la mitad que el cliente ve en
 * su dashboard, y listar solo el rubro esconde la cuenta.
 */
describe('destinosDeLaFila', () => {
  const fila = (targetEntity: 'transaction' | 'invoice' | 'bill', payload: object) =>
    destinosDeLaFila({ targetEntity, payload: payload as Record<string, unknown> }).sort();

  test('una venta simple: ingresos del período', () => {
    expect(fila('transaction', { type: 'revenue' })).toEqual(['ingresos']);
  });

  test('una FACTURA EMITIDA llega a Por cobrar Y a Ingresos', () => {
    /*
     * Las dos caras del mismo hecho: emitirla devenga el ingreso y crea el derecho de cobro
     * (regla del 2026-08-19). Decir solo "Por cobrar" escondería que también movió el
     * dashboard, que es donde el dueño mira primero.
     */
    expect(fila('invoice', { type: 'revenue' })).toEqual(['ingresos', 'porCobrar']);
  });

  test('una CUENTA POR PAGAR llega a Por pagar Y a Costos', () => {
    // Simétrico: desde el 2026-08-30 una factura recibida produce su costo.
    expect(fila('bill', { type: 'cogs' })).toEqual(['costos', 'porPagar']);
  });

  test('una venta CON PRODUCTO alimenta además Ventas por producto', () => {
    expect(fila('transaction', { type: 'revenue', product: 'Aceite 1 L' })).toEqual([
      'ingresos',
      'productos',
    ]);
  });

  test('una COMPRA con producto NO va a Ventas por producto', () => {
    /*
     * Esa pantalla agrupa los INGRESOS por producto. Contar ahí una compra diría que un
     * producto vendió lo que en realidad costó.
     */
    expect(fila('transaction', { type: 'cogs', product: 'Aceite 1 L' })).toEqual(['costos']);
  });

  test('⚠️ `other` se declara SIN PANTALLA, y eso es el punto', () => {
    /*
     * `rollups.ts` suma `revenue`, `cogs` y `opex`: una fila `other` se guarda y **no aparece
     * en ninguna cifra**. Jose preguntó por escrito dónde caía ("¿y si fuera otro movimiento,
     * en dónde lo registra?") y la respuesta honesta es "en ningún lado que se vea". Decirlo
     * en el portón es lo que le permite corregirlo ANTES de publicar en vez de descubrirlo por
     * una cifra que no cuadra.
     */
    expect(fila('transaction', { type: 'other' })).toEqual(['sinPantalla']);
  });

  test('una fila sin tipo todavía declara su cuenta', () => {
    // Llega marcada y la contesta el cliente, pero ya se sabe que es una cuenta por pagar.
    expect(fila('bill', {})).toEqual(['porPagar']);
  });
});

describe('destinosDeLaHoja', () => {
  test('es la UNIÓN de sus filas, sin repetir', () => {
    /*
     * Una hoja de ventas con costo en la línea produce ingreso Y costo: si la pantalla
     * mostrara solo el destino de la primera fila, diría la mitad.
     */
    const r = destinosDeLaHoja([
      { targetEntity: 'transaction', payload: { type: 'revenue', product: 'Aceite' } },
      { targetEntity: 'transaction', payload: { type: 'cogs' } },
      { targetEntity: 'transaction', payload: { type: 'revenue' } },
    ]).sort();
    expect(r).toEqual(['costos', 'ingresos', 'productos']);
  });
});
