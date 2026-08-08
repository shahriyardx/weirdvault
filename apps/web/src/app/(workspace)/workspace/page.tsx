"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RemoteEditor } from "@/components/editor";
import { FileExplorer } from "@/components/file-explorer";
import { TerminalView, type TerminalHandle } from "@/components/terminal";
import { HostKeyMismatchError, listPins, unpin } from "@/lib/hostkeys";
import {
  authorizedKeysLine,
  generateKey,
  listKeys,
  proveNonExtractable,
  type KeyMode,
  type SshKey,
} from "@/lib/keys";
import { listHosts, type Host } from "@/lib/hosts";
import { connectAndInstallKey, openSession } from "@/lib/ssh/connect";
import { loadSSH } from "@/lib/ssh/wasm";
import type { HostKeyInfo, SftpHandle, SshSession } from "@/lib/ssh/types";
import { getVaultKey } from "@/lib/vault/session";
import { syncVault } from "@/lib/vault/sync";

type Phase = "loading" | "idle" | "connecting" | "connected";

export default function Workspace() {
  const term = useRef<TerminalHandle>(null);
  const session = useRef<SshSession | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [activeKey, setActiveKey] = useState<SshKey | null>(null);
  const [proof, setProof] = useState<{ ok: boolean; detail: string } | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [sftp, setSftp] = useState<SftpHandle | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pinned, setPinned] = useState<HostKeyInfo | null>(null);
  const [mismatch, setMismatch] = useState<HostKeyMismatchError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [form, setForm] = useState({
    hostname: "127.0.0.1",
    port: 2222,
    username: "webxterm",
    password: "",
  });
  const [usePassword, setUsePassword] = useState(false);

  const vaultKey = getVaultKey();

  const selectKey = useCallback(async (key: SshKey) => {
    setActiveKey(key);
    setProof(await proveNonExtractable(key));
  }, []);

  useEffect(() => {
    (async () => {
      await loadSSH();
      const [k, h] = await Promise.all([listKeys(vaultKey ?? undefined), listHosts()]);
      setKeys(k);
      setHosts(h);
      if (k[0]) await selectKey(k[0]);
      setPhase("idle");
    })().catch((e) => {
      setError(String(e.message ?? e));
      setPhase("idle");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGenerate(mode: KeyMode) {
    setError(null);
    try {
      const key = await generateKey("webxterm", mode, vaultKey ?? undefined);
      setKeys(await listKeys(vaultKey ?? undefined));
      await selectKey(key);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  async function connect() {
    if (!activeKey) return;
    setError(null);
    setMismatch(null);
    setPinned(null);
    setPhase("connecting");
    term.current?.clear();

    const { cols, rows } = term.current?.size() ?? { cols: 80, rows: 24 };
    const common = {
      hostname: form.hostname,
      port: form.port,
      username: form.username,
      cols,
      rows,
      onData: (b: Uint8Array) => term.current?.write(b),
      onClose: () => {
        setPhase("idle");
        session.current = null;
        setSftp(null);
        setEditing(null);
      },
      onPinned: (info: HostKeyInfo) => setPinned(info),
    };

    try {
      let s: SshSession;
      if (usePassword && form.password) {
        // Password-first onboarding: connect once, install the key, and never
        // ask the user to run a command by hand.
        const r = await connectAndInstallKey({ ...common, password: form.password, key: activeKey });
        s = r.session;
        setSyncNote(
          r.result === "installed"
            ? "Public key installed on the server — password no longer needed."
            : "Public key was already authorized.",
        );
        setForm((f) => ({ ...f, password: "" }));
        setUsePassword(false);
      } else {
        s = await openSession({ ...common, key: activeKey });
      }

      session.current = s;
      setPhase("connected");
      term.current?.focus();
      setSftp(await s.sftp());
      setHosts(await listHosts());

      if (vaultKey) {
        void syncVault(vaultKey)
          .then((r) => setSyncNote(`Vault ${r.status} · ${r.hosts} hosts`))
          .catch((e) => setSyncNote(`Sync failed: ${e.message}`));
      }
    } catch (e) {
      if (e instanceof HostKeyMismatchError) setMismatch(e);
      else setError(String((e as Error).message ?? e));
      setPhase("idle");
    }
  }

  return (
    <div className="grid h-screen grid-cols-[300px_1fr_340px] bg-[#0b0e14] text-[#c9d1d9]">
      {/* ---------------------------------------------------------- left */}
      <aside className="overflow-y-auto border-r border-[#232a38] bg-[#131822] p-4">
        <h1 className="text-sm font-semibold">webxterm</h1>
        <p className="mb-4 text-[11px] text-[#7d8798]">
          {vaultKey ? "Vault unlocked · syncing" : "Local only · sign in to sync"}
        </p>

        <Section title="Key">
          <div className="flex gap-1.5">
            <button onClick={() => void onGenerate("portable")} className="btn text-[11px]">
              Portable
            </button>
            <button onClick={() => void onGenerate("device-bound")} className="btn text-[11px]">
              Device-bound
            </button>
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-[#7d8798]">
            Portable syncs to your other devices via the vault. Device-bound never
            leaves this browser.
          </p>

          {keys.length > 0 && (
            <select
              className="input mt-2 text-[11px]"
              value={activeKey?.id ?? ""}
              onChange={(e) => {
                const k = keys.find((x) => x.id === e.target.value);
                if (k) void selectKey(k);
              }}
            >
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} · {k.mode}
                </option>
              ))}
            </select>
          )}

          {activeKey && (
            <>
              <p className="mt-3 mb-1 text-[10px] tracking-wide text-[#7d8798] uppercase">
                Run on your server
              </p>
              <pre className="max-h-24 overflow-auto rounded border border-[#232a38] bg-[#0d1119] p-1.5 text-[10px] break-all whitespace-pre-wrap">
                echo &apos;{authorizedKeysLine(activeKey)}&apos; &gt;&gt; ~/.ssh/authorized_keys
              </pre>
              <button
                onClick={() =>
                  navigator.clipboard.writeText(
                    `echo '${authorizedKeysLine(activeKey)}' >> ~/.ssh/authorized_keys`,
                  )
                }
                className="btn mt-1.5 text-[11px]"
              >
                Copy
              </button>
              <p className="mt-1.5 text-[10px] text-[#7d8798]">
                Or tick &ldquo;use password&rdquo; below and we&apos;ll install it for you.
              </p>
            </>
          )}

          {proof && (
            <p className={`mt-2 text-[10px] ${proof.ok ? "text-[#46d47f]" : "text-[#ff6b6b]"}`}>
              {proof.ok ? "✓ non-extractable" : "✗ extractable"} — {proof.detail}
            </p>
          )}
        </Section>

        <Section title="Connect">
          <input
            className="input mb-1.5"
            value={form.hostname}
            onChange={(e) => setForm({ ...form, hostname: e.target.value })}
            placeholder="hostname"
          />
          <div className="mb-1.5 grid grid-cols-2 gap-1.5">
            <input
              className="input"
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: +e.target.value })}
            />
            <input
              className="input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="user"
            />
          </div>

          <label className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[#7d8798]">
            <input
              type="checkbox"
              checked={usePassword}
              onChange={(e) => setUsePassword(e.target.checked)}
            />
            Use password once, install key
          </label>
          {usePassword && (
            <input
              className="input mb-1.5"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="password"
            />
          )}

          <button
            onClick={phase === "connected" ? () => session.current?.close() : connect}
            disabled={!activeKey || phase === "connecting" || phase === "loading"}
            className={`btn ${phase === "connected" ? "" : "btn-primary"}`}
          >
            {phase === "connecting"
              ? "Connecting…"
              : phase === "connected"
                ? "Disconnect"
                : "Connect"}
          </button>

          {pinned && (
            <p className="mt-2 text-[10px] text-[#7d8798]">
              Pinned host key {pinned.type}
              <br />
              <span className="break-all">{pinned.fingerprint}</span>
            </p>
          )}
          {error && <p className="mt-2 text-[11px] text-[#ff6b6b]">{error}</p>}
          {syncNote && <p className="mt-2 text-[10px] text-[#46d47f]">{syncNote}</p>}
        </Section>

        {hosts.length > 0 && (
          <Section title="Recent">
            {hosts.slice(0, 12).map((h) => (
              <button
                key={h.id}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    hostname: h.hostname,
                    port: h.port,
                    username: h.username,
                  }))
                }
                className="block w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-[#7d8798] hover:bg-[#1b2230] hover:text-[#c9d1d9]"
              >
                {h.username}@{h.hostname}:{h.port}
              </button>
            ))}
          </Section>
        )}
      </aside>

      {/* -------------------------------------------------------- centre */}
      <main className="relative min-w-0 p-2">
        {mismatch && <MismatchWarning error={mismatch} onDismiss={() => setMismatch(null)} />}
        {editing && sftp ? (
          <RemoteEditor sftp={sftp} path={editing} onClose={() => setEditing(null)} />
        ) : (
          <TerminalView
            ref={term}
            onInput={(d) => session.current?.write(d)}
            onResize={(c, r) => session.current?.resize(c, r)}
          />
        )}
      </main>

      {/* --------------------------------------------------------- right */}
      <aside className="min-h-0 border-l border-[#232a38] bg-[#131822]">
        {sftp && session.current ? (
          <FileExplorer
            sftp={sftp}
            session={session.current}
            onEdit={setEditing}
            onOpenTerminalAt={(dir) => {
              setEditing(null);
              session.current?.write(`cd ${JSON.stringify(dir)}\n`);
              term.current?.focus();
            }}
          />
        ) : (
          <p className="p-4 text-[11px] text-[#7d8798]">
            Connect to browse files. The explorer shares the same SSH connection —
            no second login.
          </p>
        )}
      </aside>
    </div>
  );
}

