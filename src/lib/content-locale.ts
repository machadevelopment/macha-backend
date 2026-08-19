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
/**
 * ═══ EL IDIOMA QUE LA PANTALLA ESTÁ MOSTRANDO GANA, Y SE PERSISTE (CU-868ku6pp9) ═══
 *
 * Lo de arriba resolvió de dónde sale el idioma, pero dejó un hueco que Jose encontró:
 * plataforma completamente en inglés, reporte generado en español.
 *
 * El motivo está anotado a propósito en el frontend (`lib/i18n/persist-locale.ts`): si el
 * `PUT /me/locale` que dispara el selector falla por algo transitorio —sesión a punto de
 * vencer, red— el fallo SE TRAGA para que la interfaz igual cambie de idioma sin trabar a
 * quien lo apretó. Decisión razonable, con una consecuencia que no lo es: la cookie (lo que
 * el usuario ve) y `users.locale` (lo que el backend usa para escribir) quedan
 * desincronizados **en silencio y de forma indefinida**, hasta que alguien vuelva a tocar el
 * selector y esa llamada sí funcione.
 *
 * Reintentar el `PUT` no arregla la clase de bug: siempre puede fallar la última vez. Lo que
 * sí la arregla es que **cada petición que genera contenido lleve el idioma que la pantalla
 * está mostrando**, y que verlo distinto al guardado sea suficiente para corregir el guardado.
 * Así el sistema se sana solo en la siguiente cosa que el usuario pida, sin depender de que un
 * clic concreto haya tenido suerte.
 *
 * `visible` NO es un dato de seguridad y por eso se acepta del cliente sin ceremonia: el peor
 * caso de mentir es recibir tu propio reporte en el otro idioma. Se valida que sea `es`/`en` y
 * nada más.
 *
 * La escritura es oportunista: si falla, se sigue con el idioma correcto igual. Persistirlo es
 * lo que mantiene las TRES superficies de acuerdo —reporte, chat y el correo que avisa que el
 * reporte está listo—, porque el correo se manda desde un worker que no tiene ninguna cookie
 * a la vista.
 */
export async function localeDeContenido(
  db: DB,
  companyId: string,
  userId: string,
  visible?: string | null,
): Promise<'es' | 'en'> {
  const deLaPantalla = visible === 'es' || visible === 'en' ? visible : null;

  const [usuario] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, userId));

  if (deLaPantalla) {
    // Solo se escribe si de verdad cambió: un UPDATE por cada reporte generado ensucia el
    // `updated_at` de la fila y no aporta nada.
    if (usuario && usuario.locale !== deLaPantalla) {
      await db
        .update(users)
        .set({ locale: deLaPantalla })
        .where(eq(users.id, userId))
        .catch((err: unknown) => {
          // Que no se pueda persistir la preferencia no puede tumbar la generación del
          // contenido: se responde en el idioma correcto y la próxima vez se reintenta solo.
          console.warn(
            `[locale] no se pudo sincronizar users.locale=${deLaPantalla} para ${userId}:`,
            err,
          );
        });
    }
    return deLaPantalla;
  }

  if (usuario?.locale) return usuario.locale;

  const [empresa] = await db
    .select({ locale: companies.locale })
    .from(companies)
    .where(eq(companies.id, companyId));
  return empresa?.locale ?? 'es';
}
