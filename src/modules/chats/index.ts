import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { chats, chatMessages, companies } from '@/db/schema';
import { getOrCreateActiveSegment, buildChatHistory, maybeCloseSegment } from '@/lib/chat-segments';
import { runChatTurn } from '@/lib/chat-orchestrator';

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
      const [chat] = await db
        .insert(chats)
        .values({ companyId, userId, title: body?.title ?? 'Nuevo chat' })
        .returning();
      await getOrCreateActiveSegment(db, companyId, chat!.id);
      set.status = 201;
      return { id: chat!.id, title: chat!.title };
    },
    { body: t.Optional(t.Object({ title: t.Optional(t.String()) })) },
  )
  .get('/:id/messages', async ({ companyId, userId, role, params, set, db }) => {
    assertClientCapability(role, 'chat', set);
    const [chat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.id, params.id), eq(chats.companyId, companyId), eq(chats.userId, userId)));
    if (!chat) {
      set.status = 404;
      return { error: 'Chat not found' };
    }
    return db
      .select({ role: chatMessages.role, content: chatMessages.content, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(eq(chatMessages.chatId, params.id), eq(chatMessages.companyId, companyId)))
      .orderBy(chatMessages.createdAt);
  })
  .post(
    '/:id/messages',
    async ({ companyId, userId, role, params, body, set, db }) => {
      assertClientCapability(role, 'chat', set);
      const [chat] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, params.id), eq(chats.companyId, companyId), eq(chats.userId, userId)));
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

      const result = await runChatTurn({ db, companyId, locale, history, userMessage: body.content });

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
