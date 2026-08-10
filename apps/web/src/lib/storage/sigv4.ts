import { createHash, createHmac } from "node:crypto"

/**
 * AWS Signature Version 4, for the five S3 calls this app makes.
 *
 * Written out rather than pulled in, and the reason is proportion. `@aws-sdk/
 * client-s3` is a hundred and some packages and tens of megabytes to sign five
 * requests — PUT, GET, DELETE, ListObjectsV2 and the batch delete — none of
 * which use multipart, streaming, retries with adaptive backoff, or any of the
 * surface that makes the SDK worth its size elsewhere. The web image is Next's
 * standalone output and it ships whatever the app imports, so the cost is paid
 * on every deploy and every cold start.
 *
 * The trade is that a subtle signing bug here fails as a 403 from the bucket
 * rather than as a type error, so this module is arranged to be checkable:
 * everything below is a pure function of its arguments, `canonicalRequest` and
 * `signingKey` are exported for their own sake rather than because anything else
 * calls them, and sigv4.test.ts pins them against AWS's published vectors. The
 * end-to-end check is a real S3 server — see the note in objects.test.ts.
 *
 * Only the header-signed form is implemented. Presigned URLs are deliberately
 * absent: docs/TODO.md sets out why recordings and shares proxy through the
 * route instead, and the short version is that a presigned URL is a second
 * thing that grants access, valid for its whole lifetime to whoever ends up
 * holding it, and — for shares — one that has never heard of `revoked_at`. Not
 * having the function is how that stays decided.
 */

/** The scope suffix, fixed by the algorithm. */
const TERMINATOR = "aws4_request"
const ALGORITHM = "AWS4-HMAC-SHA256"

export interface SigningCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: string
}

export interface SignableRequest {
  method: string
  /** Already-encoded path, beginning with `/`. See `encodePath`. */
  path: string
  /** Query parameters, unencoded. Encoded and sorted here. */
  query?: Record<string, string>
  /** Header values by lowercase name. `host` is required; the rest are added. */
  headers: Record<string, string>
  /** The exact bytes of the body. Empty for GET and DELETE. */
  body: Buffer
}

/* ------------------------------------------------------------------ encoding */

/**
 * The percent-encoding AWS specifies, which is not the one JavaScript has.
 *
 * `encodeURIComponent` leaves `!'()*` alone, and those are exactly the
 * characters that turn a working signature into a 403 the first time somebody's
 * object key contains one. The unreserved set is spelled out here instead —
 * A-Z, a-z, 0-9, `-`, `_`, `.`, `~` — and everything else becomes uppercase
 * percent-hex over its UTF-8 bytes.
 *
 * Object keys in this app are `rec/<uuid>/<uuid>`, so none of this is reachable
 * today. It is written correctly anyway, because the day a key gains a segment
 * from user input is not the day to discover the encoder was approximate.
 */
export function encodeRfc3986(value: string): string {
  let out = ""
  for (const byte of Buffer.from(value, "utf8")) {
    const c = String.fromCharCode(byte)
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      c === "-" ||
      c === "_" ||
      c === "." ||
      c === "~"
    ) {
      out += c
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

/**
 * An object key as a canonical URI path.
 *
 * Each segment is encoded and the separators are not, because S3 keys are flat
 * strings in which `/` happens to be conventional — `rec/a/b` is one key, and
 * the signature has to agree with the URL about where the slashes are. S3 also
 * does not normalise the path before signing (unlike every other AWS service),
 * so what is signed is what is sent, verbatim.
 */
export function encodePath(key: string): string {
  return `/${key.split("/").map(encodeRfc3986).join("/")}`
}

function canonicalQuery(query: Record<string, string> | undefined): string {
  if (!query) return ""
  return (
    Object.entries(query)
      .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
      // Sorted by encoded name, which is what the specification says and is not
      // the same order as sorting the raw names once anything non-alphanumeric is
      // involved.
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&")
  )
}

/* ------------------------------------------------------------------- hashing */

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest()
}

/**
 * The four-step key derivation. Exported because it is the half of SigV4 with a
 * published test vector that does not depend on a request at all, which makes
 * it the cheapest thing to be sure of.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, TERMINATOR)
}

/* ----------------------------------------------------------------- canonical */

export interface Canonical {
  request: string
  signedHeaders: string
}

/**
 * The canonical request, and the header list that goes with it.
 *
 * Header values are trimmed but not otherwise folded. The specification asks
 * for sequential inner whitespace to be collapsed as well; every header this
 * app sends is a token, a hex digest or a timestamp, so there is no inner
 * whitespace to collapse and implementing that rule would be untested code on a
 * path where being wrong is a 403.
 */
export function canonicalRequest(req: SignableRequest, payloadHash: string): Canonical {
  const names = Object.keys(req.headers)
    .map((n) => n.toLowerCase())
    .sort()

  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) lower[k.toLowerCase()] = v.trim()

  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("")
  const signedHeaders = names.join(";")

  return {
    request: [
      req.method.toUpperCase(),
      req.path,
      canonicalQuery(req.query),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n"),
    signedHeaders,
  }
}

/* -------------------------------------------------------------------- signing */

/** `20250810T134500Z` and `20250810`, the two forms the algorithm wants. */
export function timestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/**
 * Signs a request, returning the headers to send with it.
 *
 * The returned object includes the caller's own headers, so the result is the
 * complete set: adding one afterwards would not be signed, and an unsigned
 * header on an S3 request is either ignored or — for anything beginning
 * `x-amz-` — a 403 for a signature that does not cover it.
 *
 * `x-amz-content-sha256` is always sent. S3 requires it, and it is the thing
 * that makes the body part of the signature rather than an attachment to it.
 */
export function signRequest(
  req: SignableRequest,
  creds: SigningCredentials,
  now: Date,
): Record<string, string> {
  const { amzDate, dateStamp } = timestamps(now)
  const payloadHash = sha256Hex(req.body)

  const headers: Record<string, string> = {
    ...req.headers,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  }

  const { request, signedHeaders } = canonicalRequest({ ...req, headers }, payloadHash)

  const scope = `${dateStamp}/${creds.region}/${creds.service}/${TERMINATOR}`
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(request)].join("\n")
  const signature = hmac(
    signingKey(creds.secretAccessKey, dateStamp, creds.region, creds.service),
    stringToSign,
  ).toString("hex")

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
