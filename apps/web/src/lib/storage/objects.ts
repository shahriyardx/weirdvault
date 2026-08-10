import { encodePath, signRequest, type SigningCredentials } from "./sigv4";

/**
 * Where the recording bytes live, when they do not live in Postgres.
 *
 * `recording.ciphertext` was a `bytea` column and still can be. Object storage
 * is switched on by configuration and off by its absence, which is not
 * fence-sitting — it is the same shape `RELAY_USAGE_SECRET` and
 * `RELAY_AGENT_SECRET` already have, and for the same reason. A self-hoster
 * running the whole product on one machine has a Postgres and no interest in a
 * Cloudflare account, and their recordings are a few hundred megabytes that
 * belong in the backup they already take. A hosted deployment has the opposite
 * problem: every blob is in every `pg_dump`, so backup size and restore time
 * start tracking recording volume rather than data volume. Both are right, for
 * different deployments, so both are supported and the choice is one variable.
 *
 * ── What this is not
 *
 * It is not a trust boundary. The blob was encrypted in the browser under the
 * vault key and this server has never been able to read it, so moving it to a
 * bucket does not hand a third party anything it could not already have taken
 * from the database. That is unusual — most systems making this move are moving
 * plaintext — and it is the whole reason this is plumbing rather than a security
 * decision.
 *
 * It is also not a second way to reach a recording. There is no presign
 * function in sigv4.ts and there should not be one: bytes reach a browser by
 * being fetched here and served through a route that has already checked
 * `user_id`, so the authorization surface stays exactly where it was. For
 * shares the argument is stronger than a preference — `/api/shares/[token]`
 * enforces `revoked_at` when the request arrives, and a presigned URL minted
 * before a revocation keeps working after it, because a bucket has never heard
 * of `revoked_at`.
 *
 * ── Keys
 *
 * `rec/<user_id>/<recording_id>` and `share/<user_id>/<share_id>`. The user id
 * is in the path so that deleting an account and sweeping orphans can both work
 * by prefix, which is the only enumeration a bucket offers. Treat the shape as
 * filing rather than as a secret: it is not a capability, nothing is authorized
 * by knowing it, and an object is an AES-GCM envelope to anybody who reaches it.
 *
 * ── R2, or anything that speaks S3
 *
 * The variables are named for R2 because that is what the hosted deployment
 * uses — egress is free, and the app is on a host where it is not. Nothing here
 * is Cloudflare-specific: `R2_ENDPOINT` is an S3 endpoint, addressing is
 * path-style, and MinIO, Garage, Ceph and S3 itself all work. The test suite
 * uses that fact.
 */

/* -------------------------------------------------------------------- config */

export interface ObjectStore {
  endpoint: URL;
  bucket: string;
  credentials: SigningCredentials;
}

/**
 * Why the configuration is unusable, when it is.
 *
 * A partially filled-in bucket is a typo, not a decision, and it is the one
 * state that must not be read as "storage is off": recordings would silently
 * keep landing in Postgres on a deployment whose operator believes they are in
 * a bucket. So all-set and none-set are the two supported answers and anything
 * else names the missing half here, out loud, once at startup.
 */
export type StorageProblem = { missing: string[] } | { badEndpoint: string };

const VARS = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

/**
 * Reads the environment into a store, or explains why it could not.
 *
 * Pure in its argument so a test can hand it an environment. Everything in the
 * app calls `objectStore()` below, which memoises the process's own.
 */
export function readStorageConfig(
  env: Record<string, string | undefined>,
): { store: ObjectStore } | { off: true } | { problem: StorageProblem } {
  const present = VARS.filter((v) => (env[v] ?? "") !== "");
  if (present.length === 0) return { off: true };
  if (present.length < VARS.length) {
    return { problem: { missing: VARS.filter((v) => !present.includes(v)) } };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.R2_ENDPOINT as string);
  } catch {
    return { problem: { badEndpoint: env.R2_ENDPOINT as string } };
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    return { problem: { badEndpoint: env.R2_ENDPOINT as string } };
  }

  return {
    store: {
      endpoint,
      bucket: env.R2_BUCKET as string,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
        // R2 has one region and calls it `auto`. Every other implementation
        // wants its own, and the value is part of the signature, so it is a
        // variable with a default rather than a constant.
        region: env.R2_REGION ?? "auto",
        service: "s3",
      },
    },
  };
}

