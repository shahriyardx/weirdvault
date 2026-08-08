"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TerminalView, type TerminalHandle } from "@/components/terminal";
import {
  authorizedKeysLine,
  generateKey,
  listHosts,
  listKeys,
  makeSigner,
  proveNonExtractable,
  rawPublicKey,
  saveHost,
  type Host,
  type SshKey,
} from "@/lib/keys";
import { connect, loadSSH, relayUrl } from "@/lib/ssh/wasm";
import type { SftpEntry, SftpHandle, SshSession } from "@/lib/ssh/types";

type Status = "idle" | "loading" | "connecting" | "connected";

export default function Workspace() {
  const term = useRef<TerminalHandle>(null);
  const session = useRef<SshSession | null>(null);
  const sftp = useRef<SftpHandle | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [activeKey, setActiveKey] = useState<SshKey | null>(null);
  const [pubkey, setPubkey] = useState("");
  const [proof, setProof] = useState<{ ok: boolean; detail: string } | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [form, setForm] = useState({ hostname: "127.0.0.1", port: 2222, username: "webxterm" });
  const [files, setFiles] = useState<{ path: string; entries: SftpEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectKey = useCallback(async (key: SshKey) => {
    setActiveKey(key);
    setPubkey(await authorizedKeysLine(key));
    setProof(await proveNonExtractable(key));
  }, []);

  useEffect(() => {
    (async () => {
      await loadSSH();
      const [k, h] = await Promise.all([listKeys(), listHosts()]);
      setKeys(k);
      setHosts(h);
      if (k[0]) await selectKey(k[0]);
      setStatus("idle");
    })().catch((e) => setError(String(e.message ?? e)));
  }, [selectKey]);

  async function onGenerate() {
    const key = await generateKey();
    setKeys(await listKeys());
    await selectKey(key);
  }

  async function onConnect() {
    if (!activeKey) return;
    setError(null);
    setStatus("connecting");
    term.current?.clear();

    try {
      const { cols, rows } = term.current?.size() ?? { cols: 80, rows: 24 };
      const s = await connect({
        relay: relayUrl(form.hostname, form.port),
        host: form.hostname,
        port: form.port,
        user: form.username,
        cols,
        rows,
        auth: {
          kind: "publickey",
          keyType: "ed25519",
          publicKey: await rawPublicKey(activeKey),
          sign: makeSigner(activeKey),
        },
        onData: (bytes) => term.current?.write(bytes),
        onClose: () => {
          setStatus("idle");
          session.current = null;
          sftp.current = null;
          setFiles(null);
        },
      });

      session.current = s;
      setStatus("connected");
      term.current?.focus();

      // The file explorer rides the same connection, so it opens immediately
      // rather than costing a second login.
      sftp.current = await s.sftp();
      setFiles(await sftp.current.list("."));

      await saveHost({ label: `${form.username}@${form.hostname}`, ...form, keyId: activeKey.id });
      setHosts(await listHosts());
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setStatus("idle");
    }
  }

  async function browse(dir: string) {
    if (!sftp.current) return;
    try {
      setFiles(await sftp.current.list(dir));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  return (
    <div className="grid h-screen grid-cols-[340px_1fr] bg-[#0b0e14] text-[#c9d1d9]">
      <aside className="overflow-y-auto border-r border-[#232a38] bg-[#131822] p-5">
        <h1 className="text-base font-semibold">webxterm</h1>
        <p className="mb-5 text-xs text-[#7d8798]">
          Zero-install SSH. Keys never leave this browser.
        </p>

        <Section title="Key">
          <button onClick={onGenerate} className="btn">
            Generate Ed25519 key
          </button>
          {keys.length > 1 && (
            <select
              className="mt-2 w-full rounded-md border border-[#232a38] bg-[#0d1119] p-2 text-xs"
              value={activeKey?.id}
              onChange={(e) => {
                const k = keys.find((x) => x.id === e.target.value);
                if (k) void selectKey(k);
              }}
            >
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} · {new Date(k.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          )}
          {pubkey && (
            <>
              <p className="mt-3 mb-1 text-[10px] tracking-wide text-[#7d8798] uppercase">
                Run this on your server
              </p>
              <pre className="max-h-28 overflow-auto rounded-md border border-[#232a38] bg-[#0d1119] p-2 text-[10px] break-all whitespace-pre-wrap">
                echo &apos;{pubkey}&apos; &gt;&gt; ~/.ssh/authorized_keys
              </pre>
              <button
                onClick={() =>
                  navigator.clipboard.writeText(
                    `echo '${pubkey}' >> ~/.ssh/authorized_keys`,
                  )
                }
                className="btn mt-2"
              >
                Copy command
              </button>
            </>
          )}
          {proof && (
            <p className={`mt-3 text-[11px] ${proof.ok ? "text-[#46d47f]" : "text-[#ff6b6b]"}`}>
              {proof.ok ? "✓ private key is non-extractable" : "✗ "}
              <span className="text-[#7d8798]"> — {proof.detail}</span>
            </p>
          )}
        </Section>

        <Section title="Host">
          <Field label="Hostname">
            <input
              className="input"
              value={form.hostname}
              onChange={(e) => setForm({ ...form, hostname: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Port">
              <input
                className="input"
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: +e.target.value })}
              />
            </Field>
            <Field label="User">
              <input
                className="input"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Field>
          </div>
          <button
            onClick={status === "connected" ? () => session.current?.close() : onConnect}
            disabled={!activeKey || status === "connecting" || status === "loading"}
            className={`btn mt-3 ${status === "connected" ? "" : "btn-primary"}`}
          >
            {status === "connecting"
              ? "Connecting…"
              : status === "connected"
                ? "Disconnect"
                : "Connect"}
          </button>
          {error && <p className="mt-2 text-[11px] text-[#ff6b6b]">{error}</p>}
        </Section>

        {hosts.length > 0 && (
          <Section title="Recent">
            {hosts.map((h) => (
              <button
                key={h.id}
                onClick={() =>
                  setForm({ hostname: h.hostname, port: h.port, username: h.username })
                }
                className="block w-full truncate rounded px-1 py-1 text-left text-xs text-[#7d8798] hover:bg-[#1b2230] hover:text-[#c9d1d9]"
              >
                {h.username}@{h.hostname}:{h.port}
              </button>
            ))}
          </Section>
        )}

        {files && (
          <Section title={`Files · ${files.path}`}>
            <button
              onClick={() => browse("..")}
              className="block w-full rounded px-1 py-1 text-left text-xs text-[#7d8798] hover:bg-[#1b2230]"
            >
              ../
            </button>
            {files.entries.slice(0, 60).map((e) => (
              <button
                key={e.name}
                onClick={() => e.isDir && browse(`${files.path}/${e.name}`)}
                className="flex w-full justify-between rounded px-1 py-1 text-left text-xs hover:bg-[#1b2230]"
              >
                <span className="truncate">
                  {e.isDir ? "📁" : "📄"} {e.name}
                </span>
                {!e.isDir && (
                  <span className="ml-2 shrink-0 text-[#7d8798]">{fmtSize(e.size)}</span>
                )}
              </button>
            ))}
          </Section>
        )}
      </aside>

      <main className="min-w-0 p-2">
        <TerminalView
          ref={term}
          onInput={(d) => session.current?.write(d)}
          onResize={(c, r) => session.current?.resize(c, r)}
        />
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="mb-4 rounded-lg border border-[#232a38] p-3">
      <legend className="px-1.5 text-[10px] tracking-wider text-[#7d8798] uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] text-[#7d8798]">{label}</span>
      {children}
    </label>
  );
}

function fmtSize(n: number) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
