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
 * Many concurrent SSH sessions, held above the router.
 *
 * The same host can be opened several times — one shell tailing logs while
 * another runs a deploy is the ordinary way people work, and a client that
 * allows only one connection per host forces them back to a native terminal.
 * Each session is independent: its own PTY, its own SFTP channel, its own
 * output buffer.
 *
 * Buffering per session is what makes navigation free. Routes unmount the
 * terminal component, and without a buffer everything printed while you were
 * looking at the file explorer would be lost.
 */

const OUTPUT_BUFFER_BYTES = 512 * 1024;

export type Phase = "loading" | "idle" | "connecting" | "connected";

export interface SessionTarget {
  hostname: string;
  port: number;
  username: string;
}

export interface SessionEntry {
  id: string;
  target: SessionTarget;
  /** Distinguishes several sessions to the same host: "web #2". */
  label: string;
  sftp: SftpHandle | null;
  openedAt: number;
}

export interface ConnectRequest extends SessionTarget {
  key: SshKey;
  /** Connect with a password once and let webxterm install the key. */
  password?: string;
}

interface LiveSession {
  entry: SessionEntry;
  session: SshSession;
  listeners: Set<(b: Uint8Array) => void>;
  buffer: Uint8Array[];
  bufferedBytes: number;
}

interface SessionContextValue {
  /** Global state: loading the WASM core, or mid-connect. */
  phase: Phase;
  sessions: SessionEntry[];
  activeId: string | null;
  active: SessionEntry | null;
  setActive: (id: string) => void;

  keys: SshKey[];
  hosts: Host[];
  activeKey: SshKey | null;
  setActiveKey: (key: SshKey) => void;
  refreshKeys: () => Promise<void>;
  refreshHosts: () => Promise<void>;

  /** Opens a NEW session; never replaces an existing one. */
  connect: (req: ConnectRequest) => Promise<string>;
  disconnect: (id?: string) => void;

  error: string | null;
  note: string | null;
  pinned: HostKeyInfo | null;
  mismatch: HostKeyMismatchError | null;
  dismissMismatch: () => void;

  /** Terminal I/O, per session. Subscribing replays that session's buffer. */
  subscribe: (id: string, fn: (bytes: Uint8Array) => void) => () => void;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  sftpFor: (id: string) => SftpHandle | null;
  sessionFor: (id: string) => SshSession | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSshSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSshSession must be used inside <SessionProvider>");
  return ctx;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const live = useRef(new Map<string, LiveSession>());

  const [phase, setPhase] = useState<Phase>("loading");
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [activeKey, setActiveKey] = useState<SshKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pinned, setPinned] = useState<HostKeyInfo | null>(null);
  const [mismatch, setMismatch] = useState<HostKeyMismatchError | null>(null);

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

  const syncEntries = useCallback(() => {
    setSessions([...live.current.values()].map((l) => l.entry));
  }, []);

  /** "web", then "web #2" — so two shells on one host stay distinguishable. */
  const labelFor = useCallback((target: SessionTarget) => {
    const base = `${target.username}@${target.hostname}`;
    const existing = [...live.current.values()].filter(
      (l) => `${l.entry.target.username}@${l.entry.target.hostname}` === base,
    ).length;
    return existing === 0 ? base : `${base} #${existing + 1}`;
  }, []);

  const connect = useCallback(
    async (req: ConnectRequest): Promise<string> => {
      setError(null);
      setMismatch(null);
      setPinned(null);
      setPhase("connecting");

      const id = crypto.randomUUID();
      const target: SessionTarget = {
        hostname: req.hostname,
        port: req.port,
        username: req.username,
      };

      const push = (bytes: Uint8Array) => {
        const l = live.current.get(id);
        if (!l) return;
        const copy = bytes.slice();
        l.buffer.push(copy);
        l.bufferedBytes += copy.length;
        while (l.bufferedBytes > OUTPUT_BUFFER_BYTES && l.buffer.length > 1) {
          l.bufferedBytes -= l.buffer.shift()!.length;
        }
        for (const fn of l.listeners) fn(copy);
      };

      const common = {
        ...target,
        onData: push,
        onClose: () => {
          live.current.delete(id);
          syncEntries();
          setActiveId((prev) => (prev === id ? ([...live.current.keys()][0] ?? null) : prev));
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

        const entry: SessionEntry = {
          id,
          target,
          label: labelFor(target),
          sftp: null,
          openedAt: Date.now(),
        };
        live.current.set(id, {
          entry,
          session: s,
          listeners: new Set(),
          buffer: [],
          bufferedBytes: 0,
        });
        setActiveId(id);
        syncEntries();
        setPhase("idle");

        // SFTP rides the same connection, so open it eagerly — the file
        // explorer should be usable the moment the shell is.
        void s.sftp().then((handle) => {
          const l = live.current.get(id);
          if (!l) return;
          l.entry = { ...l.entry, sftp: handle };
          syncEntries();
        });

        await refreshHosts();

        const vaultKey = getVaultKey();
        if (vaultKey) {
          void syncVault(vaultKey)
            .then((r) => setNote(`Vault ${r.status} — ${r.hosts} hosts, ${r.keys} keys`))
            .catch((e) => setNote(`Sync failed: ${e.message}`));
        }
        return id;
      } catch (e) {
        if (e instanceof HostKeyMismatchError) setMismatch(e);
        else setError(String((e as Error).message ?? e));
        setPhase("idle");
        throw e;
      }
    },
    [labelFor, refreshHosts, syncEntries],
  );

  const disconnect = useCallback(
    (id?: string) => {
      const target = id ?? activeId;
      if (!target) return;
      live.current.get(target)?.session.close();
    },
    [activeId],
  );

  const subscribe = useCallback((id: string, fn: (b: Uint8Array) => void) => {
    const l = live.current.get(id);
    if (!l) return () => {};
    for (const chunk of l.buffer) fn(chunk);
    l.listeners.add(fn);
    return () => {
      l.listeners.delete(fn);
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      phase,
      sessions,
      activeId,
      active: sessions.find((s) => s.id === activeId) ?? null,
      setActive: setActiveId,
      keys,
      hosts,
      activeKey,
      setActiveKey,
      refreshKeys,
      refreshHosts,
      connect,
      disconnect,
      error,
      note,
      pinned,
      mismatch,
      dismissMismatch: () => setMismatch(null),
      subscribe,
      write: (id, d) => live.current.get(id)?.session.write(d),
      resize: (id, c, r) => live.current.get(id)?.session.resize(c, r),
      sftpFor: (id) => live.current.get(id)?.entry.sftp ?? null,
      sessionFor: (id) => live.current.get(id)?.session ?? null,
    }),
    [
      phase, sessions, activeId, keys, hosts, activeKey, refreshKeys,
      refreshHosts, connect, disconnect, error, note, pinned, mismatch, subscribe,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
