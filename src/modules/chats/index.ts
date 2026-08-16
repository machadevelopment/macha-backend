import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { chats, chatMessages, companies, reportVersions } from '@/db/schema';
import { getOrCreateActiveSegment, buildChatHistory, maybeCloseSegment } from '@/lib/chat-segments';
import { runChatTurn } from '@/lib/chat-orchestrator';
import { enforceTokenBucket } from '@/lib/rate-limit';
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
    async ({ companyId, userId, role, body, set, db }) => {
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

      // CU-868krkw4p: el marcador nace en el idioma de la EMPRESA. Estaba quemado en
      // español, así que una empresa con `locale='en'` veía "Nuevo chat" en su lista —
      // y el `title` se guarda en base, no se traduce al pintarlo.
      const [company] = await db
        .select({ locale: companies.locale })
        .from(companies)
        .where(eq(companies.id, companyId));

      const [chat] = await db
        .insert(chats)
        .values({
          companyId,
          userId,
          title: body?.title ?? tituloPorDefecto(company?.locale ?? 'es'),
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
    async ({ companyId, userId, role, params, body, set, db }) => {
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

      const [company] = await db
        .select({ locale: companies.locale })
        .from(companies)
        .where(eq(companies.id, companyId));
      const locale = company?.locale ?? 'es';

      const segment = await getOrCreateActiveSegment(db, companyId, params.id);
      const history = await buildChatHistory(db, params.id, segment.id);

      const result = await runChatTurn({
        db,
        companyId,
        locale,
        history,
        userMessage: body.content,
      });

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
