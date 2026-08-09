import { describe, expect, test } from "bun:test";

import {
  AUDIT_EVENTS,
  CLIENT_REPORTABLE,
  ipPrefix,
  isAuditEventType,
  validateMetadata,
} from "./events";

/**
 * These tests exist to keep a promise. The product claims the audit log records
 * metadata and never content; the allowlist is the only thing enforcing that,
 * so it is tested against the specific ways the claim would be broken.
 */

describe("event types", () => {
  test("only known types are accepted", () => {
    expect(isAuditEventType("connection.opened")).toBe(true);
    expect(isAuditEventType("something.invented")).toBe(false);
    expect(isAuditEventType(42)).toBe(false);
  });

  test("client-reportable is a strict subset", () => {
    expect(CLIENT_REPORTABLE.length).toBeGreaterThan(0);
    expect(CLIENT_REPORTABLE.length).toBeLessThan(Object.keys(AUDIT_EVENTS).length);
    // A tab must never be able to fabricate relay- or server-grade evidence.
    expect(CLIENT_REPORTABLE).not.toContain("connection.opened");
    expect(CLIENT_REPORTABLE).not.toContain("auth.signin");
  });
});

describe("metadata allowlist", () => {
  test("accepts the documented shape", () => {
    const r = validateMetadata("connection.closed", {
      bytesUp: 100,
      bytesDown: 200,
      durationMs: 1500,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ bytesUp: 100, bytesDown: 200, durationMs: 1500 });
  });

  test("rejects unknown keys rather than dropping them", () => {
    // Silently dropping would let a caller believe it was recorded.
    const r = validateMetadata("connection.closed", { bytesUp: 1, command: "rm -rf /" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("command");
  });

  test("refuses the specific things that would break the no-content claim", () => {
    for (const bad of [
      { hostname: "prod-db.internal" },
      { path: "/etc/shadow" },
      { output: "root:x:0:0" },
      { password: "hunter2" },
      { keystrokes: "ls -la" },
    ]) {
      expect(validateMetadata("connection.opened", bad).ok).toBe(false);
    }
  });

  test("rejects a wrong-typed value for an allowed key", () => {
    expect(validateMetadata("connection.closed", { bytesUp: "lots" }).ok).toBe(false);
    expect(validateMetadata("key.installed", { fingerprint: "not-a-fingerprint" }).ok).toBe(false);
  });

  test("accepts a real SHA256 fingerprint", () => {
    const r = validateMetadata("hostkey.pinned", {
      fingerprint: "SHA256:" + "A".repeat(43),
      keyType: "ssh-ed25519",
    });
    expect(r.ok).toBe(true);
  });

  test("caps total size", () => {
    const r = validateMetadata("device.revoked", {
      revokedDeviceId: "x".repeat(4000),
    });
    expect(r.ok).toBe(false);
  });

  test("empty and absent metadata are fine", () => {
    expect(validateMetadata("auth.signout", undefined).ok).toBe(true);
    expect(validateMetadata("auth.signout", null).ok).toBe(true);
    expect(validateMetadata("auth.signout", {}).ok).toBe(true);
  });

  test("arrays are not objects for this purpose", () => {
    expect(validateMetadata("auth.signout", ["scope"]).ok).toBe(false);
  });
});

describe("ipPrefix", () => {
  test("truncates IPv4 to /24", () => {
    expect(ipPrefix("203.0.113.42")).toBe("203.0.113.0/24");
  });

  test("truncates IPv6 to /48", () => {
    expect(ipPrefix("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
  });

  // It used to take the left-most entry of a forwarded chain, which is the part
  // of X-Forwarded-For the caller writes and no proxy overwrites — a forged
  // prefix in every audit row and a chosen key for the recovery rate limiter.
  // Resolving that header needs a trusted hop count and lives in audit/address.
  // A comma arriving here means the raw header was passed by mistake.
  test("refuses a whole forwarded chain rather than trusting its first entry", () => {
    expect(ipPrefix("203.0.113.42, 10.0.0.1")).toBeNull();
  });

  test("never returns a full address", () => {
    for (const ip of ["203.0.113.42", "2001:db8:1234:5678::1"]) {
      expect(ipPrefix(ip)).not.toBe(ip);
    }
  });

  test("handles junk without throwing", () => {
    expect(ipPrefix(null)).toBeNull();
    expect(ipPrefix("")).toBeNull();
    expect(ipPrefix("not-an-ip")).toBeNull();
  });
});
