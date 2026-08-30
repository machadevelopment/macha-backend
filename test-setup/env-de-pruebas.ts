/**
 * Variables de entorno mínimas para que `bun test` corra en un clon RECIÉN CLONADO.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL BUG QUE ARREGLA: "a mí me funciona" (reportado 2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `lib/env.ts` exige `DATABASE_URL` AL IMPORTARSE, y media docena de tests la importan de
 * rebote —`src/app.test.ts` monta la app entera para fijar qué rutas son públicas—. Sin la
 * variable, esos archivos revientan en tiempo de import: **29 tests en rojo**, con el mensaje
 * `Missing required env var: DATABASE_URL` y nada que explique qué hacer.
 *
 * No fallaba para todo el mundo, y ESA es la parte que lo hizo durar:
 *
 *   · La máquina del dueño tiene un `.env` local, que Bun carga solo. Pasa.
 *   · CI la define a mano en `ci.yml` (`DATABASE_URL: postgres://unused:...`). Pasa.
 *   · Un clon nuevo —un compañero, una máquina nueva, un contenedor— no tiene ninguna de las
 *     dos. **Falla.**
 *
 * O sea que el requisito estaba escrito en un YAML de CI y en un archivo gitignoreado, y en
 * ninguna parte del repo. Los dos únicos entornos que lo tenían eran los dos que nadie mira.
 *
 * ═══ POR QUÉ ACÁ Y NO EN CADA TEST ═══
 *
 * Tres archivos ya hacían `process.env.DATABASE_URL ??= '...'` en su primera línea, cada uno
 * con su propio comentario. Eso funciona **solo si ese archivo corre antes** que los demás:
 * Bun comparte el proceso entre archivos de test, así que el parche de uno arregla o no
 * arregla a los otros según el orden en que Bun los levante. Un remiendo que depende del orden
 * de los archivos no es un arreglo, es una moneda al aire.
 *
 * ═══ POR QUÉ `??=` Y NO ASIGNACIÓN DIRECTA ═══
 *
 * Un `.env` real, o el `TEST_DATABASE_URL` del job de integración, tienen que GANAR. Esto pone
 * un piso para que el proceso arranque; nunca pisa una configuración de verdad.
 *
 * ═══ LA URL APUNTA A UN PUERTO MUERTO A PROPÓSITO ═══
 *
 * `127.0.0.1:1` no acepta conexiones. Los tests unitarios no tocan Postgres (postgres.js
 * conecta perezosamente y los guards cortan antes), así que lo único que hace falta es que la
 * variable EXISTA. Si algún test unitario intentara conectar de verdad, queremos que falle
 * fuerte y enseguida — no que se cuelgue contra una base real que alguien tenga levantada.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