/**
 * A host key mismatch is either a rebuilt server or an active attack, and the
 * UI cannot tell which. So it blocks, explains, and makes clearing the pin a
 * deliberate act rather than a "trust anyway" button next to the warning.
 */
function MismatchWarning({
  error,
  onDismiss,
}: {
  error: HostKeyMismatchError;
  onDismiss: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");

  return (
    <div className="absolute inset-2 z-40 overflow-auto rounded-lg border-2 border-[#ff6b6b] bg-[#1a0f12] p-5">
      <h2 className="text-base font-semibold text-[#ff6b6b]">Host key mismatch</h2>
      <p className="mt-2 max-w-xl text-[13px] leading-relaxed">
        The key presented by <b>{error.host}:{error.port}</b> is not the one pinned
        for this host. Either the server was rebuilt or reinstalled, or something
        is intercepting this connection. webxterm refused to continue.
      </p>
      <dl className="mt-3 space-y-1 font-mono text-[11px]">
        <div>
          <dt className="inline text-[#7d8798]">pinned: </dt>
          <dd className="inline">{error.expected.type} {error.expected.fingerprint}</dd>
        </div>
        <div>
          <dt className="inline text-[#7d8798]">presented: </dt>
          <dd className="inline text-[#ff6b6b]">
            {error.presented.type} {error.presented.fingerprint}
          </dd>
        </div>
      </dl>
      <p className="mt-3 max-w-xl text-[12px] text-[#7d8798]">
        Only clear the pin if you know why the key changed — for example, you
        rebuilt the machine. Verify the new fingerprint out of band first, by
        running <code className="text-[#c9d1d9]">ssh-keyscan</code> from a
        trusted network or checking your provider&apos;s console.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <input
          className="input max-w-56"
          placeholder='type "clear pin" to confirm'
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
        <button
          disabled={confirmText !== "clear pin"}
          onClick={async () => {
            await unpin(error.host, error.port);
            onDismiss();
          }}
          className="btn max-w-32 disabled:opacity-40"
        >
          Clear pin
        </button>
        <button onClick={onDismiss} className="btn max-w-24">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="mb-3 rounded-lg border border-[#232a38] p-2.5">
      <legend className="px-1 text-[9px] tracking-wider text-[#7d8798] uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}
