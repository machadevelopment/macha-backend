/**
 * ¿Este entorno puede de verdad entregarle un correo a alguien que no seamos nosotros?
 *
 * ═══ EL BUG QUE LO ORIGINÓ (CU-868krkndr, 2026-08-16) ═══
 *
 * Macha reportó que al invitar a un miembro del equipo, al invitado NO le llegaba nada. El
 * flujo estaba entero: la invitación se creaba, el job se encolaba, `deliverEmail` llamaba a
 * Resend y Resend respondía 200. Nada fallaba.
 *
 * La causa estaba en las variables del servicio `macha-backend` de Railway, entorno
 * `production` (verificado el 2026-08-16):
 *
 *     RESEND_FROM_EMAIL=onboarding@resend.dev
 *
 * `onboarding@resend.dev` es el remitente de CAJA DE ARENA de Resend: existe para que un
 * proyecto nuevo pueda mandar su primer correo sin verificar un dominio, y **solo entrega al
 * correo del dueño de la cuenta de Resend**. A cualquier otro destinatario Resend acepta la
 * request y no la entrega. Por eso el equipo veía "invitación enviada" y el invitado nunca
 * recibía nada: no había error que ver en ningún lado.
 *
 * ═══ POR QUÉ ADEMÁS ES UN PROBLEMA DEL DEFAULT ═══
 *
 * `env.ts` cae a `notificaciones@macha.finance` cuando la variable no está. Ese default se
 * LEE como configurado —es una dirección de la marca— pero solo entrega si ese dominio está
 * verificado en la cuenta de Resend. O sea que las dos formas de equivocarse (poner el
 * sandbox, o no poner nada) producen el mismo silencio.
 *
 * ═══ QUÉ HACE ESTE MÓDULO Y QUÉ NO ═══
 *
 * Grita. No aborta, y no puede arreglarlo: verificar un dominio en Resend es un trámite en
 * su consola, no una línea de código. Mismo tratamiento que el aviso de aislamiento de base
 * (`db-role-check.ts`), el de Sentry sin DSN (`sentry.ts`) y el de modo piloto de facturación
 * (`index.ts`): quedarse sin correo saliente es grave, tumbar producción por eso lo es más.
 *
 * Tampoco valida que el dominio esté verificado — eso exigiría llamar a la API de Resend en
 * cada arranque y solo cubriría el caso que YA se detecta por otra vía (el `result.error` que
 * `deliverEmail` ahora manda a Sentry). Lo que sí se puede saber sin red es que la dirección
 * configurada es, por construcción, incapaz de entregarle a un tercero.
 *
 * El juicio va separado de los efectos (mismo patrón que `evaluateSentry`) porque `env.ts`
 * resuelve una sola vez por proceso y probar varios entornos sobre el módulo real exigiría
 * un subproceso por caso.
 */

export type EmailSenderInputs = {
  /** `RESEND_API_KEY`. Vacía = no hay proveedor y ningún correo sale. */
  apiKey: string;
  /** `RESEND_FROM_EMAIL`, ya resuelto por `env.ts` (nunca vacío: tiene default). */
  fromEmail: string;
  /** `RAILWAY_ENVIRONMENT_NAME` — la pone la plataforma en todos sus servicios. */
  railwayEnvironment: string;
  nodeEnv: string;
};

export type EmailSenderStatus = {
  /**
   * `false` = este entorno NO puede entregarle a un destinatario cualquiera. Se usa para
   * decidir el aviso; no bloquea el envío, que igual se intenta y se registra.
   */
  deliverable: boolean;
  /** Aviso de arranque, o `null` si no hay nada que decir. */
  warning: string | null;
};

/**
 * Dominios de prueba de Resend. `resend.dev` es el que sirve `onboarding@resend.dev`; se
 * listan los subdominios también porque Resend documenta direcciones de prueba bajo
 * `@resend.dev` en general y cualquiera de ellas tiene la misma limitación.
 */
const DOMINIOS_DE_PRUEBA = ['resend.dev'];

function esRemitenteDePrueba(fromEmail: string): boolean {
  const dominio = fromEmail.split('@').pop()?.toLowerCase().trim() ?? '';
  return DOMINIOS_DE_PRUEBA.some((d) => dominio === d || dominio.endsWith(`.${d}`));
}

export function evaluateEmailSender(input: EmailSenderInputs): EmailSenderStatus {
  // Misma deducción que en `sentry.ts`: Railway inyecta RAILWAY_ENVIRONMENT_NAME en todos
  // sus servicios, y NODE_ENV=production nunca es un `bun run dev` ni el job de tests.
  const esDespliegue = Boolean(input.railwayEnvironment) || input.nodeEnv === 'production';
  const entorno = input.railwayEnvironment || input.nodeEnv || 'development';

  if (!input.apiKey) {
    return {
      deliverable: false,
      warning: esDespliegue
        ? `SIN CORREO SALIENTE: RESEND_API_KEY no está seteada en '${entorno}'. Las ` +
          'invitaciones, los avisos de reporte listo y las alertas por correo se registran ' +
          "en `notifications` con status 'failed' y NADIE los recibe. Quien invita ve " +
          '"invitación enviada" igual.'
        : null,
    };
  }

  if (esRemitenteDePrueba(input.fromEmail)) {
    return {
      deliverable: false,
      warning:
        `EL CORREO SOLO LE LLEGA A USTEDES: RESEND_FROM_EMAIL='${input.fromEmail}' es el ` +
        `remitente de caja de arena de Resend (entorno '${entorno}'). Resend acepta el ` +
        'envío y responde OK, pero SOLO entrega al correo del dueño de la cuenta de ' +
        'Resend: a cualquier otro destinatario no le llega nada y no queda error en ningún ' +
        'lado. Es la causa del reporte "la invitación no llega al invitado" ' +
        '(CU-868krkndr). Arreglo: verificar el dominio de Macha en la consola de Resend y ' +
        'poner RESEND_FROM_EMAIL a una dirección de ESE dominio.',
    };
  }

  return { deliverable: true, warning: null };
}
