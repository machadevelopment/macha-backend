import { describe, expect, test } from 'bun:test';

// env.ts valida DATABASE_URL al importar, incluso para un parser que no toca la base.
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { parseInsights } = await import('@/lib/anthropic');

/**
 * ═══ EL CONSEJO DEL VECINO FALLABA Y EL TUYO NO (2026-08-28) ═══
 *
 * Producción: `stop_reason=tool_use`, ~400 tokens, `insights=0`. Claude SÍ llamó a
 * `emit_insights`. El parser tiraba cada elemento porque el modelo copia las claves
 * del snapshot (`revenue`, `opex`) y CU-868kx7a73 había cambiado el tag en el
 * frontend y en el esquema de Elysia, no en este parser. Una empresa "tenía suerte"
 * (el modelo usaba `sales`/`financial`); la de al lado veía "la respuesta llegó
 * incompleta".
 */
describe('parseInsights no tira un consejo por el nombre de la categoría', () => {
  test('las categorías vigentes (cashflow/revenue/expenses/collections) pasan', () => {
    const r = parseInsights({
      insights: [
        { category: 'revenue', text: 'Las ventas cayeron.' },
        { category: 'expenses', text: 'Los gastos subieron.' },
        { category: 'cashflow', text: 'La caja está justa.' },
        { category: 'collections', text: 'Hay facturas vencidas.' },
      ],
    });
    expect(r.map((i) => i.category)).toEqual(['revenue', 'expenses', 'cashflow', 'collections']);
  });

  test('las claves del snapshot (revenue/opex) no vacían la lista', () => {
    // Reproducción del fallo de producción: el modelo copia las claves que ve.
    const r = parseInsights({
      insights: [
        { category: 'revenue', text: 'Ingresos Q 12,000 este mes.' },
        { category: 'opex', text: 'Nómina se comió el margen.' },
      ],
    });
    expect(r).toHaveLength(2);
    expect(r[0]!.category).toBe('revenue');
    expect(r[1]!.category).toBe('expenses');
    expect(r.map((i) => i.text).join(' ')).toContain('Nómina');
  });

  test('los nombres viejos (sales/financial) se mapean, no se tiran', () => {
    const r = parseInsights({
      insights: [
        { category: 'sales', text: 'Vendió más que el mes pasado.' },
        { category: 'financial', text: 'El margen bruto aguantó.' },
      ],
    });
    expect(r[0]!.category).toBe('revenue');
    expect(r[1]!.category).toBe('cashflow');
  });

  test('una categoría desconocida CON texto se sirve como cashflow', () => {
    const r = parseInsights({
      insights: [{ category: 'inventory', text: 'El café premium se está agotando.' }],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.category).toBe('cashflow');
    expect(r[0]!.text).toContain('café premium');
  });

  test('sin texto sí se descarta: no hay consejo que servir', () => {
    expect(parseInsights({ insights: [{ category: 'revenue', text: '   ' }] })).toEqual([]);
  });

  test('severity y action viajan cuando el modelo las manda', () => {
    const r = parseInsights({
      insights: [
        {
          category: 'collections',
          text: 'Tres facturas llevan más de 30 días.',
          severity: 'critical',
          action: 'Llamar a los tres clientes hoy.',
        },
      ],
    });
    expect(r[0]!.severity).toBe('critical');
    expect(r[0]!.action).toBe('Llamar a los tres clientes hoy.');
  });

  test('el JSON de la herramienta como string también parsea', () => {
    const r = parseInsights(
      JSON.stringify({ insights: [{ category: 'revenue', text: 'Subieron las ventas.' }] }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.category).toBe('revenue');
  });
});