let resolved: ObjectStore | null | undefined;

/**
 * This process's bucket, or null when recordings stay in Postgres.
 *
 * Memoised, because it is read on every save and every playback and the answer
 * cannot change without a restart. The complaint about a half-configured bucket
 * is printed once, on the first call, for the same reason.
 */
export function objectStore(): ObjectStore | null {
  if (resolved !== undefined) return resolved;

  const result = readStorageConfig(process.env);
  if ("store" in result) {
    resolved = result.store;
  } else if ("off" in result) {
    resolved = null;
  } else {
    resolved = null;
    const p = result.problem;
    console.warn(
      "missing" in p
        ? `recording object storage is half-configured and therefore off: ${p.missing.join(", ")} ` +
            "not set. Recordings will be stored in Postgres. Set all four, or none."
        : `recording object storage is off: R2_ENDPOINT is not a usable URL (${p.badEndpoint}). ` +
            "It is the S3 API endpoint, e.g. https://<account>.r2.cloudflarestorage.com.",
    );
  }
  return resolved;
}

/** Test seam. Nothing in the app calls this. */
export function resetObjectStoreCache(): void {
  resolved = undefined;
}

/* ---------------------------------------------------------------------- keys */

export function recordingKey(userId: string, recordingId: string): string {
  return `rec/${userId}/${recordingId}`;
}

export function shareKey(userId: string, shareId: string): string {
  return `share/${userId}/${shareId}`;
}

/**
 * Everything one account can have put in the bucket.
 *
 * Both prefixes, because an account's shares are a second copy of the bytes
 * under a different key, and a purge that forgot one would leave exactly the
 * data a share exists to hand to strangers.
 */
export function accountPrefixes(userId: string): string[] {
  return [`rec/${userId}/`, `share/${userId}/`];
}

/* ------------------------------------------------------------------ requests */

export class ObjectStoreError extends Error {
  readonly status: number;

  constructor(operation: string, status: number, detail: string) {
    super(`${operation} failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "ObjectStoreError";
    this.status = status;
  }
}

/**
 * Path-style addressing: `<endpoint>/<bucket>/<key>`.
 *
 * Virtual-hosted style would put the bucket in the hostname, which R2 supports
 * and MinIO does not without DNS games. Path-style works on both and on
 * everything else, and the bucket name is not a secret that benefits from being
 * anywhere in particular.
 */
function urlFor(store: ObjectStore, key: string, query?: Record<string, string>): { url: string; path: string } {
  const path = `/${store.bucket}${encodePath(key)}`;
  const search = query
    ? `?${Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")}`
    : "";
  return { url: `${store.endpoint.origin}${path}${search}`, path };
}

async function send(
  store: ObjectStore,
  operation: string,
  method: string,
  key: string,
  options: { query?: Record<string, string>; body?: Buffer; contentType?: string } = {},
): Promise<Response> {
  const body = options.body ?? Buffer.alloc(0);
  const { url, path } = urlFor(store, key, options.query);

  const headers: Record<string, string> = { host: store.endpoint.host };
  if (options.contentType) headers["content-type"] = options.contentType;
  if (body.length > 0) headers["content-length"] = String(body.length);

  const signed = signRequest(
    { method, path, query: options.query, headers, body },
    store.credentials,
    new Date(),
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: signed,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
      // The bucket is a backing store, not an upstream to be cached in front of.
      cache: "no-store",
    });
  } catch (e) {
    // A DNS failure, a refused connection, a TLS error. Status 0 says "the
    // request never got an answer", which callers distinguish from a 404.
    throw new ObjectStoreError(operation, 0, e instanceof Error ? e.message : "unreachable");
  }
  return response;
}

/** The first line of an S3 error, for a log. Never the whole XML. */
async function detailOf(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const code = /<Code>([^<]{0,64})<\/Code>/.exec(text);
    return code ? code[1] : "";
  } catch {
    return "";
  }
}

