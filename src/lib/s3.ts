import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';

// S3 stores binaries; the DB stores only keys. Keys are prefixed by company_id.
export const s3 = new S3Client({ region: env.s3Region });

export const uploadKey = (companyId: string, documentId: string, ext: string) =>
  `companies/${companyId}/uploads/${documentId}.${ext}`;

export const reportRenderKey = (companyId: string, reportVersionId: string) =>
  `companies/${companyId}/reports/${reportVersionId}.html`;

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
