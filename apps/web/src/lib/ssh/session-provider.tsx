"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { HostKeyMismatchError } from "@/lib/hostkeys";
import { listHosts, type Host } from "@/lib/hosts";
import { listKeys, type SshKey } from "@/lib/keys";
import { connectAndInstallKey, openSession } from "./connect";
import type { HostKeyInfo, SftpHandle, SshSession } from "./types";
import { loadSSH } from "./wasm";
import { getVaultKey } from "@/lib/vault/session";
import { syncVault } from "@/lib/vault/sync";

/**
 * One SSH connection, shared across the whole dashboard.
 *
 * The terminal and the file explorer are separate routes but the same session —
 * that is the entire reason SFTP costs no second login. Holding the session in
 * a provider above the router means navigating from Terminal to Files does not
 * drop the connection, and a long-running command keeps producing output while
 * you are looking at something else.
 *
 * Output is buffered so the terminal can be unmounted and remounted (which is
 * what a route change does) without losing scrollback.
 */

const OUTPUT_BUFFER_BYTES = 512 * 1024;

export type Phase = "loading" | "idle" | "connecting" | "connected";

export interface ConnectRequest {
  hostname: string;
  port: number;
  username: string;
  key: SshKey;
  /** Connect with a password once and let webxterm install the key. */
  password?: string;
}

interface SessionContextValue {
  phase: Phase;
  session: SshSession | null;
  sftp: SftpHandle | null;
  target: { hostname: string; port: number; username: string } | null;

  keys: SshKey[];
  hosts: Host[];
  activeKey: SshKey | null;
  setActiveKey: (key: SshKey) => void;
  refreshKeys: () => Promise<void>;
  refreshHosts: () => Promise<void>;

  connect: (req: ConnectRequest) => Promise<void>;
  disconnect: () => void;

  error: string | null;
  note: string | null;
  pinned: HostKeyInfo | null;
  mismatch: HostKeyMismatchError | null;
  dismissMismatch: () => void;

  /** Terminal I/O. Subscribing replays the buffer so nothing is lost. */
  subscribe: (fn: (bytes: Uint8Array) => void) => () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSshSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSshSession must be used inside <SessionProvider>");
  return ctx;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const sessionRef = useRef<SshSession | null>(null);
  const listeners = useRef(new Set<(b: Uint8Array) => void>());
  const buffer = useRef<Uint8Array[]>([]);
  const bufferedBytes = useRef(0);

  const [phase, setPhase] = useState<Phase>("loading");
  const [sftp, setSftp] = useState<SftpHandle | null>(null);
  const [target, setTarget] = useState<SessionContextValue["target"]>(null);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [activeKey, setActiveKey] = useState<SshKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pinned, setPinned] = useState<HostKeyInfo | null>(null);
  const [mismatch, setMismatch] = useState<HostKeyMismatchError | null>(null);

  const vaultKey = getVaultKey();

  const refreshKeys = useCallback(async () => {
    const k = await listKeys(getVaultKey() ?? undefined);
    setKeys(k);
    setActiveKey((prev) => (prev && k.some((x) => x.id === prev.id) ? prev : (k[0] ?? null)));
  }, []);

  const refreshHosts = useCallback(async () => setHosts(await listHosts()), []);

  useEffect(() => {
    (async () => {
      await loadSSH();
      await Promise.all([refreshKeys(), refreshHosts()]);
      setPhase("idle");
    })().catch((e) => {
      setError(String(e.message ?? e));
      setPhase("idle");
    });
  }, [refreshKeys, refreshHosts]);

  const emit = useCallback((bytes: Uint8Array) => {
    // Keep a bounded tail so a remounted terminal can replay recent output.
    const copy = bytes.slice();
    buffer.current.push(copy);
    bufferedBytes.current += copy.length;
    while (bufferedBytes.current > OUTPUT_BUFFER_BYTES && buffer.current.length > 1) {
      bufferedBytes.current -= buffer.current.shift()!.length;
    }
    for (const fn of listeners.current) fn(copy);
  }, []);

  const subscribe = useCallback((fn: (b: Uint8Array) => void) => {
    for (const chunk of buffer.current) fn(chunk);
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const connect = useCallback(
    async (req: ConnectRequest) => {
      setError(null);
      setMismatch(null);
      setPinned(null);
      setPhase("connecting");
      buffer.current = [];
      bufferedBytes.current = 0;

      const common = {
        hostname: req.hostname,
        port: req.port,
        username: req.username,
        onData: emit,
        onClose: () => {
          setPhase("idle");
          sessionRef.current = null;
          setSftp(null);
          setTarget(null);
        },
        onPinned: setPinned,
      };

      try {
        let s: SshSession;
        if (req.password) {
          const r = await connectAndInstallKey({ ...common, password: req.password, key: req.key });
          s = r.session;
          setNote(
            r.result === "installed"
              ? "Key installed on the server. The password is no longer needed."
              : "That key was already authorized.",
          );
        } else {
          s = await openSession({ ...common, key: req.key });
        }

        sessionRef.current = s;
        setTarget({ hostname: req.hostname, port: req.port, username: req.username });
        setPhase("connected");
        setSftp(await s.sftp());
        await refreshHosts();

        if (vaultKey) {
          void syncVault(vaultKey)
            .then((r) => setNote(`Vault ${r.status} — ${r.hosts} hosts, ${r.keys} keys`))
            .catch((e) => setNote(`Sync failed: ${e.message}`));
        }
      } catch (e) {
        if (e instanceof HostKeyMismatchError) setMismatch(e);
        else setError(String((e as Error).message ?? e));
        setPhase("idle");
        throw e;
      }
    },
    [emit, refreshHosts, vaultKey],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      phase,
      session: sessionRef.current,
      sftp,
      target,
      keys,
      hosts,
      activeKey,
      setActiveKey,
      refreshKeys,
      refreshHosts,
      connect,
      disconnect: () => sessionRef.current?.close(),
      error,
      note,
      pinned,
      mismatch,
      dismissMismatch: () => setMismatch(null),
      subscribe,
      write: (d) => sessionRef.current?.write(d),
      resize: (c, r) => sessionRef.current?.resize(c, r),
    }),
    [
      phase, sftp, target, keys, hosts, activeKey, refreshKeys, refreshHosts,
      connect, error, note, pinned, mismatch, subscribe,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
