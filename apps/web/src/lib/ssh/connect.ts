"use client";

/**
 * Connection orchestration: host key pinning, key auth, password onboarding.
 *
 * The raw WASM `connect` is deliberately dumb about policy. This module owns
 * the decisions — most importantly, that a host key mismatch is a hard failure.
 */

import { getPin, HostKeyMismatchError, pin, touchPin } from "@/lib/hostkeys";
import { authorizedKeysLine, makeSigner, type SshKey } from "@/lib/keys";
import { rememberHost } from "@/lib/hosts";

import { connect as rawConnect, relayUrl } from "./wasm";
import type { HostKeyInfo, SshSession } from "./types";

export interface ConnectOptions {
  hostname: string;
  port: number;
  username: string;
  key?: SshKey;
  password?: string;
  cols?: number;
  rows?: number;
  onData: (bytes: Uint8Array) => void;
  onClose?: (reason: string) => void;
  /** Called on first contact so the UI can show the fingerprint being pinned. */
  onPinned?: (info: HostKeyInfo) => void;
}

export async function openSession(opts: ConnectOptions): Promise<SshSession> {
  const { hostname, port, username } = opts;

  if (!opts.key && !opts.password) {
    throw new Error("Provide a key or a password");
  }

  const known = await getPin(hostname, port);
  let seen: HostKeyInfo | null = null;

  const session = await rawConnect({
    relay: relayUrl(hostname, port),
    host: hostname,
    port,
    user: username,
    cols: opts.cols,
    rows: opts.rows,
    knownHostKey: known?.key,
    auth: opts.key
      ? {
          kind: "publickey",
          keyType: "ed25519",
          publicKey: opts.key.publicKeyRaw,
          sign: makeSigner(opts.key),
        }
      : { kind: "password", password: opts.password! },
    onData: opts.onData,
    onClose: opts.onClose,
    onHostKey: (info) => {
      seen = info;
    },
  }).catch((err: Error) => {
    // The WASM side refuses the handshake on mismatch; translate it into a
    // typed error so the UI can render the warning it deserves rather than a
    // generic connection failure.
    if (seen && (seen as HostKeyInfo).status === "mismatch" && known) {
      throw new HostKeyMismatchError(hostname, port, known, seen);
    }
    throw err;
  });

  // Only pin after the handshake succeeded — pinning a key from a failed
  // connection would let a failed MITM attempt poison the store.
  if (seen && (seen as HostKeyInfo).status === "unknown") {
    const info = seen as HostKeyInfo;
    await pin(hostname, port, {
      key: info.key,
      fingerprint: info.fingerprint,
      type: info.type,
    });
    opts.onPinned?.(info);
  } else {
    await touchPin(hostname, port);
  }

  await rememberHost({ hostname, port, username, keyId: opts.key?.id });
  return session;
}

/**
 * Password-first onboarding.
 *
 * "Copy this command and go run it on your server" is where non-expert users
 * give up. This connects once with a password, installs the public key itself,
 * and hands back a session that is already key-authenticated for next time.
 */
export async function connectAndInstallKey(
  opts: Omit<ConnectOptions, "key"> & { password: string; key: SshKey },
): Promise<{ session: SshSession; result: "installed" | "already-present" }> {
  const session = await openSession({ ...opts, key: undefined, password: opts.password });
  const result = await session.installKey(authorizedKeysLine(opts.key));
  return { session, result };
}
