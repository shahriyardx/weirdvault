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

/**
 * SyncResult.status is a value for code to branch on, not a phrase to hand a
 * person. Rendering it raw put "Vault conflict-resolved" in front of users whose
 * one device had just synced with nothing to resolve.
 */
const SYNC_WORDING: Record<
  Awaited<ReturnType<typeof syncVault>>["status"],
  string
> = {
  synced: "synced",
  "up-to-date": "already up to date",
  "conflict-resolved": "merged with a change from another device",
  offline: "not reachable",
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

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
  /**
   * Omit for a password-only host. With both, webxterm logs in with the
   * password once and installs the key so the next connection does not need it.
   */
  key?: SshKey;
  password?: string;
  /** Add this host to the saved list. Off by default. */
  save?: boolean;
}

/**
 * What a tap sees. Deliberately more than the byte stream a terminal pane
 * subscribes to: a recorder that only saw output would replay a 132-column
 * session into an 80-column emulator, and would keep claiming to record a
 * session that had already hung up.
 */
export type SessionTapEvent =
  | { kind: "output"; bytes: Uint8Array }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "closed" };

interface LiveSession {
  entry: SessionEntry;
  /** Null while the handshake is still in flight. */
  session: SshSession | null;
  listeners: Set<(b: Uint8Array) => void>;
  /** Like `listeners`, but never replayed the buffer. See `tapSession`. */
  taps: Set<(e: SessionTapEvent) => void>;
  buffer: Uint8Array[];
  bufferedBytes: number;
  /**
   * The last size the terminal reported, or null until it reports one. xterm
   * starts at 80x24 and only fires onResize when the fit changes that, so a
   * pane that happened to be exactly 80x24 legitimately never reports.
   */
  size: { cols: number; rows: number } | null;
}

export type SplitDirection = "horizontal" | "vertical";

