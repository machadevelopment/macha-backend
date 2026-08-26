/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ ESTÁ OCUPANDO EL DISCO, PREGUNTABLE EN EL MOMENTO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `lib/db-size.ts` ya sabía medir esto, pero su único llamador era el backup nocturno. O sea
 * que la respuesta existía una vez al día y no cuando hacía falta.
 *
 * El 2026-08-26 producción se cayó por disco lleno (479,9 MB de 500) y la pregunta "¿qué creció?"
 * solo se podía contestar abriendo un psql contra la base de los clientes y escribiendo SQL a
 * mano — con el servicio caído, que es el peor momento para improvisar una consulta.
 *
 * Uso:
 *   DB_SIZE_DATABASE_URL=postgres://... POSTGRES_VOLUME_LIMIT_MB=5000 bun run db:size
 *
 * ═══ POR QUÉ SU PROPIA VARIABLE Y NO `DATABASE_URL` ═══
 *
 * Mismo criterio que `audit-staging-data.ts` y `restore-drill.ts`: apuntar a la base es una
 * decisión explícita, no lo que la shell tuviera cargado. Acá el riesgo es menor que en esos dos
 * —esto solo LEE catálogo, no toca una fila— pero leer el tamaño del ambiente equivocado y
 * decidir sobre eso es igual de inútil que no medir.
 *
 * ═══ LO QUE NO MIDE ═══
 *
 * `pg_database_size` no incluye el WAL, que es justamente lo que desbordó el volumen aquella vez.
 * La cabecera de `lib/db-size.ts` lo explica entero; acá se repite en la salida para que nadie
 * lea la cifra como "el disco está al X %".
 */

async function main() {
  const url = process.env.DB_SIZE_DATABASE_URL;
  if (!url) {
    console.error(
      'DB_SIZE_DATABASE_URL no está seteada. Apúntala explícitamente al ambiente que querés medir.\n' +
        '  DB_SIZE_DATABASE_URL=postgres://... POSTGRES_VOLUME_LIMIT_MB=5000 bun run db:size',
    );
    process.exit(1);
  }

  /*
   * `lib/db-size.ts` usa el cliente compartido, que lee `APP_DATABASE_URL`. Setearla acá hace
   * que el script mida la base que se le pidió sin duplicar la consulta ni el criterio del
   * umbral — la alerta nocturna y este comando tienen que dar exactamente el mismo veredicto.
   *
   * ⚠️ EL `import` VA DESPUÉS, Y NO ES ESTILO. Un `import` estático se ejecuta ANTES que este
   * cuerpo, así que `db/client.ts` ya habría abierto la conexión con lo que hubiera en el
   * ambiente — y el script mediría esa base mientras imprime el resultado como si fuera la
   * pedida. Pasó en el primer intento contra producción: reportó 17,4 MB (la base local de
   * desarrollo) para un volumen donde había 480 MB ocupados, sin fallar ni advertir nada. Una
   * herramienta de diagnóstico que contesta con seguridad sobre el ambiente equivocado es peor
   * que no tenerla: se decide con ella.
   */
  process.env.APP_DATABASE_URL = url;

  const { medirTamanoDeBase, describirTamano } = await import('@/lib/db-size');

  const t = await medirTamanoDeBase();
  console.log(describirTamano(t));

  if (t.requiereAtencion) {
    console.log(
      '\n⚠️  Por encima del umbral de aviso. Agrandar el volumen es de DASHBOARD en Railway ' +
        '(Live resize), no hay API que lo haga.',
    );
  }
  if (t.limiteBytes === null) {
    console.log(
      '\nSin POSTGRES_VOLUME_LIMIT_MB no hay contra qué comparar. El límite del volumen se lee ' +
        'en Railway → servicio Postgres → volumen → Size.',
    );
  }

  // El proceso no termina solo: `postgres` deja el pool abierto.
  process.exit(0);
}

void main();

/*
 * Sin un `import` estático arriba, TypeScript trata al archivo como script global y su `main`
 * choca con el de los otros scripts de esta carpeta. Esto lo vuelve módulo.
 */
export {};
