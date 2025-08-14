import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import fs from "node:fs";

export function s3Client(cfg) {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey
    }
  });
}

export async function uploadFile({ client, bucket, key, filePath, contentType="application/octet-stream" }) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: contentType
  }));
}

export async function putText({ client, bucket, key, text, contentType="text/plain" }) {
  const body = Buffer.from(text, "utf8");
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: body.length,
    CacheControl: "no-cache"
  }));
}

export async function putJsonAtomic({ client, bucket, key, json }) {
  const tmpKey = key + ".tmp";
  const body = Buffer.from(JSON.stringify(json, null, 2), "utf8");
  const put = async (k) => client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: k,
    Body: body,
    ContentType: "application/json",
    ContentLength: body.length,
    CacheControl: "no-cache"
  }));
  await put(tmpKey);
  await put(key);
}

export async function getText({ client, bucket, key }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await res.Body.transformToString();
  return text;
}

export async function getJson({ client, bucket, key }) {
  const txt = await getText({ client, bucket, key });
  return JSON.parse(txt);
}

export async function getLatestKey({ client, bucket, db }) {
  // legacy support for latest.txt
  const key = `${db}/latest.txt`;
  const txt = await getText({ client, bucket, key }).catch(() => null);
  if (!txt) return null;
  return txt.trim();
}

export async function listBackups({ client, bucket, db, maxKeys=10 }) {
  const res = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: `${db}/`,
    MaxKeys: maxKeys
  }));
  return (res.Contents || []).map(o => o.Key).filter(k => k.endsWith(".tgz")).sort();
}