export async function putObject(
  store: ObjectStore,
  key: string,
  body: Buffer,
  contentType = "application/octet-stream",
): Promise<void> {
  const response = await send(store, "put", "PUT", key, { body, contentType });
  if (!response.ok) throw new ObjectStoreError("put", response.status, await detailOf(response));
  // The body is drained rather than left dangling: an unread response keeps the
  // socket out of the pool until it is collected, and this runs on every save.
  await response.arrayBuffer();
}

/**
 * Fetches an object, or null if the bucket does not have it.
 *
 * A missing object is a real state rather than an error — it is what a row
 * whose object was deleted out from under it looks like — so it is returned
 * rather than thrown, and the route turns it into a readable 404 instead of a
 * 500 that says nothing.
 */
export async function getObject(store: ObjectStore, key: string): Promise<Buffer | null> {
  const response = await send(store, "get", "GET", key);
  if (response.status === 404) {
    await response.arrayBuffer();
    return null;
  }
  if (!response.ok) throw new ObjectStoreError("get", response.status, await detailOf(response));
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Deletes an object. Succeeds when there was nothing there.
 *
 * S3 answers 204 for a delete of a key that does not exist, and that is the
 * right answer for every caller here: "make sure this is gone" is idempotent,
 * and a retry after a half-failed delete must not fail on the objects the first
 * attempt got to.
 */
export async function deleteObject(store: ObjectStore, key: string): Promise<void> {
  const response = await send(store, "delete", "DELETE", key);
  if (!response.ok && response.status !== 404) {
    throw new ObjectStoreError("delete", response.status, await detailOf(response));
  }
  await response.arrayBuffer();
}

/* ------------------------------------------------------------------- listing */

/** XML entities S3 uses in a key. Keys here are uuids, so this is insurance. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Every key under a prefix.
 *
 * ListObjectsV2 answers XML and this reads it with a regular expression, which
 * is a thing to justify rather than hide. The response is a fixed, flat shape
 * from a machine — `<Contents><Key>…</Key>…</Contents>` repeated — with no
 * delimiter in the request and therefore no `CommonPrefixes`, no namespaces to
 * resolve and no mixed content. Pulling in an XML parser to read one repeated
 * element would be a dependency for the app's runtime image, which is the same
 * argument sigv4.ts makes about the AWS SDK.
 *
 * Pagination is followed to the end. A prefix is one account's recordings, so
 * the count is bounded by MAX_ACCOUNT_RECORDING_BYTES over the per-blob
 * minimum; the loop exists because "bounded" and "under a thousand" are not the
 * same claim, and a purge that stopped at the first page would leave data
 * behind while reporting success.
 */
export async function listPrefix(store: ObjectStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;

  for (;;) {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;

    // The bucket itself is the resource, so the key is empty and the path is
    // `/<bucket>`.
    const response = await send(store, "list", "GET", "", { query });
    if (!response.ok) throw new ObjectStoreError("list", response.status, await detailOf(response));
    const xml = await response.text();

    for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      keys.push(unescapeXml(match[1]));
    }

    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    if (!truncated || !next) break;
    token = unescapeXml(next[1]);
  }

  return keys;
}

/** How many at a time. Enough to not be slow, few enough to not look like abuse. */
const DELETE_CONCURRENCY = 8;

/**
 * Deletes everything under a prefix, and says how much it got.
 *
 * Objects go one request at a time rather than through `DeleteObjects`, whose
 * batch form needs a hand-built XML body and a `Content-MD5` over it. An
 * account holds a few hundred objects at the ceiling — a gigabyte over blobs
 * that are megabytes each — so the batch saves a round trip count that nothing
 * is waiting on: this runs after an account has already been deleted.
 *
 * Failures are collected rather than thrown on the first one, because a purge
 * that stops at the first bad object leaves more behind than one that carries
 * on. The caller decides what a partial purge means; here it is reported.
 */
export async function deletePrefix(
  store: ObjectStore,
  prefix: string,
): Promise<{ deleted: number; failed: number }> {
  const keys = await listPrefix(store, prefix);
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    const batch = keys.slice(i, i + DELETE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((key) => deleteObject(store, key)));
    for (const result of results) {
      if (result.status === "fulfilled") deleted += 1;
      else failed += 1;
    }
  }

  return { deleted, failed };
}
