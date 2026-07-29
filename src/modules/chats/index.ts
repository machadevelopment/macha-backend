import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { chats, chatMessages, companies, reportVersions } from '@/db/schema';
import { getOrCreateActiveSegment, buildChatHistory, maybeCloseSegment } from '@/lib/chat-segments';
import { runChatTurn } from '@/lib/chat-orchestrator';
import { checkTokenBucket } from '@/lib/rate-limit';

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

      const [chat] = await db
        .insert(chats)
        .values({
          companyId,
          userId,
          title: body?.title ?? 'Nuevo chat',
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
      const gate = await checkTokenBucket('ai', companyId);
      if (!gate.allowed) {
        set.status = 429;
        set.headers['Retry-After'] = String(gate.retryAfterSeconds);
        return { error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
      }

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
      await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, params.id));

      await maybeCloseSegment(db, companyId, params.id, segment.id);

      return { content: result.assistantText };
    },
    { body: t.Object({ content: t.String() }) },
  );
