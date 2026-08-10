import { describe, expect, test } from "bun:test"

import {
  accountPrefixes,
  deleteObject,
  deletePrefix,
  getObject,
  listPrefix,
  putObject,
  readStorageConfig,
  recordingKey,
  shareKey,
  type ObjectStore,
} from "./objects"
import { signRequest } from "./sigv4"

/**
 * Two halves, and the second one is the one that matters.
 *
 * Configuration and key shapes are checked here in the ordinary way. The client
 * itself cannot be: a mock that answers the requests this module makes would be
 * written from the same understanding of S3 that produced the module, so it
 * would agree with a wrong signature as readily as a right one. The only test
 * that means anything is a real server that rejects a bad signature with a 403.
 *
 * So the second half runs against an actual S3 implementation and skips when
 * there is not one. MinIO is enough — it verifies SigV4 strictly, which is the
 * property under test — and it is one container:
 *
 *   docker run -d --name webxterm-minio -p 9000:9000 \
 *     -e MINIO_ROOT_USER=webxtermtest -e MINIO_ROOT_PASSWORD=webxtermtestsecret \
 *     minio/minio server /data
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000 bun test
 *
 * Skipped rather than failed when it is absent, because `bun test` has to pass
 * on a laptop with no Docker running. The trade is that a green run does not on
 * its own prove the bucket path works — which is why sigv4.test.ts pins the
 * algorithm against published vectors independently of any server.
 */

/* -------------------------------------------------------------------- config */

const FULL = {
  R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  R2_BUCKET: "webxterm-recordings",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
}

describe("configuration", () => {
  test("nothing set means recordings stay in Postgres", () => {
    expect(readStorageConfig({})).toEqual({ off: true })
    // Empty strings are how a .env file spells "not set", and env_file offers no
    // way to say it any other way — so they must read as absent rather than as
    // a bucket named "".
    expect(readStorageConfig({ R2_ENDPOINT: "", R2_BUCKET: "" })).toEqual({ off: true })
  })

  test("everything set gives a store", () => {
    const result = readStorageConfig(FULL)
    expect("store" in result).toBe(true)
    if (!("store" in result)) return
    expect(result.store.bucket).toBe("webxterm-recordings")
    expect(result.store.endpoint.host).toBe("abc123.r2.cloudflarestorage.com")
    expect(result.store.credentials.service).toBe("s3")
  })

  test("R2 has one region and it is not one anybody would guess", () => {
    const result = readStorageConfig(FULL)
    if (!("store" in result)) throw new Error("expected a store")
    expect(result.store.credentials.region).toBe("auto")

    const elsewhere = readStorageConfig({ ...FULL, R2_REGION: "us-east-1" })
    if (!("store" in elsewhere)) throw new Error("expected a store")
    expect(elsewhere.store.credentials.region).toBe("us-east-1")
  })

  /**
   * The case this whole `StorageProblem` type exists for. Three of four set is
   * somebody who edited .env and missed a line, and reading it as "storage is
   * off" would put recordings in Postgres on a deployment whose operator is
   * certain they are in a bucket — which is only discovered when the disk fills.
   */
  test("a half-filled configuration names what is missing rather than going quiet", () => {
    const result = readStorageConfig({ ...FULL, R2_SECRET_ACCESS_KEY: "" })
    expect(result).toEqual({ problem: { missing: ["R2_SECRET_ACCESS_KEY"] } })
  })

  test("an endpoint that is not a URL is a problem, not a store", () => {
    expect(readStorageConfig({ ...FULL, R2_ENDPOINT: "abc123.r2.cloudflarestorage.com" })).toEqual({
      problem: { badEndpoint: "abc123.r2.cloudflarestorage.com" },
    })
    // A bucket name in the endpoint slot, or an s3:// URI, are the two plausible
    // mistakes; both parse as *something*, so the protocol is checked.
    expect(readStorageConfig({ ...FULL, R2_ENDPOINT: "s3://bucket" })).toEqual({
      problem: { badEndpoint: "s3://bucket" },
    })
  })
})

/* ---------------------------------------------------------------------- keys */

