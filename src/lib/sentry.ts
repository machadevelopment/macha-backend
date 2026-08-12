import * as Sentry from '@sentry/bun';
import { env } from './env';

/**
 * CU-868kfv9ur: no-op without a real DSN (local/dev/CI never set SENTRY_DSN — same
 * pattern as every other optional integration in this repo, e.g. Resend/S3). Only
 * Railway staging/prod get a real DSN, set out-of-band like every other secret here.
 *
 * CU-868kmr1tb — ese no-op es correcto en local y peligroso en un deploy. La auditoría
 * del 2026-08-05 encontró producción sirviendo a un cliente real **sin una sola captura
 * de errores**, y nada lo decía: `initSentry()` volvía en silencio y el arranque se veía
 * idéntico al de un entorno instrumentado. Los bugs de ese día (el 500 de `/` sin sesión,
 * el interbloqueo del alta de empresas) se encontraron probando a mano.
 *
 * Mismo tratamiento que el aviso de aislamiento de base (`db-role-check.ts`) y el de modo
 * piloto de facturación (`index.ts`): un fallo silencioso necesita a alguien que lo diga
 * en voz alta. Aquí **solo se avisa, no se aborta** — quedarse sin monitoreo es grave,
 * pero tumbar producción por no tener monitoreo lo es más.
 */

export type SentryStatus = {
  /** Si se llamó a `Sentry.init` de verdad. */
  enabled: boolean;
  /** El `environment` con el que se etiqueta cada evento. */
  environment: string;
  /** Aviso de arranque cuando un entorno DESPLEGADO corre sin captura de errores. */
  warning: string | null;
};

export type SentryInputs = {
  dsn: string;
  /** `SENTRY_ENVIRONMENT` — override explícito del operador. */
  sentryEnvironment: string;
  /** `RAILWAY_ENVIRONMENT_NAME` — la pone la plataforma sola. */
  railwayEnvironment: string;
  nodeEnv: string;
};

/**
 * El juicio, sin efectos (mismo patrón que `evaluateIsolation` en `db-role-check.ts`):
 * decidir si arranca el SDK, con qué `environment`, y si hay que gritar. Separado del
 * `init` porque `env.ts` resuelve una sola vez por proceso y probar varios entornos sobre
 * el módulo real exigiría un subproceso por caso.
 *
 * Precedencia del `environment`:
 *
 *  1. `SENTRY_ENVIRONMENT` — el nombre estándar que el SDK lee solo. **Pasar
 *     `environment` en el `init()` lo PISA**, así que hasta este ticket setearla en
 *     Railway no habría hecho nada: el valor quemado era `NODE_ENV`.
 *  2. `RAILWAY_ENVIRONMENT_NAME` — `production` / `staging`, inyectada por la plataforma.
 *     Es la que de verdad distingue los dos deploys, porque **ambos corren con
 *     `NODE_ENV=production`** (verificado contra las variables reales del servicio
 *     `macha-backend` en Railway, 2026-08-12).
 *  3. `NODE_ENV` — último recurso, que es lo único que había antes.
 */
export function evaluateSentry(input: SentryInputs): SentryStatus {
  const environment =
    input.sentryEnvironment || input.railwayEnvironment || input.nodeEnv || 'development';

  if (input.dsn) return { enabled: true, environment, warning: null };

  // "Esto es un deploy" no se puede deducir del DSN — justamente es lo que falta. Se
  // deduce de las señales que pone la plataforma: Railway inyecta
  // RAILWAY_ENVIRONMENT_NAME en todos sus servicios, y NODE_ENV=production nunca es el
  // estado de un `bun run dev` ni del job de tests.
  const esDespliegue = Boolean(input.railwayEnvironment) || input.nodeEnv === 'production';
  if (!esDespliegue) return { enabled: false, environment, warning: null };

  return {
    enabled: false,
    environment,
    warning:
      `SIN MONITOREO DE ERRORES: SENTRY_DSN no está seteada en '${environment}'. ` +
      'Un 500 de la API no deja más rastro que los logs de Railway, que no agregan, no ' +
      'alertan y rotan. Setear SENTRY_DSN en las variables del servicio (ver README ' +
      '§Observabilidad) — un proyecto de Sentry POR ENTORNO, nunca el mismo DSN en ' +
      'staging y en producción.',
  };
}

/** Arranca el SDK si hay DSN y deja constancia en el log del arranque, en cualquier caso. */
export function initSentry(): SentryStatus {
  const status = evaluateSentry({
    dsn: env.sentryDsn,
    sentryEnvironment: env.sentryEnvironment,
    railwayEnvironment: env.railwayEnvironment,
    nodeEnv: env.nodeEnv,
  });

  if (status.warning) console.warn(`[sentry] ${status.warning}`);
  if (!status.enabled) return status;

  Sentry.init({ dsn: env.sentryDsn, environment: status.environment, tracesSampleRate: 0.1 });
  console.log(`[sentry] captura de errores activa — environment='${status.environment}'.`);
  return status;
}
