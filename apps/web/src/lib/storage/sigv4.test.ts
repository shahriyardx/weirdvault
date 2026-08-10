import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  canonicalRequest,
  encodePath,
  encodeRfc3986,
  sha256Hex,
  signRequest,
  signingKey,
  timestamps,
} from "./sigv4";

/**
 * A signing bug here does not fail as a type error or a crash. It fails as a
 * 403 from a bucket, at the end of somebody's hour-long session, with a message
 * that says nothing about which of the six steps went wrong. So the algorithm
 * is pinned against AWS's own published vectors rather than against a
 * round-trip through this same code, which would pass just as happily with the
 * newlines in the wrong order.
 *
 * Three vectors, chosen because between them they cover every step:
 *
 *  - The key derivation example from "Examples of How to Derive a Signing Key"
 *    exercises the four chained HMACs and nothing else, so a failure there is
 *    unambiguous.
 *  - `get-vanilla` from the SigV4 test suite covers canonicalisation, the
 *    string to sign and the final HMAC together.
 *  - `get-vanilla-query-order-key-case` covers the query string, whose sort is
 *    over the *encoded* names and is the rule most implementations get wrong.
 *
 * The suite signs only `host` and `x-amz-date`, while `signRequest` always adds
 * `x-amz-content-sha256` because S3 requires it. That is why the two vectors
 * below drive `canonicalRequest` and `signingKey` directly rather than
 * `signRequest`: pinning the published number matters more than going through
 * the front door, and `signRequest` has its own test underneath that composes
 * the same pieces.
 *
 * What no vector can prove is that a real bucket agrees. That check is
 * objects.test.ts, which runs against an actual S3 server when one is pointed
 * at it.
 */

const SUITE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
};

/** The suite's own signing step, so a vector's published signature is reachable. */
function suiteSignature(canonical: string): string {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    "20150830T123600Z",
    "20150830/us-east-1/service/aws4_request",
    sha256Hex(canonical),
  ].join("\n");
  return createHmac(
    "sha256",
    signingKey(SUITE.secretAccessKey, "20150830", SUITE.region, SUITE.service),
  )
    .update(stringToSign, "utf8")
    .digest("hex");
}

describe("signing key derivation", () => {
  test("matches the AWS documentation example", () => {
    expect(
      signingKey(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "20120215",
        "us-east-1",
        "iam",
      ).toString("hex"),
    ).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });

  test("the scope is part of the key, so a wrong region cannot sign", () => {
    const east = signingKey(SUITE.secretAccessKey, "20150830", "us-east-1", "s3");
    const auto = signingKey(SUITE.secretAccessKey, "20150830", "auto", "s3");
    expect(east.equals(auto)).toBe(false);
  });
});

describe("AWS SigV4 test suite", () => {
  test("get-vanilla", () => {
    const { request, signedHeaders } = canonicalRequest(
      {
        method: "GET",
        path: "/",
        headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
        body: Buffer.alloc(0),
      },
      sha256Hex(Buffer.alloc(0)),
    );

    expect(signedHeaders).toBe("host;x-amz-date");
    expect(request).toBe(
      "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\n" +
        "host;x-amz-date\n" +
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(suiteSignature(request)).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("get-vanilla-query-order-key-case sorts by the encoded name", () => {
    // Passed out of order on purpose: the vector's whole point is that the
    // canonical form is sorted rather than as-supplied.
    const { request } = canonicalRequest(
      {
        method: "GET",
        path: "/",
        query: { Param2: "value2", Param1: "value1" },
        headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
        body: Buffer.alloc(0),
      },
      sha256Hex(Buffer.alloc(0)),
    );

    expect(request.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(suiteSignature(request)).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });
});

describe("percent-encoding", () => {
  test("encodes what encodeURIComponent leaves alone", () => {
    // These five are the entire difference between the two, and they are the
    // reason this function exists rather than a one-line delegation.
    expect(encodeRfc3986("!'()*")).toBe("%21%27%28%29%2A");
    expect(encodeURIComponent("!'()*")).toBe("!'()*");
  });

  test("leaves the unreserved set alone", () => {
    expect(encodeRfc3986("aZ09-_.~")).toBe("aZ09-_.~");
  });

  test("encodes over UTF-8 bytes, not code units", () => {
    expect(encodeRfc3986("é")).toBe("%C3%A9");
    expect(encodeRfc3986(" ")).toBe("%20");
    expect(encodeRfc3986("/")).toBe("%2F");
  });

  test("a path keeps its separators and encodes each segment", () => {
    expect(encodePath("rec/user-1/rec-2")).toBe("/rec/user-1/rec-2");
    // The separator survives; the space inside a segment does not.
    expect(encodePath("rec/a b/c")).toBe("/rec/a%20b/c");
  });
});

describe("signRequest", () => {
  const now = new Date("2025-08-10T13:45:00.123Z");

  test("always signs the payload hash, because S3 requires it", () => {
    const headers = signRequest(
      {
        method: "GET",
        path: "/bucket/key",
        headers: { host: "s3.example.com" },
        body: Buffer.alloc(0),
      },
      { ...SUITE, service: "s3" },
      now,
    );

    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(headers.authorization).toContain(
      "Credential=AKIDEXAMPLE/20250810/us-east-1/s3/aws4_request",
    );
  });

  test("the body is covered, so a changed byte changes the signature", () => {
    const sign = (body: Buffer) =>
      signRequest(
        { method: "PUT", path: "/bucket/key", headers: { host: "s3.example.com" }, body },
        { ...SUITE, service: "s3" },
        now,
      ).authorization;

    expect(sign(Buffer.from("payload"))).not.toBe(sign(Buffer.from("payloae")));
  });

  test("the caller's headers are returned, so nothing can be added unsigned", () => {
    const headers = signRequest(
      {
        method: "PUT",
        path: "/bucket/key",
        headers: { host: "s3.example.com", "content-type": "application/octet-stream" },
        body: Buffer.from("x"),
      },
      { ...SUITE, service: "s3" },
      now,
    );

    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers.authorization).toContain("SignedHeaders=content-type;host;");
  });

  test("timestamps have no punctuation and no milliseconds", () => {
    expect(timestamps(now)).toEqual({ amzDate: "20250810T134500Z", dateStamp: "20250810" });
  });
});
