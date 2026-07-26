import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';

// S3 stores binaries; the DB stores only keys. Keys are prefixed by company_id.
export const s3 = new S3Client({ region: env.s3Region });

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
