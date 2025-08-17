import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { mkLogger } from "./logger.js";

const log = mkLogger("s3");

export function s3Client(s3cfg) {
  const endpoint = s3cfg.endpoint;
  const isMinio = typeof endpoint === "string" && /minio|localhost|127\.0\.0\.1/i.test(endpoint);
  return new S3Client({
    region: s3cfg.region,
    endpoint,
    forcePathStyle: isMinio,
    credentials: {
      accessKeyId: s3cfg.accessKeyId,
      secretAccessKey: s3cfg.secretAccessKey
    }
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function putObject({ client, bucket, key, body, contentType }) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return { bucket, key };
}

export async function getJson({ client, bucket, key }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf = await streamToBuffer(res.Body);
  return JSON.parse(buf.toString("utf8"));
}

export async function getText({ client, bucket, key }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf = await streamToBuffer(res.Body);
  return buf.toString("utf8");
}

export async function putJsonAtomic({ client, bucket, key, json }) {
  const tmpKey = key + ".tmp";
  const body = Buffer.from(JSON.stringify(json, null, 2), "utf8");
  await putObject({ client, bucket, key: tmpKey, body, contentType: "application/json" });
  await putObject({ client, bucket, key, body, contentType: "application/json" });
  return { bucket, key };
}

export async function getLatestKey({ client, bucket, db }) {
  const jsonKey = `${db}/latest.json`;
  try {
    const st = await getJson({ client, bucket, key: jsonKey });
    if (st?.latest_backup?.key) return st.latest_backup.key;
  } catch {}
  const txtKey = `${db}/latest.txt`;
  try {
    const s = await getText({ client, bucket, key: txtKey });
    const trimmed = s.trim();
    if (trimmed) return trimmed;
  } catch {}
  const resp = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${db}/` }));
  if (!resp.Contents || resp.Contents.length === 0) return null;
  const candidates = resp.Contents.map(o => o.Key).filter(k => k && /\.tgz$/.test(k));
  candidates.sort();
  return candidates[candidates.length - 1] || null;
}