interface SessionContextValue {
  /**
   * Session ids shown side by side. An empty string is a pane that has been
   * opened but not pointed at anything yet — it renders a host picker.
   */
  panes: string[];
  splitDirection: SplitDirection;
  /** Index into `panes`; sidebar switches target this one. */
  focusedPane: number;
  setFocusedPane: (index: number) => void;
  setSplitDirection: (d: SplitDirection) => void;
  /** Adds a pane showing `id`, or the active session if omitted. */
  splitPane: (id?: string) => void;
  closePane: (index: number) => void;
  /** Points an existing pane at a different session. */
  setPaneSession: (index: number, id: string) => void;

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
  /**
   * Live stream only — output, resizes and the close — with no buffer replay.
   *
   * Separate from `subscribe` because the replay is exactly wrong for a
   * recorder: up to half a megabyte of output that arrived before you pressed
   * record would land in the transcript stamped as having happened at zero
   * seconds. A pane wants the history; a recording must not invent one.
   */
  tapSession: (id: string, fn: (e: SessionTapEvent) => void) => () => void;
  /** The last size the terminal reported for this session, if it has. */
  sizeFor: (id: string) => { cols: number; rows: number } | null;
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
  const [panes, setPanes] = useState<string[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  const [splitDirection, setSplitDirection] = useState<SplitDirection>("horizontal");

  // `connect` is memoised without focusedPane in its deps — reading the state
  // directly there would land a new session in whichever pane was focused when
  // the callback was built, not the one focused now.
  // Written in an effect, not during render, so a discarded render cannot leave
  // the ref pointing at a pane the committed tree never focused. `connect` only
  // reads it in response to a user action, which is always after a commit.
  const focusedPaneRef = useRef(0);
  useEffect(() => {
    focusedPaneRef.current = focusedPane;
  }, [focusedPane]);

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
    setSessions(
      [...live.current.values()].filter((l) => l.session).map((l) => l.entry),
    );
  }, []);

  /** "web", then "web #2" — so two shells on one host stay distinguishable. */
  const labelFor = useCallback((target: SessionTarget, selfId: string) => {
    const base = `${target.username}@${target.hostname}`;
    const existing = [...live.current.values()].filter(
      (l) =>
        l.entry.id !== selfId &&
        `${l.entry.target.username}@${l.entry.target.hostname}` === base,
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

      // The shell starts printing — banner, motd, first prompt — inside
      // openSession, before it returns. Registering the buffer only afterwards
      // silently dropped all of it, so the terminal opened blank until you
      // pressed a key. Create it up front and attach the session later.
      const pending: LiveSession = {
        entry: { id, target, label: "", sftp: null, openedAt: Date.now() },
        session: null,
        listeners: new Set(),
        taps: new Set(),
        buffer: [],
        bufferedBytes: 0,
        size: null,
      };
      live.current.set(id, pending);

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
        // Taps get the same buffer the panes get. It is already a private copy
        // of what the transport handed us, and nothing downstream writes to it.
        for (const fn of l.taps) fn({ kind: "output", bytes: copy });
      };

      const common = {
        ...target,
        save: req.save,
        onData: push,
        onClose: () => {
          // Taps hear about the close before the session is forgotten, because
          // a recorder has to be able to finalise on its own rather than keep a
          // "recording" badge on a shell that is gone.
          const closing = live.current.get(id);
          if (closing) {
            for (const fn of closing.taps) fn({ kind: "closed" });
            closing.taps.clear();
          }
          live.current.delete(id);
          syncEntries();
          setActiveId((prev) => (prev === id ? ([...live.current.keys()][0] ?? null) : prev));
          // A closed session must not leave a pane pointing at nothing.
          setPanes((prev) => {
            const next = prev.filter((p) => p !== id);
            return next.length > 0 ? next : ([...live.current.keys()].slice(0, 1) as string[]);
          });
        },
        onPinned: setPinned,
      };

      try {
        let s: SshSession;
        if (req.password && req.key) {
          const r = await connectAndInstallKey({ ...common, password: req.password, key: req.key });
          s = r.session;
          setNote(
            r.result === "installed"
              ? "Key installed on the server. The password is no longer needed."
              : "That key was already authorized.",
          );
        } else if (req.password) {
          // A password-only host: some servers are only ever reached this way,
          // and installing a key uninvited is not our call to make.
          s = await openSession({ ...common, password: req.password });
        } else {
          s = await openSession({ ...common, key: req.key });
        }

        // Label last: labelFor counts existing sessions to the same host, and
        // this one is already in the map.
        pending.entry = { ...pending.entry, label: labelFor(target, id) };
        pending.session = s;
        setPanes((prev) => {
          if (prev.length === 0) return [id];
          // Replace whatever the focused pane was showing — including an empty
          // pane, which is exactly what its host picker is for.
          const next = [...prev];
          next[Math.min(focusedPaneRef.current, next.length - 1)] = id;
          return next;
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
            .then((r) =>
              setNote(
                `Vault ${SYNC_WORDING[r.status]} — ${plural(r.hosts, "host")}, ${plural(r.keys, "key")}`,
              ),
            )
            .catch((e) => setNote(`Sync failed: ${e.message}`));
        }
        return id;
      } catch (e) {
        live.current.delete(id);
        syncEntries();
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
      live.current.get(target)?.session?.close();
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

  const tapSession = useCallback((id: string, fn: (e: SessionTapEvent) => void) => {
    const l = live.current.get(id);
    if (!l) return () => {};
    l.taps.add(fn);
    return () => {
      l.taps.delete(fn);
    };
  }, []);

  /**
   * Resize is where the size is known, so it is where the size is remembered.
   * The terminal component owns the fit; nothing else in this provider can
   * observe the geometry a session is actually running at.
   */
  const resize = useCallback((id: string, cols: number, rows: number) => {
    const l = live.current.get(id);
    if (!l) return;
    l.size = { cols, rows };
    l.session?.resize(cols, rows);
    for (const fn of l.taps) fn({ kind: "resize", cols, rows });
  }, []);

  const sizeFor = useCallback((id: string) => live.current.get(id)?.size ?? null, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      phase,
      sessions,
      activeId,
      active: sessions.find((s) => s.id === activeId) ?? null,
      setActive: (id: string) => {
        setActiveId(id);
        setPanes((prev) => {
          if (prev.length === 0) return [id];
          const next = [...prev];
          next[Math.min(focusedPaneRef.current, next.length - 1)] = id;
          return next;
        });
      },
      panes,
      splitDirection,
      focusedPane,
      setFocusedPane,
      setSplitDirection,
      splitPane: (id?: string) => {
        // Four panes is where a terminal stops being readable on a laptop.
        if (panes.length >= 4) return;
        // A duplicate of the session you are already looking at is rarely what
        // splitting is for. Prefer a session that is not on screen; with
        // nothing spare, open the pane empty and let it ask which host.
        const shown = new Set(panes);
        const spare = [...live.current.keys()].find((k) => !shown.has(k));
        setPanes((prev) => [...prev, id ?? spare ?? ""]);
        setFocusedPane(panes.length);
      },
      closePane: (index: number) =>
        setPanes((prev) => {
          if (prev.length <= 1) return prev;
          const next = prev.filter((_, i) => i !== index);
          setFocusedPane((f) => Math.min(f, next.length - 1));
          return next;
        }),
      setPaneSession: (index: number, id: string) =>
        setPanes((prev) => prev.map((p, i) => (i === index ? id : p))),
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
      tapSession,
      sizeFor,
      write: (id, d) => live.current.get(id)?.session?.write(d),
      resize,
      sftpFor: (id) => live.current.get(id)?.entry.sftp ?? null,
      sessionFor: (id) => live.current.get(id)?.session ?? null,
    }),
    [
      phase, sessions, activeId, keys, hosts, activeKey, refreshKeys,
      refreshHosts, connect, disconnect, error, note, pinned, mismatch, subscribe,
      tapSession, sizeFor, resize, panes, splitDirection, focusedPane,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
