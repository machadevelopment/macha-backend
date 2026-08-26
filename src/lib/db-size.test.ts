import { describe, expect, test } from 'bun:test';
import { describirTamano, type TamanoDeBase } from './db-size';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL AVISO DE ESPACIO — incidente del 2026-08-26
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La base de producción se cayó por disco lleno (479,9 MB de un volumen de 500) y nadie lo
 * supo hasta que Railway mandó el correo de "Deploy Crashed!". Para entonces la contabilidad
 * de los clientes llevaba una hora inaccesible.
 *
 * Lo que se prueba acá es la parte pura: el umbral y la redacción. La consulta a Postgres vive
 * en el mismo módulo y se ejercita en integración — un mock de `pg_database_size` probaría el
 * mock, no la consulta.
 */

const base = (over: Partial<TamanoDeBase> = {}): TamanoDeBase => ({
  bytes: 100 * 1024 * 1024,
  limiteBytes: 2048 * 1024 * 1024,
  proporcion: 100 / 2048,
  requiereAtencion: false,
  mayores: [],
  ...over,
});

describe('el aviso dice cuánto queda', () => {
  test('con límite configurado, reporta la proporción', () => {
    const t = base({ bytes: 1600 * 1024 * 1024, proporcion: 1600 / 2048 });
    const texto = describirTamano(t);
    expect(texto).toContain('1600.0 MB');
    expect(texto).toContain('2048.0 MB');
    expect(texto).toContain('78 %');
  });

  /*
   * La limitación va EN EL AVISO, no solo en un comentario del código. `pg_database_size()` no
   * incluye el WAL, que es justamente lo que desbordó el volumen del incidente: su cola llegaba
   * a 216 MB, el 43 % de aquel volumen. Un aviso que se lee como "el disco está al 78 %" cuando
   * mide otra cosa es peor que no tenerlo — le enseña al equipo un número en el que confiar de
   * más.
   */
  test('el texto advierte que NO incluye el WAL', () => {
    expect(describirTamano(base({ proporcion: 0.8 }))).toContain('SIN CONTAR el WAL');
  });

  /*
   * Sin la variable configurada el chequeo NO se calla: reporta el tamaño igual y dice qué le
   * falta. Un chequeo que se apaga solo cuando falta configuración es un chequeo que un día no
   * está y nadie lo nota — que es exactamente cómo se llega a un disco lleno por sorpresa.
   */
  test('sin límite configurado sigue reportando, y dice que falta', () => {
    const texto = describirTamano(base({ limiteBytes: null, proporcion: null }));
    expect(texto).toContain('100.0 MB');
    expect(texto).toContain('POSTGRES_VOLUME_LIMIT_MB');
  });

  /*
   * El aviso nombra las tablas más pesadas porque sin eso es un número sin acción: "la base
   * pesa 1,6 GB" no dice qué hacer; "900 MB son staging_rows" sí —esa tabla guarda el payload
   * de cada fila de Excel ya promovida y hoy no la limpia nadie—.
   */
  test('nombra las tablas que explican el tamaño', () => {
    const texto = describirTamano(
      base({
        mayores: [
          { tabla: 'staging_rows', bytes: 900 * 1024 * 1024 },
          { tabla: 'ingested_rows', bytes: 300 * 1024 * 1024 },
        ],
      }),
    );
    expect(texto).toContain('staging_rows 900.0 MB');
    expect(texto).toContain('ingested_rows 300.0 MB');
  });

  test('sin tablas no agrega una lista vacía', () => {
    expect(describirTamano(base())).not.toContain('Lo más pesado');
  });
});

/**
 * La regla que protege lo que de verdad importa: **el chequeo no puede tumbar el backup**.
 *
 * Cambiar el respaldo de la noche por un aviso informativo es el peor negocio posible, y es un
 * error fácil de cometer — basta con poner la medición dentro del `try` del backup, o después
 * sin `try` propio. Este test lo fija sobre el código fuente, que es donde vive la decisión.
 */
describe('el chequeo de espacio no puede romper el backup', () => {
  const worker = Bun.file(new URL('../queue/workers/db-backup.ts', import.meta.url).pathname);

  test('la medición va en su propio try/catch', async () => {
    const fuente = await worker.text();
    const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // El bloque del backup termina y CIERRA antes de que empiece la medición.
    const finDelBackup = sinComentarios.indexOf('throw err;');
    // La LLAMADA, no el import — que está arriba del todo y haría pasar el test siempre.
    const inicioMedicion = sinComentarios.indexOf('await medirTamanoDeBase(');
    expect(finDelBackup).toBeGreaterThan(-1);
    expect(inicioMedicion).toBeGreaterThan(finDelBackup);

    // Y la medición tiene su propio catch que NO relanza.
    const trasMedicion = sinComentarios.slice(inicioMedicion);
    expect(trasMedicion).toContain('catch');
    const catchDeMedicion = trasMedicion.slice(trasMedicion.indexOf('catch'));
    expect(catchDeMedicion).not.toContain('throw');
  });
});
