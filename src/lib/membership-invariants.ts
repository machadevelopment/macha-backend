import { and, eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { companyUsers } from '@/db/schema';

/**
 * CU-868kjc8pj: una empresa nunca se queda sin owner activo.
 *
 * Regla del PRD §8 ("debe existir al menos un `owner`"), que estaba escrita pero no
 * aplicada: `PATCH /admin/companies/:id/users/:userId` escribía rol y estado directo, y
 * nada impedía degradar a `member` —o revocar— al ÚNICO owner. Un clic accidental en el
 * backoffice dejaba a la empresa sin nadie que pudiera gestionar facturación, transferir
 * la propiedad ni administrar el equipo; y como el cliente todavía no tiene endpoints de
 * gestión de miembros (CU-868kh8pwv), sin ninguna vía de recuperación desde la app.
 *
 * Vive aquí y no dentro del handler a propósito (criterio 2): los endpoints de cliente
 * de CU-868kh8pwv tienen que usar ESTA función, no una copia de la regla.
 *
 * La transferencia de propiedad sigue siendo explícita (criterio 3): promover al nuevo
 * owner y después degradar al anterior. Esta función no la implementa, solo impide que
 * ocurra por accidente como efecto colateral de editar un rol.
 */

/** Un miembro cuenta como owner solo si además está activo. */
const esOwnerActivo = (m: { role: string; status: string }) =>
  m.role === 'owner' && m.status === 'active';

export interface CambioDeMembresia {
  companyId: string;
  userId: string;
  /** Rol resultante. Si no cambia, pasar el actual. */
  nextRole: string;
  /** Estado resultante. Si no cambia, pasar el actual. */
  nextStatus: string;
}

/**
 * ¿Este cambio dejaría a la empresa con CERO owners activos?
 *
 * Bloquea las filas de la empresa con `FOR UPDATE`. Sin eso hay una carrera real: dos
 * peticiones degradando a dos owners distintos pasan ambas la comprobación y la empresa
 * acaba en cero. El guard de admin ya abre una transacción por request y la cierra en
 * `onAfterHandle` (guards/admin.guard.ts → reserveScopedConnection), así que el lock vive
 * exactamente lo que dura la petición y se libera con el commit.
 */
export async function dejariaSinOwner(db: DB, cambio: CambioDeMembresia): Promise<boolean> {
  const miembros = await db
    .select({
      userId: companyUsers.userId,
      role: companyUsers.role,
      status: companyUsers.status,
    })
    .from(companyUsers)
    .where(eq(companyUsers.companyId, cambio.companyId))
    .for('update');

  const quedan = miembros.filter((m) =>
    m.userId === cambio.userId
      ? esOwnerActivo({ role: cambio.nextRole, status: cambio.nextStatus })
      : esOwnerActivo(m),
  );

  // Solo bloquea si ANTES había alguno: una empresa que ya estaba en cero owners (dato
  // heredado) no debe quedar imposible de arreglar por esta misma validación.
  const habiaAlguno = miembros.some(esOwnerActivo);
  return habiaAlguno && quedan.length === 0;
}

/** Igual que arriba pero sin lock — para lecturas informativas, nunca antes de escribir. */
export async function contarOwnersActivos(db: DB, companyId: string): Promise<number> {
  const miembros = await db
    .select({ role: companyUsers.role, status: companyUsers.status })
    .from(companyUsers)
    .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.role, 'owner')));
  return miembros.filter(esOwnerActivo).length;
}

export const MENSAJE_SIN_OWNER =
  'La empresa quedaría sin ningún owner activo. Promueve antes a otro miembro a owner y después cambia este.';
