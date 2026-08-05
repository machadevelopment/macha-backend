import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';

// S3 stores binaries; the DB stores only keys. Keys are prefixed by company_id.
//
// Las credenciales se pasan EXPLÍCITAS cuando existen. Antes solo se pasaba la región y
// el SDK caía a su cadena por defecto, que busca `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
// — no los `S3_*` que documentan `.env.example` y el README. Resultado: con la
// configuración documentada, toda subida moría con `Could not load credentials from any
// providers`. Visto en producción al subir el primer Excel real.
//
// Si no están seteadas se OMITE el campo a propósito, en vez de pasar cadenas vacías: en
// un entorno con rol de IAM o credenciales de instancia la cadena por defecto SÍ es lo
// correcto, y un objeto `credentials` con cadenas vacías la anularía y rompería el
// despliegue. Por eso el `??` de env.ts (cadena vacía) y este `&&` van juntos.
//
// Función aparte —y no un spread en línea— para poder fijarla en un test sin construir un
// cliente ni tocar `process.env` (el módulo lee `env` una sola vez, al importarse).
export function s3Credentials(
  accessKeyId: string,
  secretAccessKey: string,
): { credentials?: { accessKeyId: string; secretAccessKey: string } } {
  if (!accessKeyId || !secretAccessKey) return {};
  return { credentials: { accessKeyId, secretAccessKey } };
}

export const s3 = new S3Client({
  region: env.s3Region,
  ...s3Credentials(env.s3AccessKeyId, env.s3SecretAccessKey),
});

export const uploadKey = (companyId: string, documentId: string, ext: string) =>
  `companies/${companyId}/uploads/${documentId}.${ext}`;

export const reportRenderKey = (companyId: string, reportVersionId: string) =>
  `companies/${companyId}/reports/${reportVersionId}.html`;

/** Direct server-side upload (the backend receives the multipart file itself and
 * relays it to S3) — as opposed to presignPut, which is for client-direct uploads. */
export async function uploadObject(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

/** Direct server-side download — the worker (CU-868kfva8v) reads the original Excel
 * back from S3 to parse it; no client round trip, so a presigned URL isn't needed. */
export async function downloadObject(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }));
  if (!res.Body) throw new Error(`S3 object has no body: ${key}`);
  return res.Body.transformToByteArray();
}

export async function presignGet(key: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }), { expiresIn });
}
/** Lists every key under `prefix` with its LastModified — used by the nightly backup
 * job (CU-868kfvar3) to find dump objects older than the retention window. Paginates
 * internally; the backup prefix is small (one object/day) so a single caller-side
 * array is fine. */
export async function listObjects(
  prefix: string,
): Promise<Array<{ key: string; lastModified: Date }>> {
  const out: Array<{ key: string; lastModified: Date }> = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.LastModified) out.push({ key: obj.Key, lastModified: obj.LastModified });
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return out;
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }));
}

export async function presignPut(
  key: string,
  contentType: string,
  expiresIn = 300,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
}
