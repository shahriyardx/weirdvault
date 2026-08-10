import { describe, expect, test } from "bun:test";

import {
  encodeRfc3986 as sweepEncode,
  signRequest as sweepSign,
} from "../../../scripts/sweep-recordings.mjs";
import { encodeRfc3986, signRequest, type SignableRequest } from "./sigv4";

/**
 * Two implementations of one algorithm, kept honest against each other.
 *
 * `scripts/sweep-recordings.mjs` signs its own requests rather than importing
 * this module, and that is not laziness — the runtime image is Next's
 * standalone output, which contains no TypeScript and traces only what the app
 * imports, so a script that has to run inside it cannot reach into `src/`. The
 * same constraint already produced the duplicated retention windows in
 * prune-audit.mjs, and the same answer applies: if the copy cannot be removed,
 * it can at least be prevented from drifting.
 *
 * Drift here is worse than drift there. A wrong retention window deletes rows a
 * reader was already hiding; a wrong signature is a 403 that only appears on an
 * operator's machine, at whatever hour they finally set up the cron, with an
 * error message that says nothing about which of six steps disagreed. So the
 * two are made to sign the same requests and produce byte-identical
 * Authorization headers, over a set of cases chosen to reach every step:
 * headers, query strings, a body, and a key that needs encoding.
 *
 * If this fails, one of the two files changed. The fix is to look at both.
 */

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "auto",
  service: "s3",
};

const NOW = new Date("2025-08-10T13:45:00.123Z");

const CASES: { name: string; req: SignableRequest }[] = [
  {
    name: "a GET of an object",
    req: {
      method: "GET",
      path: "/bucket/rec/user-1/rec-2",
      headers: { host: "abc.r2.cloudflarestorage.com" },
      body: Buffer.alloc(0),
    },
  },
  {
    name: "a PUT with a body and a content type",
    req: {
      method: "PUT",
      path: "/bucket/rec/user-1/rec-2",
      headers: {
        host: "abc.r2.cloudflarestorage.com",
        "content-type": "application/octet-stream",
        "content-length": "9",
      },
      body: Buffer.from("ciphertxt"),
    },
  },
  {
    name: "a DELETE",
    req: {
      method: "DELETE",
      path: "/bucket/share/user-1/share-2",
      headers: { host: "abc.r2.cloudflarestorage.com" },
      body: Buffer.alloc(0),
    },
  },
  {
    name: "a listing, which is the only call with a query string",
    req: {
      method: "GET",
      path: "/bucket/",
      query: { "list-type": "2", prefix: "rec/", "max-keys": "1000" },
      headers: { host: "abc.r2.cloudflarestorage.com" },
      body: Buffer.alloc(0),
    },
  },
  {
    name: "a listing carrying a continuation token, which needs encoding",
    req: {
      method: "GET",
      path: "/bucket/",
      query: {
        "list-type": "2",
        prefix: "share/",
        "max-keys": "1000",
        "continuation-token": "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=",
      },
      headers: { host: "abc.r2.cloudflarestorage.com" },
      body: Buffer.alloc(0),
    },
  },
];

describe("the sweep script signs identically to the app", () => {
  for (const { name, req } of CASES) {
    test(name, () => {
      const app = signRequest(req, CREDS, NOW);
      const sweep = sweepSign(req, CREDS, NOW) as Record<string, string>;

      expect(sweep.authorization).toBe(app.authorization);
      expect(sweep["x-amz-content-sha256"]).toBe(app["x-amz-content-sha256"]);
      expect(sweep["x-amz-date"]).toBe(app["x-amz-date"]);
    });
  }

  test("and percent-encodes identically, which is what the paths are built from", () => {
    for (const value of ["rec", "user-1", "a b", "é", "!'()*", "1ueGcx/XYE+hb=", "~-_."]) {
      expect(sweepEncode(value)).toBe(encodeRfc3986(value));
    }
  });

  /**
   * A guard against the test passing for the wrong reason. If the two functions
   * ever became the same object — an accidental re-export, a bundler alias —
   * every assertion above would hold while proving nothing.
   */
  test("and they really are two functions", () => {
    expect(sweepSign).not.toBe(signRequest);
  });
});
