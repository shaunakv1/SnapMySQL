import fs from "node:fs";
import crypto from "node:crypto";

export function fileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function isoUtcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
