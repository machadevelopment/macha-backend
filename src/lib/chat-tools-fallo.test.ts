import { describe, expect, test } from 'bun:test';
import { executeChatTool, type ChatToolContext } from '@/lib/chat-tools';

/**
 * CU-868krw2gx, segunda causa: una herramienta que falla no puede tumbar el turno.
 *
 * El `input` de una herramienta lo escribe el MODELO, no un esquema de TypeBox. Puede
 * mandar `dateFrom: "el mes pasado"`, un `limit` disparatado o una categoría inexistente.
 * Cuando eso hacía lanzar a la consulta, la excepción subía por `runChatTurn`, salía del
 * endpoint como 500 y se perdía el turno completo — ni siquiera se guardaba la pregunta del
 * usuario. Una fecha mal escrita por el modelo borraba la conversación.
 *
 * El `db` de abajo lanza en cuanto lo tocan. Sirve para las tres herramientas por igual:
 * todas empiezan consultando, así que reproduce cualquier fallo de base sin tener que
 * fabricar un argumento inválido distinto para cada una.
 */
const dbQueLanza = {
  select() {
    throw new Error('relation "transactions" does not exist');
  },
} as unknown as ChatToolContext['db'];

const ctx: ChatToolContext = { db: dbQueLanza, companyId: 'c1' };

describe('executeChatTool cuando la herramienta falla', () => {
  /*
   * El `input` de cada una es el mínimo VÁLIDO, no `{}`. Con `{}`, `get_monthly_rollup`
   * calcula `Math.max(undefined, 1) → NaN`, no arma ningún período y devuelve `[]` sin
   * llegar a consultar: el test pasaría sin ejercer nada. Los argumentos de abajo hacen que
   * las tres lleguen de verdad a la base, que es donde está el fallo que se quiere probar.
   */
  const herramientas: Array<[string, unknown]> = [
    ['get_latest_report_narrative', {}],
    ['get_monthly_rollup', { months: 3 }],
    ['query_transactions', { limit: 10 }],
  ];

  for (const [nombre, input] of herramientas) {
    test(`"${nombre}" devuelve el fallo en vez de lanzarlo`, async () => {
      const resultado = await executeChatTool(ctx, nombre, input);

      expect(resultado).toContain('ERROR');
      expect(resultado).toContain(nombre);
    });
  }

  test('el detalle técnico NO viaja al modelo', async () => {
    /*
     * Esto no es prolijidad: el resultado de la herramienta entra en una conversación que
     * el usuario ve, y el `message` de una excepción de Postgres trae el SQL y los nombres
     * de las columnas. Se manda el nombre de la herramienta y nada más; el detalle queda
     * en el log del servidor, que es donde sirve.
     */
    const resultado = await executeChatTool(ctx, 'query_transactions', { limit: 10 });

    expect(resultado).not.toContain('relation');
    expect(resultado).not.toContain('transactions" does not exist');
  });

  test('una herramienta desconocida sigue respondiendo, no lanza', async () => {
    const resultado = await executeChatTool(ctx, 'inventada', {});
    expect(resultado).toContain('Unknown tool');
  });
});
