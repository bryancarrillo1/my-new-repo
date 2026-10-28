import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.ts";

// The same client code talks to real S3; only the endpoint differs.
export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: true, // MinIO/SeaweedFS serve buckets as /bucket/key, not bucket.host/key
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  // Without this the SDK signs a CRC32 of the *empty* body into presigned PUT
  // URLs, so storage rejects the client's real bytes with BadDigest.
  requestChecksumCalculation: "WHEN_REQUIRED",
});

export function originalKey(videoId: string): string {
  return `originals/${videoId}/source`;
}

/**
 * A time-limited URL that lets the client PUT bytes for exactly one key,
 * without the bytes ever passing through the API server.
 */
export function presignUpload(key: string, contentLength: number): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ContentLength: contentLength }),
    { expiresIn: config.UPLOAD_URL_TTL_SECONDS },
  );
}

/** Returns the object's size, or null if it does not exist. */
export async function headObjectSize(key: string): Promise<number | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return res.ContentLength ?? 0;
  } catch (err) {
    if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  }
}
