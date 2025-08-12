import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { log } from "./logger.js";
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
  log.info({ key }, "Uploaded to S3.");
}

export async function putText({ client, bucket, key, text, contentType="text/plain" }) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: text,
    ContentType: contentType
  }));
  log.info({ key }, "Uploaded text object.");
}

export async function getText({ client, bucket, key }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await res.Body.transformToString();
  return text;
}

export async function getLatestKey({ client, bucket, db }) {
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
