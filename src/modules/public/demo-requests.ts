import { Elysia, t } from 'elysia';
import { and, count, eq, gte } from 'drizzle-orm';
import * as Sentry from '@sentry/bun';
import { db } from '@/db/client';
import { demoRequests } from '@/db/schema';
import { hashDeOrigen, ipDeCabeceras } from '@/lib/lead-origin';
import { sendDemoRequestNotice } from '@/lib/email';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * POST /public/demo-requests — EL ÚNICO ENDPOINT SIN AUTENTICACIÓN DE ESTE BACKEND
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Pedido de Jose (2026-08-21): la landing tenía como único camino de conversión un `mailto:`, y
 * hacía falta "un form básico, para que pongan como datos básicos".
 *
 * Todo lo demás en esta API pasa por un guard que resuelve `companyId` desde el JWT verificado.
 * Acá no hay JWT ni empresa: quien llena el formulario todavía no es cliente de nadie. Por eso el
 * prefijo es `/public/` y no una ruta suelta — que sea evidente en la URL, en la composición de
 * `app.ts` y en cualquier log que esta puerta está abierta a propósito.
 *
 * ═══ LO QUE ESTA RUTA NO PUEDE HACER, POR CONSTRUCCIÓN ═══
 *
 * Solo INSERTA en `demo_requests`, que es append-only y no tiene `company_id`. No lee ni escribe
 * ninguna tabla de negocio, así que no hay superficie de fuga entre inquilinos: no existe un
 * parámetro que pueda apuntar a los datos de una empresa porque no toca ninguna tabla que los
 * tenga. Ese es el argumento de seguridad, y es estructural, no una lista de validaciones.
 *
 * ═══ EL FRENO POR ORIGEN VA EN POSTGRES, NO EN EL TOKEN BUCKET DE REDIS ═══
 *
 * Y es deliberado, contra la intuición de "usa el limitador que ya existe".
 *
 * `checkTokenBucket` FALLA ABIERTO por diseño: si Redis no contesta, deja pasar (ver la nota larga
 * en `lib/rate-limit.ts`). Esa decisión es correctísima para las rutas del producto —un limitador
 * que provoca la caída que existe para evitar está al revés— porque ahí el gasto real lo frenan los
 * créditos y la profundidad de cola, que viven en Postgres.
 *
 * Acá no hay segundo freno. Fallar abierto en un endpoint PÚBLICO significa escritura ilimitada en
 * una tabla que no se puede limpiar, durante todo el tiempo que Redis esté caído, y sin que nadie
 * lo note hasta ver el panel. Así que el freno es un COUNT contra la misma base donde se inserta:
 * si Postgres no está, tampoco hay INSERT que limitar.
 *
 * El índice `demo_requests_origen_idx` existe por esto: sin él, el freno anti-abuso sería un scan
 * completo por request, o sea el propio vector de abuso.
 *
 * ═══ EL SEÑUELO ═══
 *
 * Un campo que un humano no ve y un bot simple llena. Si viene con algo, se responde 200 y NO se
 * guarda nada: decirle "te detecté" a un bot solo le enseña a reintentar distinto. No pretende
 * parar a nadie decidido —para eso haría falta un CAPTCHA, que es una decisión de producto— pero
 * sí al ruido automático, que es la mayoría.
 *
 * ═══ SE GUARDA PRIMERO Y SE AVISA DESPUÉS ═══
 *
 * El correo al equipo es un aviso ENCIMA de la fila, nunca el registro. Si el envío falla, el lead
 * ya está guardado y el panel lo muestra. Al revés se pierde un cliente potencial en silencio, que
 * es exactamente el fallo que ya tuvimos con las invitaciones (CU-868krkndr) y que acá no se puede
 * repetir porque hoy no se puede AFIRMAR que el dominio esté verificado en Resend.
 */

/** Cuántas solicitudes se aceptan del mismo origen por día. */
const TOPE_POR_ORIGEN = 5;
const VENTANA_MS = 24 * 60 * 60 * 1000;

/**
 * A quién se le avisa. No es configurable desde el panel a propósito: es la dirección que la
 * landing publica como contacto, y si las dos se separan el cliente escribe a un buzón y el aviso
 * llega a otro.
 */
export const CORREO_DE_AVISO = 'contact@machafinance.com';

export const publicDemoRequests = new Elysia({ prefix: '/public' }).post(
  '/demo-requests',
  async ({ body, headers, set }) => {
    // El señuelo. 200 sin guardar: ver la nota de arriba.
    if (body.website && body.website.trim() !== '') return { ok: true };

    const ipHash = hashDeOrigen(ipDeCabeceras(headers as Record<string, string | undefined>));

    const [reciente] = await db
      .select({ n: count() })
      .from(demoRequests)
      .where(
        and(
          eq(demoRequests.ipHash, ipHash),
          gte(demoRequests.createdAt, new Date(Date.now() - VENTANA_MS)),
        ),
      );

    if ((reciente?.n ?? 0) >= TOPE_POR_ORIGEN) {
      set.status = 429;
      return { error: 'rate_limited' as const };
    }

    /*
     * `btrim` en la app y no solo en el CHECK: un nombre que es un espacio pasa el `length >= 1` de
     * Postgres y llega al panel como una fila vacía. Y el correo en minúsculas porque es lo que
     * hace comparables dos envíos de la misma persona.
     */
    const [fila] = await db
      .insert(demoRequests)
      .values({
        name: body.name.trim(),
        companyName: body.companyName.trim(),
        email: body.email.trim().toLowerCase(),
        phone: body.phone?.trim() || null,
        message: body.message?.trim() || null,
        locale: body.locale ?? 'es',
        source: 'landing',
        ipHash,
      })
      .returning({ id: demoRequests.id });

    /*
     * El aviso va por la COLA y con `catch`, o sea dos redes: encolar no espera a Resend, y si
     * hasta encolar falla (pg-boss caído) la solicitud igual se responde ok porque la fila ya está.
     * Lo que se pierde en el peor caso es la notificación, no el lead — y el fallo va a Sentry para
     * que no sea invisible.
     */
    try {
      await sendDemoRequestNotice({
        locale: body.locale ?? 'es',
        requestId: fila!.id,
        recipientEmail: CORREO_DE_AVISO,
        nombre: body.name.trim(),
        empresa: body.companyName.trim(),
        correo: body.email.trim().toLowerCase(),
        telefono: body.phone?.trim() || '',
        mensaje: body.message?.trim() || '',
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { mecanismo: 'aviso_de_demo_no_encolado' } });
    }

    return { ok: true, id: fila?.id };
  },
  {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 120 }),
      companyName: t.String({ minLength: 1, maxLength: 160 }),
      // `format: 'email'` de TypeBox y un tope de 254 (el máximo de un correo por RFC). No un
      // regex propio: rechazaría direcciones válidas raras y el único efecto sería perder un lead.
      email: t.String({ format: 'email', maxLength: 254 }),
      phone: t.Optional(t.String({ maxLength: 40 })),
      message: t.Optional(t.String({ maxLength: 2000 })),
      locale: t.Optional(t.Union([t.Literal('es'), t.Literal('en')])),
      /**
       * El señuelo. Va en el esquema —y no ignorado— porque si no estuviera declarado, Elysia
       * rechazaría el envío del bot con un 422 de validación: le diría exactamente qué campo
       * sobra, que es la información que no queremos darle.
       */
      website: t.Optional(t.String({ maxLength: 200 })),
    }),
  },
);
