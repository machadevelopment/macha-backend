import { eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { companies, users } from '@/db/schema';

/**
 * En qué idioma se ESCRIBE el contenido que genera la IA para una persona concreta.
 *
 * ═══ EL BUG (CU-868krvuct) ═══
 *
 * Macha generó un reporte con la plataforma en español y salió en inglés.
 *
 * El prompt sí llevaba el idioma — `report-prompt.ts` tiene las directivas en los dos y
 * `chat-orchestrator.ts` tiene su `languageLine`. Eso estaba bien desde siempre. Lo que
 * estaba mal es de dónde salía el valor, y son dos fallas encadenadas:
 *
 *   1. **El selector de idioma del producto no llegaba al servidor.** Es una cookie del
 *      navegador y nada más (`app/actions/set-locale.ts` en el frontend). Cambia lo que la
 *      interfaz muestra; el backend nunca se entera.
 *   2. **El contenido se escribía en `companies.locale`**, que se fija UNA vez en el
 *      registro y no se puede editar desde ninguna pantalla — la de Ajustes de empresa es
 *      CU-868kj3gm0, que está bloqueada esperando una decisión.
 *
 * Juntas: el idioma del contenido quedaba clavado en lo que alguien eligió el día que
 * registró la empresa, sin forma de cambiarlo y sin relación con lo que el usuario ve.
 *
 * ═══ LA REGLA ═══
 *
 * **El contenido se escribe en el idioma de quien lo pidió.** Un reporte a demanda y una
 * respuesta del chat los pide una persona identificada, y esa persona es quien los va a
 * leer; su preferencia es el dato correcto, no la de la empresa.
 *
 * `users.locale` ya existía y ya se escribía en el registro; lo que faltaba era que el
 * selector lo actualizara (`PUT /me/locale`). Se resuelve en el SERVIDOR a partir del
 * `userId` del JWT verificado, y no se acepta como parámetro del cuerpo: no es un dato de
 * seguridad —el peor caso de mentir sería recibir tu propio reporte en el otro idioma—
 * pero leerlo de la base es lo que hace que la preferencia sea la misma en las tres
 * superficies (reporte, chat, correo) sin que cada una tenga que acordarse de mandarla.
 *
 * ═══ CUÁNDO SE USA EL DE LA EMPRESA ═══
 *
 * Cuando NO hay solicitante: el tick diario genera un reporte por empresa que nadie pidió y
 * que va a todos sus destinatarios. Ahí el idioma de la empresa es lo único que tiene
 * sentido, y por eso ese camino no llama a esta función. Y si el usuario no se encuentra
 * —una fila borrada, una carrera—, se cae al de la empresa antes que fallar: un reporte en
 * el idioma equivocado es un defecto; un reporte que no se genera es una caída.
 */
export async function localeDeContenido(
  db: DB,
  companyId: string,
  userId: string,
): Promise<'es' | 'en'> {
  const [usuario] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, userId));
  if (usuario?.locale) return usuario.locale;

  const [empresa] = await db
    .select({ locale: companies.locale })
    .from(companies)
    .where(eq(companies.id, companyId));
  return empresa?.locale ?? 'es';
}