describe("object keys", () => {
  test("the account is the first thing after the kind, so a prefix is a purge", () => {
    expect(recordingKey("user-1", "rec-2")).toBe("rec/user-1/rec-2")
    expect(shareKey("user-1", "share-2")).toBe("share/user-1/share-2")
    expect(accountPrefixes("user-1")).toEqual(["rec/user-1/", "share/user-1/"])
  })

  /**
   * A share is a second copy of the transcript under its own key, so a purge
   * that swept only `rec/` would leave behind precisely the copies made to be
   * handed to strangers.
   */
  test("both copies are covered by the account prefixes", () => {
    const prefixes = accountPrefixes("user-1")
    expect(recordingKey("user-1", "r").startsWith(prefixes[0])).toBe(true)
    expect(shareKey("user-1", "s").startsWith(prefixes[1])).toBe(true)
  })

  test("one account's prefix cannot match another's keys", () => {
    // Ids come from crypto.randomUUID and Better Auth, so neither is a prefix of
    // the other in practice — but the trailing slash is what makes that true by
    // construction rather than by luck.
    const [rec] = accountPrefixes("user-1")
    expect(recordingKey("user-12", "r").startsWith(rec)).toBe(false)
  })
})

/* ------------------------------------------------------------ the real thing */

const endpoint = process.env.TEST_S3_ENDPOINT
const live = endpoint ? describe : describe.skip

live("against a real S3 server", () => {
  const store: ObjectStore = {
    endpoint: new URL(endpoint ?? "http://127.0.0.1:9000"),
    bucket: process.env.TEST_S3_BUCKET ?? "webxterm-test",
    credentials: {
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "webxtermtest",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "webxtermtestsecret",
      region: process.env.TEST_S3_REGION ?? "us-east-1",
      service: "s3",
    },
  }

  /** Creating the bucket is not part of the client, so it is signed by hand. */
  async function ensureBucket() {
    const path = `/${store.bucket}`
    const headers = signRequest(
      { method: "PUT", path, headers: { host: store.endpoint.host }, body: Buffer.alloc(0) },
      store.credentials,
      new Date(),
    )
    const res = await fetch(`${store.endpoint.origin}${path}`, { method: "PUT", headers })
    // 409 is "you already own it", which is the ordinary case on a second run.
    if (!res.ok && res.status !== 409) throw new Error(`could not create bucket: ${res.status}`)
    await res.arrayBuffer()
  }

  const prefix = `test/${crypto.randomUUID()}/`

  test("a signature a real server accepts, and bytes that survive the round trip", async () => {
    await ensureBucket()

    // Non-ASCII on purpose: the envelope is base64 JSON today, and the day it
    // is not is the day a naive length-versus-bytes bug appears.
    const body = Buffer.from('{"iv":"AAA","ct":"héllo"}', "utf8")
    await putObject(store, `${prefix}one`, body)

    const got = await getObject(store, `${prefix}one`)
    expect(got).not.toBeNull()
    expect(got?.equals(body)).toBe(true)
  })

  test("a missing object is null rather than a throw", async () => {
    await ensureBucket()
    expect(await getObject(store, `${prefix}never-written`)).toBeNull()
  })

  test("deleting is idempotent, so a retry after a half-failure is safe", async () => {
    await ensureBucket()
    await putObject(store, `${prefix}twice`, Buffer.from("x"))
    await deleteObject(store, `${prefix}twice`)
    await deleteObject(store, `${prefix}twice`)
    expect(await getObject(store, `${prefix}twice`)).toBeNull()
  })

  test("a prefix purge takes everything under it and nothing beside it", async () => {
    await ensureBucket()
    await putObject(store, `${prefix}keep/a`, Buffer.from("a"))
    await putObject(store, `${prefix}drop/b`, Buffer.from("b"))
    await putObject(store, `${prefix}drop/c`, Buffer.from("c"))

    expect((await listPrefix(store, `${prefix}drop/`)).sort()).toEqual([
      `${prefix}drop/b`,
      `${prefix}drop/c`,
    ])

    expect(await deletePrefix(store, `${prefix}drop/`)).toEqual({ deleted: 2, failed: 0 })
    expect(await listPrefix(store, `${prefix}drop/`)).toEqual([])
    expect(await listPrefix(store, `${prefix}keep/`)).toEqual([`${prefix}keep/a`])

    await deletePrefix(store, prefix)
  })

  /**
   * ListObjectsV2 caps a page at a thousand keys, and a purge that stopped
   * there would leave data behind while reporting success. Slow — 1200 objects
   * — and worth it exactly once, because the pagination loop has no other way
   * to be exercised.
   */
  test("listing follows the continuation token past one page", async () => {
    await ensureBucket()
    const page = `${prefix}page/`
    const keys = Array.from({ length: 1200 }, (_, i) => `${page}${String(i).padStart(4, "0")}`)
    for (let i = 0; i < keys.length; i += 32) {
      await Promise.all(keys.slice(i, i + 32).map((k) => putObject(store, k, Buffer.from(k))))
    }

    expect((await listPrefix(store, page)).length).toBe(1200)
    expect(await deletePrefix(store, page)).toEqual({ deleted: 1200, failed: 0 })
  }, 120_000)
})
