import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

const { s3Credentials } = await import('./s3');

/**
 * CU-868kmuhbp. `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` estaban documentadas en
 * `.env.example` y en el README desde el principio, pero nadie las leía: el cliente se
 * construía solo con la región y el SDK caía a su cadena por defecto, que busca
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Con la configuración documentada, toda
 * subida moría con `Could not load credentials from any providers`. Visto en producción
 * al subir el primer Excel real.
 *
 * Lo que se fija aquí es la regla de las dos direcciones — pasarlas cuando están, y
 * OMITIRLAS (no mandar cadenas vacías) cuando no.
 */
describe('s3Credentials (CU-868kmuhbp)', () => {
  test('con ambas variables seteadas, las pasa explícitas al cliente', () => {
    expect(s3Credentials('AKIAEXAMPLE', 'secreto')).toEqual({
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secreto' },
    });
  });

  test('sin ninguna, omite el campo para dejar actuar a la cadena por defecto del SDK', () => {
    // Un entorno con rol de IAM o credenciales de instancia depende de esa cadena; un
    // objeto `credentials` con cadenas vacías la anularía y rompería el despliegue.
    expect(s3Credentials('', '')).toEqual({});
    expect('credentials' in s3Credentials('', '')).toBe(false);
  });

  test('con una sola de las dos, tampoco arma credenciales a medias', () => {
    // Es el estado normal de una variable a medio configurar en Railway (la UI guarda la
    // clave con valor vacío). Mandar `secretAccessKey: ''` daría un error de firma
    // mucho más difícil de leer que caer a la cadena por defecto.
    expect(s3Credentials('AKIAEXAMPLE', '')).toEqual({});
    expect(s3Credentials('', 'secreto')).toEqual({});
  });
});
