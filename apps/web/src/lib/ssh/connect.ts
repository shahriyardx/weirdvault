"use client";

/**
 * Connection orchestration: host key pinning, key auth, password onboarding.
 *
 * The raw WASM `connect` is deliberately dumb about policy. This module owns
 * the decisions — most importantly, that a host key mismatch is a hard failure.
 */

import { reportAudit } from "@/lib/audit/client";
import { getPin, HostKeyMismatchError, pin, touchPin } from "@/lib/hostkeys";
import { authorizedKeysLine, makeSigner, type SshKey } from "@/lib/keys";
import { rememberHost } from "@/lib/hosts";
import { getAuditKey } from "@/lib/vault/session";

import { agentRelayUrl, connect as rawConnect, relayUrl } from "./wasm";
import type { HostKeyInfo, SshSession } from "./types";

export interface ConnectOptions {
  hostname: string;
  port: number;
  username: string;
  /**
   * This host *is* an enrolled machine, reached through its own agent.
   *
   * Not a jump host and not a proxy to somewhere else: the agent forwards to
   * sshd on its own loopback, so the far end is that machine. Everything after
   * the WebSocket is identical — same SSH handshake, same key, same host key
   * verification — and a compromised agent still cannot present a different
   * host key without the mismatch below catching it.
   *
   * `hostname` is a display label when this is set, which is why the pin is
   * keyed separately; see pinKeyFor.
   */
  agentId?: string;
  key?: SshKey;
  password?: string;
  cols?: number;
  rows?: number;
  onData: (bytes: Uint8Array) => void;
  onClose?: (reason: string) => void;
  /** Called on first contact so the UI can show the fingerprint being pinned. */
  onPinned?: (info: HostKeyInfo) => void;
  /** Add this host to the saved list. Off by default. */
  save?: boolean;
}

/**
 * What a host key is pinned against.
 *
 * For an ordinary host that is the address, because the address is what
 * identifies the machine. For an agent host there is no address — `hostname` is
 * a label the user typed and can rename at will — so the pin is keyed on the
 * agent instead. Keying it on the label would mean renaming a machine silently
 * discarded its pinned key and re-pinned whatever answered next, which is a
 * mismatch warning that never fires: exactly the case pinning exists to catch.
 */
function pinKeyFor(opts: Pick<ConnectOptions, "hostname" | "agentId">): string {
  return opts.agentId ? `agent:${opts.agentId}` : opts.hostname;
}

export async function openSession(opts: ConnectOptions): Promise<SshSession> {
  const { hostname, port, username } = opts;
  const pinKey = pinKeyFor(opts);

  if (!opts.key && !opts.password) {
    throw new Error("Provide a key or a password");
  }

  const known = await getPin(pinKey, port);
  let seen: HostKeyInfo | null = null;

  const session = await rawConnect({
    relay: opts.agentId
      ? await agentRelayUrl(opts.agentId, port)
      : await relayUrl(hostname, port),
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
      const info = seen as HostKeyInfo;
      void reportAudit("hostkey.mismatch", {
        target: { host: hostname, port },
        auditKey: getAuditKey(),
        metadata: { expected: known.fingerprint, presented: info.fingerprint },
      });
      throw new HostKeyMismatchError(hostname, port, known, info);
    }
    throw err;
  });

  // Only pin after the handshake succeeded — pinning a key from a failed
  // connection would let a failed MITM attempt poison the store.
  if (seen && (seen as HostKeyInfo).status === "unknown") {
    const info = seen as HostKeyInfo;
    await pin(pinKey, port, {
      key: info.key,
      fingerprint: info.fingerprint,
      type: info.type,
    });
    void reportAudit("hostkey.pinned", {
      target: { host: hostname, port },
      auditKey: getAuditKey(),
      metadata: { fingerprint: info.fingerprint, keyType: info.type },
    });
    opts.onPinned?.(info);
  } else {
    await touchPin(pinKey, port);
  }

  await rememberHost(
    {
      hostname,
      port,
      username,
      keyId: opts.key?.id,
      agentId: opts.agentId,
      // Record how this connection actually authenticated, so the saved host
      // asks for the same thing next time instead of guessing.
      auth: opts.key ? "key" : "password",
    },
    { create: opts.save },
  );
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

  // The handshake was a password one, but the point of it was to stop needing
  // passwords. Correct the saved record so the next connection reaches for the
  // key we just installed.
  await rememberHost({
    hostname: opts.hostname,
    port: opts.port,
    username: opts.username,
    keyId: opts.key.id,
    // Carried through, or this write would blank it. rememberHost spreads these
    // fields over the existing record, so omitting agentId on a machine that has
    // one turns it back into an address host — and the next connection would try
    // to dial a label that is not a hostname.
    agentId: opts.agentId,
    auth: "key",
  });

  void reportAudit("key.installed", {
    target: { host: opts.hostname, port: opts.port },
    auditKey: getAuditKey(),
    // The key id and result, never the authorized_keys line itself — its
    // comment is user-chosen free text.
    metadata: { keyId: opts.key.id, result },
  });

  return { session, result };
}
