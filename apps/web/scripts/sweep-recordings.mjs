// Deletes stored recording objects that no row in the database claims.
//
// The app writes an object before it writes the row that names it and deletes
// the object before it deletes the row, so a half-failure always leaves the
// same shape: an object nothing points at. That is the recoverable direction and
// this is what recovers it. See src/lib/recording/blobs.ts for why the ordering
// is that way round rather than the other.
//
// Three things produce an orphan:
//
//   - A save whose object landed and whose INSERT did not. The route tries to
//     remove it on the way past; if that removal also fails, it stays.
//   - An account deletion whose purge could not reach the bucket. The rows are
//     gone by then, so there is nothing left but the objects.
//   - A restore of the database from a backup taken before an object was
//     written. Nothing detects this and nothing should — the sweep simply finds
//     the objects afterwards.
//
//   node apps/web/scripts/sweep-recordings.mjs
//   node apps/web/scripts/sweep-recordings.mjs --dry-run
//   node apps/web/scripts/sweep-recordings.mjs --min-age-hours=1
//
// Nothing schedules it and it is deliberately not in the runtime image: the
// intended production trigger is an authenticated route called by an external
// scheduler, which is not built yet. Until then this runs from a checkout with
// DATABASE_URL and the R2_* variables pointed at production, which is a fine
// way to run something that is only needed after a failure.
//
// Safe to run repeatedly, safe to run against a live app, and safe to run
// concurrently with itself: it only deletes objects that are both unclaimed and
// older than the grace window, and deleting an object twice is a no-op.
//
// Deliberately uses `pg` and nothing else, for the same reason migrate.mjs does:
// the scripts in this directory are plain Node with no build step and no
// TypeScript. That is why the signing below is a second implementation of
// src/lib/storage/sigv4.ts rather than an import of it — and why
// src/lib/storage/sweep-script.test.ts signs the same request with both and
// fails if they disagree. Changing one and not the other breaks `bun test`,
// which is the only thing standing between this file and a silent 403 at three
// in the morning.

import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * How old an object must be before it is considered abandoned.
 *
 * A save in flight has written its object and not yet its row, which is
 * indistinguishable from an orphan by looking at the bucket. An hour is far
 * longer than the gap between the two — they are consecutive statements — and
 * costs nothing, because an orphan that survives one run is collected by the
 * next.
 */
const DEFAULT_MIN_AGE_HOURS = 1;

/** The prefixes the app writes under. Anything else in the bucket is not ours. */
const PREFIXES = ["rec/", "share/"];

/* ------------------------------------------------------------------- sigv4 */

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

export function encodeRfc3986(value) {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const c = String.fromCharCode(byte);
    out += UNRESERVED.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Signs a request and returns the headers to send.
 *
 * Kept byte-for-byte equivalent to `signRequest` in src/lib/storage/sigv4.ts.
 * Exported so the test can prove that, not because anything else calls it.
 */
export function signRequest(req, creds, now) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(req.body ?? Buffer.alloc(0));

  const headers = {
    ...req.headers,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };

  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(";");

  const query = req.query
    ? Object.entries(req.query)
        .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  const canonical = [
    req.method.toUpperCase(),
    req.path,
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");

  let key = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  key = hmac(key, creds.region);
  key = hmac(key, creds.service);
  key = hmac(key, "aws4_request");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${hmac(key, stringToSign).toString("hex")}`,
  };
}

/* ------------------------------------------------------------------ bucket */

function config() {
  const missing = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter(
    (v) => !process.env[v],
  );
  if (missing.length > 0) {
    console.error(`sweep: not configured for object storage (${missing.join(", ")} unset)`);
    console.error("sweep: nothing to sweep — this deployment stores recordings in Postgres");
    process.exit(0);
  }
  return {
    endpoint: new URL(process.env.R2_ENDPOINT),
    bucket: process.env.R2_BUCKET,
    creds: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      region: process.env.R2_REGION ?? "auto",
      service: "s3",
    },
  };
}

async function send(store, method, key, query, body = Buffer.alloc(0)) {
  const path = `/${store.bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
  const search = query
    ? `?${Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")}`
    : "";
  const headers = signRequest(
    { method, path, query, headers: { host: store.endpoint.host }, body },
    store.creds,
    new Date(),
  );
  return fetch(`${store.endpoint.origin}${path}${search}`, {
    method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
}

function unescapeXml(v) {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Every object under a prefix, with the timestamp the grace window needs. */
async function list(store, prefix) {
  const out = [];
  let token;

  for (;;) {
    const query = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;

    const res = await send(store, "GET", "", query);
    if (!res.ok) throw new Error(`list ${prefix} failed: ${res.status} ${await res.text()}`);
    const xml = await res.text();

    // Key and LastModified are read as a pair from within one <Contents>, so a
    // key can never be matched against the wrong object's timestamp.
    for (const item of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(item[1]);
      const at = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(item[1]);
      if (key) out.push({ key: unescapeXml(key[1]), lastModified: at ? Date.parse(at[1]) : 0 });
    }

    if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) break;
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    if (!next) break;
    token = unescapeXml(next[1]);
  }

  return out;
}

/* -------------------------------------------------------------------- sweep */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ageArg = args.find((a) => a.startsWith("--min-age-hours="));
  const minAgeHours = ageArg ? Number(ageArg.split("=")[1]) : DEFAULT_MIN_AGE_HOURS;

  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    console.error("sweep: --min-age-hours must be a non-negative number");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("sweep: DATABASE_URL is not set");
    process.exit(1);
  }

  const store = config();
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  let claimed;
  try {
    // Both tables, in one set. A share's copy lives under its own key, and a
    // sweep that read only `recording` would delete every live share link's
    // bytes — which is why this is one query over two tables rather than two
    // passes.
    const rows = await client.query(`
      SELECT storage_key FROM recording       WHERE storage_key IS NOT NULL
      UNION ALL
      SELECT storage_key FROM recording_share WHERE storage_key IS NOT NULL
    `);
    claimed = new Set(rows.rows.map((r) => r.storage_key));
  } finally {
    await client.end();
  }

  console.log(`sweep: ${claimed.size} object(s) claimed by a row`);

  // The bucket is read after the database, deliberately. An object written
  // between the two reads is missing from `claimed` and looks like an orphan;
  // the grace window is what makes that harmless, and reading the bucket second
  // keeps the window the only thing that has to be right.
  const cutoff = Date.now() - minAgeHours * 3_600_000;
  let orphans = 0;
  let deleted = 0;
  let failed = 0;
  let young = 0;

  for (const prefix of PREFIXES) {
    for (const object of await list(store, prefix)) {
      if (claimed.has(object.key)) continue;
      orphans += 1;

      if (object.lastModified > cutoff) {
        young += 1;
        continue;
      }

      if (dryRun) {
        console.log(`sweep: would delete ${object.key}`);
        continue;
      }

      const res = await send(store, "DELETE", object.key);
      if (res.ok || res.status === 404) {
        deleted += 1;
      } else {
        failed += 1;
        console.error(`sweep: could not delete ${object.key}: ${res.status}`);
      }
      await res.arrayBuffer();
    }
  }

  console.log(
    `sweep: ${orphans} unclaimed, ${young} too recent to touch (< ${minAgeHours}h), ` +
      (dryRun ? `${orphans - young} would be deleted` : `${deleted} deleted, ${failed} failed`),
  );

  if (failed > 0) process.exit(1);
}

// Only when run, never when imported. sweep-recordings.test.ts imports
// `signRequest` from this file to check it against the TypeScript one, and a
// test that connected to Postgres and swept a bucket on import would be a
// surprising way to lose data.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
