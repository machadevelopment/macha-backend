import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { adminGuard } from '@/guards/admin.guard';
import { assertStaffCapability } from '@/guards/require-capability';
import { companies, companyUsers, users } from '@/db/schema';
import { logAdminAction } from '@/lib/admin-audit';
import { provisionTenantPartitions } from '@/lib/tenant-provisioning';
import { seedDefaultAlertRules } from '@/lib/alert-rules-seed';
import { grantInitialCredits } from '@/lib/credits';

/**
 * CU-868kfvaex/868kfvagj/868kfvaf5: namespace admin — companies + gestión de
 * usuarios. Demuestra el guard (staff/super_admin, separado de tenantDerive) y el
 * patrón de auditoría (toda mutación llama a logAdminAction).
 */
export const adminCompanies = new Elysia({ prefix: '/admin/companies' })
  .use(adminGuard)
  .get(
    '/',
    async ({ tier, query, set, db }) => {
      assertStaffCapability(tier, 'view_companies', set);
      // CU-868kh913c: sin límite esto crecía con el número de empresas cliente.
      // Mismo patrón "load more" (limit+1) que /admin/staging-rows y /admin/documents.
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
      const rows = await db
        .select({
          id: companies.id,
          name: companies.name,
          industry: companies.industry,
          baseCurrency: companies.baseCurrency,
          status: companies.status,
          createdAt: companies.createdAt,
        })
        .from(companies)
        .orderBy(desc(companies.createdAt))
        .limit(limit + 1)
        .offset(offset);
      return { companies: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  )
  .post(
    '/',
    async ({ staffId, tier, body, set, db }) => {
      // CU-868kfvaf5 criterio 1: alta manual de empresas + aprovisiona partición.
      assertStaffCapability(tier, 'manage_companies', set);

      // El id se genera aquí y las particiones se crean ANTES del INSERT. El orden es
      // obligatorio, no una preferencia: `provisionTenantPartitions` corre el DDL sobre
      // OTRA conexión (rol dueño), y `CREATE TABLE ... PARTITION OF transactions` hereda
      // la FK compuesta a `companies`, cuya validación pide un ShareRowExclusiveLock
      // sobre `companies`. Ese lock choca con el RowExclusiveLock que deja el INSERT de
      // la transacción del request —abierta desde `derive` y que no cierra hasta
      // `onAfterHandle`, o sea hasta DESPUÉS de este handler.
      //
      // Con el INSERT primero, el resultado era un abrazo mortal permanente: el DDL
      // espera al request, el request espera al DDL. Postgres no lo mata porque su
      // detector solo ve ciclos entre locks, y el request no está esperando un lock sino
      // al cliente (`idle in transaction`). Visto en producción: `POST /admin/companies`
      // colgado indefinidamente, `pg_blocking_pids` confirmando el ciclo.
      //
      // Coste de este orden: si algo falla después, quedan particiones vacías de una
      // empresa que no existe. Es intencional — una tabla vacía huérfana es basura
      // inocua y `CREATE TABLE IF NOT EXISTS` hace que el reintento sea idempotente,
      // mientras que colgar la petición deja el alta de empresas inutilizable.
      const companyId = randomUUID();
      const partitions = await provisionTenantPartitions(companyId);

      const [company] = await db
        .insert(companies)
        .values({
          id: companyId,
          workosOrgId: body.workosOrgId,
          name: body.name,
          industry: body.industry,
          baseCurrency: body.baseCurrency,
          locale: body.locale,
        })
        .returning();

      // CU-868kfvad3 catalog — fixed while building M8 self-serve registration: this
      // manual admin path never seeded it either, only scripts/seed.ts's demo company did.
      await seedDefaultAlertRules(db, company!.id);
      // CU-868kjc7g5 criterio 3: mismo saldo de arranque que el registro autoservicio.
      // El alta manual del admin es el otro camino por el que nace una empresa, y una
      // empresa sin créditos no puede pedir su primer insight.
      const { granted } = await grantInitialCredits(db, company!.id);

      await logAdminAction(db, {
        actorStaffId: staffId,
        companyId: company!.id,
        action: 'company.create',
        targetTable: 'companies',
        targetId: company!.id,
        metadata: { name: body.name, industry: body.industry, partitions, initialCredits: granted },
      });

      set.status = 201;
      return { id: company!.id, name: company!.name, partitions, initialCredits: granted };
    },
    {
      body: t.Object({
        workosOrgId: t.String(),
        name: t.String(),
        industry: t.String(),
        baseCurrency: t.Union([t.Literal('GTQ'), t.Literal('USD')]),
        locale: t.Union([t.Literal('es'), t.Literal('en')]),
      }),
    },
  )
  .patch(
    '/:id/status',
    async ({ staffId, tier, params, body, set, db }) => {
      assertStaffCapability(tier, 'manage_companies', set);
      const [before] = await db.select().from(companies).where(eq(companies.id, params.id));
      if (!before) {
        set.status = 404;
        return { error: 'Company not found' };
      }

      await db.update(companies).set({ status: body.status }).where(eq(companies.id, params.id));

      await logAdminAction(db, {
        actorStaffId: staffId,
        companyId: params.id,
        action: 'company.status_change',
        targetTable: 'companies',
        targetId: params.id,
        metadata: { before: before.status, after: body.status },
      });

      return { id: params.id, status: body.status };
    },
    { body: t.Object({ status: t.Union([t.Literal('active'), t.Literal('suspended')]) }) },
  )
  /**
   * CU-868khvzqn criterio 2: `/admin/companies/<id>` en el frontend titulaba
   * "EMPRESA / Detalle" y no había forma de saber en cuál estabas — desde esa pantalla
   * se cambian roles de usuarios y umbrales de alerta. No existía endpoint de detalle:
   * el listado `GET /admin/companies` está paginado, así que el cliente no puede
   * resolver un id arbitrario sin barrer páginas.
   *
   * Devuelve exactamente los campos que la pantalla necesita para dar contexto (nombre,
   * industria, moneda base, estado) más `locale`, que es lo que decide el idioma de los
   * emails de esa empresa. `workosOrgId` no se expone: es un identificador del IdP y
   * ninguna pantalla lo usa.
   */
  .get('/:id', async ({ tier, params, set, db }) => {
    assertStaffCapability(tier, 'view_companies', set);
    const [company] = await db
      .select({
        id: companies.id,
        name: companies.name,
        industry: companies.industry,
        baseCurrency: companies.baseCurrency,
        status: companies.status,
        locale: companies.locale,
        createdAt: companies.createdAt,
      })
      .from(companies)
      .where(eq(companies.id, params.id));

    if (!company) {
      set.status = 404;
      return { error: 'Company not found' };
    }
    return company;
  })
  .get('/:id/users', async ({ tier, params, set, db }) => {
    assertStaffCapability(tier, 'view_companies', set);
    return db
      .select({
        userId: companyUsers.userId,
        email: users.email,
        name: users.name,
        role: companyUsers.role,
        status: companyUsers.status,
        receivesReports: companyUsers.receivesReports,
      })
      .from(companyUsers)
      .innerJoin(users, eq(users.id, companyUsers.userId))
      .where(eq(companyUsers.companyId, params.id));
  })
  .patch(
    '/:id/users/:userId',
    async ({ staffId, tier, params, body, set, db }) => {
      // Gestión de miembros existentes (rol/estado). Invitar a un usuario que nunca
      // ha iniciado sesión vía WorkOS (sin fila en `users` todavía) necesitaría el
      // flujo de invite de WorkOS + email — no construido, mismo alcance que el
      // registro autoservicio de M8.
      assertStaffCapability(tier, 'manage_companies', set);
      const [before] = await db
        .select()
        .from(companyUsers)
        .where(and(eq(companyUsers.companyId, params.id), eq(companyUsers.userId, params.userId)));
      if (!before) {
        set.status = 404;
        return { error: 'Membership not found' };
      }

      await db
        .update(companyUsers)
        .set({ role: body.role ?? before.role, status: body.status ?? before.status })
        .where(and(eq(companyUsers.companyId, params.id), eq(companyUsers.userId, params.userId)));

      await logAdminAction(db, {
        actorStaffId: staffId,
        companyId: params.id,
        action: 'company_user.update',
        targetTable: 'company_users',
        targetId: params.userId,
        metadata: { before, after: body },
      });

      return { userId: params.userId, ...body };
    },
    {
      body: t.Object({
        role: t.Optional(t.Union([t.Literal('owner'), t.Literal('admin'), t.Literal('member')])),
        status: t.Optional(
          t.Union([t.Literal('active'), t.Literal('invited'), t.Literal('revoked')]),
        ),
      }),
    },
  );
