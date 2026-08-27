import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PROMPT DEL ASESOR CUESTA UN CRÉDITO — CU-868kx4gzx (Jose, 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"1 carga de Excel = 25 créditos, 1 prompt = 1 crédito, 1 reporte = 10 créditos."*
 *
 * El ticket lo trataba como configuración: cargar tres valores en el panel de admin. **Ya
 * estaban cargados**, activos y con esos valores exactos, desde el 21/08 — cinco días antes del
 * pedido. Lo que faltaba era que alguien los consumiera.
 *
 * Medido en producción, desde que las reglas existen:
 *
 *     excel              237 débitos × 25   ✔
 *     report_generation   13 débitos × 10   ✔
 *     insight             12 débitos ×  1   ✔
 *     chat                 0 débitos        ✘   ← 73 mensajes al asesor
 *
 * El chat era el único con la regla puesta y nadie que la leyera: registraba
 * `ai_usage_events` (el costo con el proveedor) y nunca `credit_transactions` (lo que se le
 * cobra al cliente).
 */
const chats = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');

describe('el chat debita el crédito del prompt', () => {
  test('llama a `debitCredits` con `action_kind` de chat', () => {
    expect(chats).toContain("getActiveCreditRule(db, 'chat')");
    expect(chats).toContain("actionKind: 'chat'");
  });

  /*
   * El valor sale de la REGLA, no de un número escrito acá. Si mañana Jose cambia el precio en
   * el panel, tiene que aplicar sin desplegar — que es el criterio con el que se construyó esa
   * pantalla, y el que este ticket pide confirmar.
   */
  test('el monto sale de la regla del panel, no de una constante', () => {
    expect(chats).toContain('estimateRequiredCredits(reglaDeChat, 1)');
    expect(chats).not.toMatch(/credits:\s*1\b/);
  });

  /*
   * EL `1` DE `estimateRequiredCredits(regla, 1)` ES UNA UNIDAD, NO UN CRÉDITO. Con una regla
   * `fixed` devuelve `creditsPerUnit` sin mirar las unidades, así que el precio lo pone el
   * panel. Este test existe para que quede dicho: alguien podría leer ese `1` como "un crédito"
   * y "corregirlo" al cambiar el precio.
   */
  test('debita UNA vez por prompt, no una por llamada al modelo', () => {
    /*
     * Un turno con uso de herramientas hace varias llamadas a Claude y cada una inserta su fila
     * en `ai_usage_events`. Los créditos miden otra cosa: lo que el cliente pidió. Debitar
     * dentro de `runChatTurn` haría que la misma pregunta costara distinto según si el asesor
     * necesitó consultar los datos.
     */
    const orquestador = readFileSync(
      join(import.meta.dir, '..', '..', 'lib', 'chat-orchestrator.ts'),
      'utf8',
    );
    expect(orquestador).not.toContain('debitCredits');
  });

  test('no debita un turno cancelado', () => {
    /*
     * El camino de cancelación retorna 499 ANTES del débito. El usuario que corta no recibió
     * respuesta, y cobrarle sería cobrar por nada. Se comprueba por posición porque es lo que
     * de verdad lo garantiza: el orden de las dos cosas en el archivo.
     */
    const cancelacion = chats.indexOf("return { error: 'cancelled' };");
    const debito = chats.indexOf('await debitCredits(db, {');
    expect(cancelacion).toBeGreaterThan(-1);
    expect(debito).toBeGreaterThan(cancelacion);
  });

  test('un fallo al debitar no tumba la respuesta ya entregada', () => {
    /*
     * La conversación ya está guardada y el usuario ya la tiene en pantalla. Lo que se pierde
     * es el cobro, no el trabajo — mismo criterio que el diccionario de categorías de la
     * ingesta.
     */
    const bloque = chats.slice(debitoDesde(chats), debitoDesde(chats) + 600);
    expect(bloque).toContain('catch');
  });
});

function debitoDesde(fuente: string): number {
  return fuente.indexOf('const reglaDeChat');
}

describe('sin créditos, el prompt no se manda', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * CU-868kxjucv — la otra mitad del débito
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Conectar el débito (CU-868kx4gzx) dejó al chat **cobrando sin bloquear**: una empresa sin
   * saldo podía seguir usando el asesor indefinidamente y su balance se iba a negativo. No es
   * hipotético — la ingesta ya dejó empresas en −1.675 créditos por el mismo tipo de hueco.
   */
  test('comprueba el saldo ANTES de llamar al modelo, no después', () => {
    /*
     * EL ORDEN ES LA DECISIÓN. Comprobando antes, el mensaje no se manda, no se guarda y no
     * gasta un token: el compositor conserva lo que el usuario escribió. Comprobando después ya
     * se le pagó a Anthropic por algo que no se puede cobrar, la conversación quedó a medias en
     * la base, y el error llega cuando ya no hay nada que hacer con él.
     *
     * Se verifica por POSICIÓN porque es lo único que lo garantiza de verdad.
     */
    const bloqueo = chats.indexOf("return { error: 'insufficient_credits'");
    const llamada = chats.indexOf('runChatTurn({');
    expect(bloqueo).toBeGreaterThan(-1);
    expect(bloqueo).toBeLessThan(llamada);
  });

  test('responde 402 con la MISMA forma que /insights', () => {
    /*
     * No es estética: `classify()` del panel del Consejo Diario ya sabe leer exactamente ese
     * cuerpo, así que reusar la forma es lo que hace que el chat herede el mensaje de "faltan
     * créditos" con su enlace a comprar, en vez de caer en un error genérico de red.
     */
    expect(chats).toContain('set.status = 402');
    expect(chats).toMatch(/error: 'insufficient_credits', required: \w+, balance: \w+/);
  });

  test('el umbral sale de la regla del panel, no de un número', () => {
    // Si mañana el prompt cuesta 5 créditos, el bloqueo tiene que moverse solo.
    const bloque = chats.slice(
      chats.indexOf('const reglaDelPrompt'),
      chats.indexOf('runChatTurn({'),
    );
    expect(bloque).toContain('estimateRequiredCredits(reglaDelPrompt, 1)');
    expect(bloque).toContain('getCreditBalance(db, companyId)');
  });

  /*
   * Sin regla configurada NO se bloquea. Es coherente con el débito —que tampoco cobra sin
   * regla— y evita el peor estado posible: que borrar una fila del panel de admin deje a todos
   * los clientes sin asesor.
   */
  test('sin regla de crédito configurada no bloquea a nadie', () => {
    expect(chats).toContain('if (reglaDelPrompt) {');
  });
});
