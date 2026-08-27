import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { chats, chatMessages, companies, reportVersions } from '@/db/schema';
import { getOrCreateActiveSegment, buildChatHistory, maybeCloseSegment } from '@/lib/chat-segments';
import { runChatTurn } from '@/lib/chat-orchestrator';
import { localeDeContenido } from '@/lib/content-locale';
import { enforceTokenBucket } from '@/lib/rate-limit';
import {
  getActiveCreditRule,
  estimateRequiredCredits,
  debitCredits,
  getCreditBalance,
} from '@/lib/credits';
import { esTituloPorDefecto, tituloDesdePrimerMensaje, tituloPorDefecto } from '@/lib/chat-title';

/**
 * CU-868kfvabw/868kfvabq: hilos nombrados por (company_id, user_id) + orquestación
 * tool-use. Un usuario solo ve sus propios hilos dentro de su empresa (data model.md
 * §4.16) — cada query abajo filtra también por userId, no solo companyId.
 */
export const chats_ = new Elysia({ prefix: '/chats' })
  .use(tenantDerive)
  .get('/', async ({ companyId, userId, role, set, db }) => {
    assertClientCapability(role, 'chat', set);
    return db
      .select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt })
      .from(chats)
      .where(and(eq(chats.companyId, companyId), eq(chats.userId, userId)))
      .orderBy(desc(chats.updatedAt));
  })
  .post(
    '/',
    async ({ companyId, userId, role, body, set, db, headers }) => {
      assertClientCapability(role, 'chat', set);
      // CU-868kfvacr criterio 3 (deep-link a chat): reportVersionId opcional origina
      // el hilo desde un reporte específico (chats.report_version_id, US-14).
      //
      // CU-868kh8uau: se valida contra `report_versions` de ESTA empresa antes de
      // insertar. El frontend mandaba un `reports.id` en este campo y, sin FK, la
      // referencia falsa se persistía en silencio. La FK compuesta que ahora existe
      // (migración 0011) lo haría fallar de todas formas, pero con un error de
      // constraint opaco: este chequeo devuelve un 400 que dice qué pasó, y de paso
      // impide referenciar la versión de otra empresa.
      if (body?.reportVersionId) {
        const [version] = await db
          .select({ id: reportVersions.id })
          .from(reportVersions)
          .where(
            and(
              eq(reportVersions.id, body.reportVersionId),
              eq(reportVersions.companyId, companyId),
            ),
          );
        if (!version) {
          set.status = 400;
          return { error: 'reportVersionId does not reference a report version of this company' };
        }
      }

      // CU-868krkw4p: el marcador nace en un idioma, no quemado en español — el `title` se
      // guarda en base y no se traduce al pintarlo, así que elegir mal acá es permanente.
      // CU-868krvuct: ese idioma pasa a ser el del USUARIO y no el de la empresa. El chat
      // es suyo y aparece en su lista; dos socios que leen en idiomas distintos deben ver
      // cada uno su marcador.
      const locale = await localeDeContenido(db, companyId, userId, headers['x-content-locale']);

      const [chat] = await db
        .insert(chats)
        .values({
          companyId,
          userId,
          title: body?.title ?? tituloPorDefecto(locale),
          reportVersionId: body?.reportVersionId,
        })
        .returning();
      await getOrCreateActiveSegment(db, companyId, chat!.id);
      set.status = 201;
      return { id: chat!.id, title: chat!.title };
    },
    {
      body: t.Optional(
        t.Object({ title: t.Optional(t.String()), reportVersionId: t.Optional(t.String()) }),
      ),
    },
  )
  .get('/:id/messages', async ({ companyId, userId, role, params, set, db }) => {
    assertClientCapability(role, 'chat', set);
    const [chat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(
        and(eq(chats.id, params.id), eq(chats.companyId, companyId), eq(chats.userId, userId)),
      );
    if (!chat) {
      set.status = 404;
      return { error: 'Chat not found' };
    }
    return db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(and(eq(chatMessages.chatId, params.id), eq(chatMessages.companyId, companyId)))
      .orderBy(chatMessages.createdAt);
  })
  .post(
    '/:id/messages',
    async ({ companyId, userId, role, params, body, set, db, request, headers }) => {
      assertClientCapability(role, 'chat', set);

      // CU-868kfvaah: 'ai' token-bucket (chat/insight) — se descubrió en una auditoría
      // de Calidad que checkTokenBucket() existía desde CU-868kfv97f pero ninguna ruta
      // lo consumía todavía (el comentario original de rate-limit.ts lo decía
      // explícito). 429 + Retry-After es la respuesta acordada con Jose.
      // CU-868kh92fz: el rechazo ahora se reporta a Sentry dentro de enforceTokenBucket.
      const limited = await enforceTokenBucket('ai', companyId, set, 'POST /chats/:id/messages');
      if (limited) return limited;

      const [chat] = await db
        .select({ id: chats.id, title: chats.title })
        .from(chats)
        .where(
          and(eq(chats.id, params.id), eq(chats.companyId, companyId), eq(chats.userId, userId)),
        );
      if (!chat) {
        set.status = 404;
        return { error: 'Chat not found' };
      }

      /*
       * ═══════════════════════════════════════════════════════════════════════════════════
       * SIN CRÉDITOS NO SE MANDA EL PROMPT — CU-868kxjucv
       * ═══════════════════════════════════════════════════════════════════════════════════
       *
       * El débito por prompt se conectó en CU-868kx4gzx (antes: 73 mensajes, cero débitos).
       * Esto es la otra mitad: hasta ahora el chat **cobraba pero no bloqueaba**, así que una
       * empresa sin saldo podía seguir usando el asesor indefinidamente y su balance se iba a
       * negativo. No es hipotético — la ingesta ya dejó empresas en −1.675 créditos por el
       * mismo tipo de hueco.
       *
       * ═══ SE COMPRUEBA ANTES DE LLAMAR AL MODELO, Y ESO ES LO IMPORTANTE ═══
       *
       * Va acá arriba y no junto al débito del final. La diferencia es lo que le pasa al
       * usuario: comprobando antes, su mensaje **no se manda, no se guarda y no se gasta un
       * token** — el compositor conserva lo que escribió y puede comprar créditos y darle
       * enviar otra vez. Comprobando después, ya se llamó a Claude (gastando dinero real que
       * no se puede cobrar), la conversación quedó a medias en la base, y el error llega
       * cuando ya no hay nada que hacer con él.
       *
       * ═══ MISMA FORMA DE RESPUESTA QUE `/insights` ═══
       *
       * `402` con `{ error: 'insufficient_credits', required, balance }`. No es estética: el
       * frontend YA sabe clasificar exactamente ese cuerpo y pintar el enlace a comprar
       * créditos (`classify()` en `insight-panel.tsx`), así que reusar la forma es lo que hace
       * que el chat herede ese mensaje en vez de caer en un "algo salió mal" genérico.
       *
       * ⚠️ ESTO CORTA UNA CONVERSACIÓN EN CURSO, y es la parte que hay que mirar de frente:
       * el Consejo Diario es un botón —se niega y ya— pero un hilo de chat es algo que la
       * persona está usando. Lo que hace tolerable el corte es que sea ANTES de mandar: el
       * mensaje sigue escrito, el historial queda intacto, y lo que falta es explícito y
       * comprable. Si aun así se decide que el chat nunca debe cortarse, quitar este bloque
       * devuelve el comportamiento anterior sin tocar el débito.
       */
      const reglaDelPrompt = await getActiveCreditRule(db, 'chat');
      if (reglaDelPrompt) {
        const necesarios = estimateRequiredCredits(reglaDelPrompt, 1);
        const saldo = await getCreditBalance(db, companyId);
        if (saldo < necesarios) {
          set.status = 402;
          return { error: 'insufficient_credits', required: necesarios, balance: saldo };
        }
      }

      // CU-868krvuct: el idioma de la RESPUESTA es el de quien pregunta, no el que la
      // empresa eligió el día del registro. Ver `lib/content-locale.ts`.
      const locale = await localeDeContenido(db, companyId, userId, headers['x-content-locale']);

      const segment = await getOrCreateActiveSegment(db, companyId, params.id);
      const history = await buildChatHistory(db, params.id, segment.id);

      // CU-868kt984z: el asesor tenía el mismo hueco que el reporte — el único nombre
      // propio de su prompt era "Macha Finance", así que al hablar del negocio del
      // usuario lo llamaba así. Una consulta de una columna, en el mismo turno.
      const [company] = await db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId));

      /*
       * ═══ CANCELAR DE VERDAD (CU-868ktvqjm) ═══
       *
       * `request.signal` se aborta cuando el cliente corta la conexión. Pasarla hasta la
       * llamada a Claude es lo que convierte "dejar de esperar" en "cancelar": antes el
       * turno corría entero pasara lo que pasara del lado del usuario, así que apretar el
       * botón soltaba la pantalla pero los tokens se gastaban igual.
       */
      let result: Awaited<ReturnType<typeof runChatTurn>>;
      try {
        result = await runChatTurn({
          db,
          companyId,
          locale,
          history,
          userMessage: body.content,
          companyName: company?.name,
          signal: request.signal,
        });
      } catch (e) {
        if (!request.signal.aborted) throw e;

        /*
         * ═══ QUÉ SE GUARDA DE UN TURNO CANCELADO ═══
         *
         * LA PREGUNTA SÍ. El usuario la escribió y la mandó; perderla porque decidió no
         * esperar la respuesta sería castigar una decisión razonable, y al recargar el
         * hilo vería que su mensaje se evaporó. Se guarda sola, sin respuesta: el hilo
         * queda con una pregunta sin contestar, que es exactamente lo que pasó.
         *
         * LA RESPUESTA NO. Lo que hubiera llegado está cortado a mitad de frase, y una
         * narrativa truncada ya se trató como fallo y no como contenido en CU-868krw2wn —
         * ahí porque quedaba inmutable en `report_versions`, acá porque además volvería al
         * historial y contaminaría el turno siguiente (CU-868krw2gx).
         *
         * LO QUE NO SE PUEDE SABER: los tokens de la llamada que se abortó. La API no
         * devuelve `usage` de una petición que nunca terminó, y `ai_usage_events` no admite
         * cifras inventadas — es el ledger con el que se calcula el costo real. Las rondas
         * que SÍ completaron antes de la cancelación ya insertaron su fila dentro de
         * `runChatTurn`, así que lo que se pierde es a lo sumo una ronda, no el turno.
         */
        await db.insert(chatMessages).values({
          companyId,
          chatId: params.id,
          segmentId: segment.id,
          role: 'user',
          content: body.content,
        });
        // 499 (Client Closed Request): nadie lo va a leer —el cliente ya se fue— pero deja
        // el hecho en los logs de acceso separado de un 500, que sí sería un fallo nuestro.
        set.status = 499;
        return { error: 'cancelled' };
      }

      await db.insert(chatMessages).values({
        companyId,
        chatId: params.id,
        segmentId: segment.id,
        role: 'user',
        content: body.content,
      });
      await db.insert(chatMessages).values({
        companyId,
        chatId: params.id,
        segmentId: segment.id,
        role: 'assistant',
        content: result.assistantText,
      });

      /*
       * ═══════════════════════════════════════════════════════════════════════════════════
       * UN PROMPT CUESTA UN CRÉDITO — CU-868kx4gzx (Jose, 2026-08-26)
       * ═══════════════════════════════════════════════════════════════════════════════════
       *
       * *"1 carga de Excel = 25 créditos, 1 prompt = 1 crédito, 1 reporte = 10 créditos."*
       *
       * Las tres reglas ya estaban cargadas y activas en producción desde el 21/08 —cinco días
       * ANTES del pedido— con esos valores exactos. Lo que faltaba no era configurarlas: era
       * que alguien consumiera la del chat. **Medido: 73 mensajes al asesor desde que la regla
       * existe y CERO débitos.** Excel (237 × 25), reportes (13 × 10) e insights (12 × 1) sí
       * cobraban; el chat era el único con la regla puesta y nadie que la leyera.
       *
       * ═══ UNA VEZ POR PROMPT, NO POR LLAMADA AL MODELO ═══
       *
       * Va acá y no dentro de `runChatTurn`, y esa es la decisión que importa. Un turno con
       * uso de herramientas hace VARIAS llamadas a Claude —`runChatTurn` lleva su `callCount`—
       * y cada una inserta su fila en `ai_usage_events`, que es correcto porque ese ledger mide
       * el costo con el proveedor. Los créditos miden otra cosa: lo que el cliente pidió. Jose
       * dijo "1 prompt", y un prompt es un mensaje del usuario, sin importar cuántas vueltas
       * dé el modelo para contestarlo. Debitar por llamada haría que la misma pregunta costara
       * distinto según si el asesor necesitó consultar los datos.
       *
       * ═══ SOLO SI EL TURNO TERMINÓ ═══
       *
       * El camino de cancelación retorna arriba (499), así que no llega acá. Es deliberado: el
       * usuario que corta no recibió respuesta, y cobrarle sería cobrar por nada. Es la
       * diferencia con la ingesta, donde el lote resuelto en código SÍ debita porque el trabajo
       * se hizo y el cliente lo recibió.
       *
       * ⚠️ NO BLOQUEA POR SALDO, a diferencia de `/insights`. Eso es una decisión de producto
       * que este ticket no pide y que tiene consecuencias: cortar el chat a mitad de una
       * conversación por saldo es un corte distinto —y más brusco— que negar la generación de
       * un consejo. Queda anotado como pendiente, no como olvido.
       *
       * Un fallo al debitar NO tumba la respuesta: el usuario ya la tiene en pantalla y la
       * conversación ya está guardada. Mismo criterio que el diccionario de categorías de la
       * ingesta — lo que se pierde es el cobro, no el trabajo.
       */
      const reglaDeChat = await getActiveCreditRule(db, 'chat');
      if (reglaDeChat) {
        try {
          await debitCredits(db, {
            companyId,
            actionKind: 'chat',
            credits: estimateRequiredCredits(reglaDeChat, 1),
            creditRuleId: reglaDeChat.id,
            // El HILO, no el mensaje: es el objeto que el resto del producto identifica como
            // "esta conversación", y `debitCredits` documenta `chat_id` para este `action_kind`.
            refId: params.id,
          });
        } catch (err) {
          console.error('[chat] no se pudo debitar el crédito del prompt:', err);
        }
      }
      /*
       * CU-868krkw4p — LA CONVERSACIÓN SE NOMBRA SOLA CON LA PRIMERA PREGUNTA.
       *
       * Macha reportó una lista donde todos los hilos se llamaban "Nuevo chat", que es lo
       * mismo que no tener lista: no hay forma de volver a una conversación anterior si
       * todas se ven igual.
       *
       * DOS CONDICIONES, Y LAS DOS HACEN FALTA:
       *
       *   · `esTituloPorDefecto` — un título que el usuario puso a mano (o el que vino en el
       *     `POST /chats` al abrir un hilo desde un reporte) NO se pisa. Es suyo.
       *   · que el título derivado no sea null — un primer mensaje que es solo un emoji o
       *     puro espacio daría un título peor que el marcador, o vacío.
       *
       * VA EN EL MISMO `update` QUE `updatedAt`, no en uno aparte: son el mismo hecho (este
       * chat acaba de tener actividad) y separarlos abriría una ventana donde la lista se
       * reordena por fecha y todavía muestra el nombre viejo.
       *
       * Se decide contra el título que se leyó ANTES de escribir los mensajes, así que el
       * mensaje de este turno es el primero por construcción: si hubiera habido otro antes,
       * ese turno ya habría cambiado el título y `esTituloPorDefecto` sería falso.
       */
      const tituloNuevo = esTituloPorDefecto(chat.title)
        ? tituloDesdePrimerMensaje(body.content)
        : null;

      await db
        .update(chats)
        .set({ updatedAt: new Date(), ...(tituloNuevo ? { title: tituloNuevo } : {}) })
        .where(eq(chats.id, params.id));

      await maybeCloseSegment(db, companyId, params.id, segment.id);

      // Se devuelve el título EFECTIVO (el nuevo si se acaba de derivar, el de siempre si
      // no) y no solo cuando cambia: así el cliente sincroniza su lista con una asignación
      // incondicional en vez de con un `if`, y no necesita una segunda petición para
      // enterarse de que el hilo ya se llama distinto.
      return { content: result.assistantText, title: tituloNuevo ?? chat.title };
    },
    { body: t.Object({ content: t.String() }) },
  );
