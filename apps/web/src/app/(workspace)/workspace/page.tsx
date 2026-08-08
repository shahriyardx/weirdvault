"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  KeyIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  ShieldCheckIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr";

import { RemoteEditor } from "@/components/editor";
import { FileExplorer } from "@/components/file-explorer";
import { Brand } from "@/components/shell/brand";
import { TerminalView, type TerminalHandle } from "@/components/terminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HostKeyMismatchError, unpin } from "@/lib/hostkeys";
import { listHosts, type Host } from "@/lib/hosts";
import {
  authorizedKeysLine,
  generateKey,
  listKeys,
  proveNonExtractable,
  type KeyMode,
  type SshKey,
} from "@/lib/keys";
import { connectAndInstallKey, openSession } from "@/lib/ssh/connect";
import type { HostKeyInfo, SftpHandle, SshSession } from "@/lib/ssh/types";
import { loadSSH } from "@/lib/ssh/wasm";
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
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [form, setForm] = useState({
    hostname: "127.0.0.1",
    port: 2222,
    username: "webxterm",
    password: "",
  });

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
    // Mount only: re-running would tear down a live session.
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

  const installCommand = activeKey
    ? `echo '${authorizedKeysLine(activeKey)}' >> ~/.ssh/authorized_keys`
    : "";

  async function copyInstall() {
    await navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
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
        const r = await connectAndInstallKey({ ...common, password: form.password, key: activeKey });
        s = r.session;
        setNote(
          r.result === "installed"
            ? "Key installed on the server. The password is no longer needed."
            : "That key was already authorized.",
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
          .then((r) => setNote(`Vault ${r.status} — ${r.hosts} hosts, ${r.keys} keys`))
          .catch((e) => setNote(`Sync failed: ${e.message}`));
      }
    } catch (e) {
      if (e instanceof HostKeyMismatchError) setMismatch(e);
      else setError(String((e as Error).message ?? e));
      setPhase("idle");
    }
  }

  const connected = phase === "connected";

  return (
    <div className="bg-background flex h-svh flex-col">
      {/* --------------------------------------------------------- top bar */}
      <header className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Brand size="sm" />
        <Separator orientation="vertical" className="h-5" />
        <span className="text-muted-foreground truncate text-xs">
          {connected ? `${form.username}@${form.hostname}:${form.port}` : "Not connected"}
        </span>
        <Badge
          variant={connected ? "default" : "outline"}
          className="gap-1.5 text-[10px] font-normal"
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground"}`}
          />
          {phase === "connecting" ? "Connecting" : connected ? "Live" : "Idle"}
        </Badge>

        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1.5 text-[10px] font-normal">
                <ShieldCheckIcon className={vaultKey ? "text-success" : "text-muted-foreground"} />
                {vaultKey ? "Vault unlocked" : "Local only"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {vaultKey
                ? "Hosts, keys and pins sync as ciphertext the server cannot read"
                : "Sign in to sync hosts and keys across devices"}
            </TooltipContent>
          </Tooltip>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard">
              Dashboard <ArrowSquareOutIcon />
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr_340px]">
        {/* ------------------------------------------------------- sidebar */}
        <aside className="border-border hidden min-h-0 border-r lg:block">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-4">
              {/* key */}
              <section className="space-y-2">
                <SectionTitle icon={<KeyIcon />}>Key</SectionTitle>

                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void onGenerate("portable")}>
                    Portable
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void onGenerate("device-bound")}
                  >
                    Device-bound
                  </Button>
                </div>
                <p className="text-muted-foreground text-[11px] leading-snug">
                  Portable is wrapped with your vault key and syncs to your other
                  devices. Device-bound never leaves this browser.
                </p>

                {keys.length > 0 && (
                  <Select
                    value={activeKey?.id ?? ""}
                    onValueChange={(id) => {
                      const k = keys.find((x) => x.id === id);
                      if (k) void selectKey(k);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue placeholder="Select a key" />
                    </SelectTrigger>
                    <SelectContent>
                      {keys.map((k) => (
                        <SelectItem key={k.id} value={k.id}>
                          {k.label} · {k.mode}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {activeKey && (
                  <>
                    <Label className="text-muted-foreground text-[10px] tracking-wider uppercase">
                      Run on your server
                    </Label>
                    <pre className="bg-terminal border-border max-h-24 overflow-auto rounded-sm border p-2 text-[10px] leading-relaxed break-all whitespace-pre-wrap">
                      {installCommand}
                    </pre>
                    <Button variant="outline" size="sm" className="w-full" onClick={copyInstall}>
                      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
                      {copied ? "Copied" : "Copy command"}
                    </Button>
                  </>
                )}

                {proof && (
                  <p
                    className={`flex items-start gap-1.5 text-[11px] ${
                      proof.ok ? "text-success" : "text-destructive"
                    }`}
                  >
                    {proof.ok ? <ShieldCheckIcon className="mt-0.5 shrink-0" /> : <WarningIcon className="mt-0.5 shrink-0" />}
                    <span>
                      {proof.ok ? "Private key is non-extractable" : "Key is extractable"}
                      <span className="text-muted-foreground"> — {proof.detail}</span>
                    </span>
                  </p>
                )}
              </section>

              <Separator />

              {/* connection */}
              <section className="space-y-2">
                <SectionTitle icon={<PlugsConnectedIcon />}>Connect</SectionTitle>

                <div className="space-y-1.5">
                  <Label htmlFor="host" className="text-[11px]">
                    Hostname
                  </Label>
                  <Input
                    id="host"
                    value={form.hostname}
                    onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                    className="h-8 text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="port" className="text-[11px]">
                      Port
                    </Label>
                    <Input
                      id="port"
                      type="number"
                      value={form.port}
                      onChange={(e) => setForm({ ...form, port: +e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="user" className="text-[11px]">
                      User
                    </Label>
                    <Input
                      id="user"
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <Label htmlFor="usepw" className="text-muted-foreground text-[11px] leading-snug">
                    Use password once, install key
                  </Label>
                  <Switch id="usepw" checked={usePassword} onCheckedChange={setUsePassword} />
                </div>

                {usePassword && (
                  <Input
                    type="password"
                    placeholder="Password"
                    autoComplete="off"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="h-8 text-xs"
                  />
                )}

                <Button
                  className="w-full"
                  size="sm"
                  variant={connected ? "outline" : "default"}
                  disabled={!activeKey || phase === "connecting" || phase === "loading"}
                  onClick={connected ? () => session.current?.close() : connect}
                >
                  {connected ? <PlugsIcon /> : <PlugsConnectedIcon />}
                  {phase === "connecting"
                    ? "Connecting…"
                    : connected
                      ? "Disconnect"
                      : "Connect"}
                </Button>

                {pinned && (
                  <p className="text-muted-foreground text-[10px] leading-relaxed break-all">
                    Pinned host key ({pinned.type})
                    <br />
                    {pinned.fingerprint}
                  </p>
                )}
                {error && (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription className="text-[11px]">{error}</AlertDescription>
                  </Alert>
                )}
                {note && <p className="text-success text-[11px]">{note}</p>}
              </section>

              {hosts.length > 0 && (
                <>
                  <Separator />
                  <section className="space-y-1">
                    <SectionTitle>Recent</SectionTitle>
                    {hosts.slice(0, 12).map((h) => (
                      <Button
                        key={h.id}
                        variant="ghost"
                        size="sm"
                        className="h-7 w-full justify-start px-2 text-[11px] font-normal"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            hostname: h.hostname,
                            port: h.port,
                            username: h.username,
                          }))
                        }
                      >
                        <span className="truncate">
                          {h.username}@{h.hostname}:{h.port}
                        </span>
                      </Button>
                    ))}
                  </section>
                </>
              )}
            </div>
          </ScrollArea>
        </aside>

        {/* -------------------------------------------------------- centre */}
        <main className="relative min-h-0 min-w-0 p-2">
          {mismatch && <MismatchWarning error={mismatch} onDismiss={() => setMismatch(null)} />}
          {editing && sftp ? (
            <RemoteEditor sftp={sftp} path={editing} onClose={() => setEditing(null)} />
          ) : (
            <div className="bg-terminal border-border h-full overflow-hidden rounded-md border p-2">
              <TerminalView
                ref={term}
                onInput={(d) => session.current?.write(d)}
                onResize={(c, r) => session.current?.resize(c, r)}
              />
            </div>
          )}
        </main>

        {/* --------------------------------------------------------- files */}
        <aside className="border-border hidden min-h-0 border-l lg:block">
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
            <div className="text-muted-foreground p-4 text-[11px] leading-relaxed">
              Connect to browse files. The explorer shares the same SSH
              connection, so it costs no second login.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function SectionTitle({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <h2 className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium tracking-wider uppercase">
      {icon}
      {children}
    </h2>
  );
}

/**
 * A host key mismatch is either a rebuilt server or an active interception, and
 * the UI cannot tell which. So it blocks, explains, and makes clearing the pin
 * a deliberate act — never a "trust anyway" button sitting next to the warning.
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
    <div className="bg-background/95 absolute inset-2 z-40 overflow-auto backdrop-blur-sm">
      <Alert variant="destructive" className="h-full">
        <WarningIcon />
        <AlertTitle className="text-base">Host key mismatch</AlertTitle>
        <AlertDescription className="space-y-4">
          <p className="max-w-xl text-sm leading-relaxed">
            The key presented by{" "}
            <b>
              {error.host}:{error.port}
            </b>{" "}
            is not the one pinned for this host. Either the server was rebuilt,
            or something is intercepting this connection. webxterm refused to
            continue.
          </p>

          <dl className="space-y-1 text-[11px]">
            <div>
              <dt className="text-muted-foreground inline">pinned: </dt>
              <dd className="inline">
                {error.expected.type} {error.expected.fingerprint}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground inline">presented: </dt>
              <dd className="text-destructive inline">
                {error.presented.type} {error.presented.fingerprint}
              </dd>
            </div>
          </dl>

          <p className="text-muted-foreground max-w-xl text-xs leading-relaxed">
            Only clear the pin if you know why the key changed. Verify the new
            fingerprint out of band first — run <code>ssh-keyscan</code> from a
            trusted network, or check your provider&apos;s console.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-56 text-xs"
              placeholder='type "clear pin" to confirm'
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={confirmText !== "clear pin"}
                    onClick={async () => {
                      await unpin(error.host, error.port);
                      onDismiss();
                    }}
                  >
                    Clear pin
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Removes the pinned key so the next connection trusts on first use
              </TooltipContent>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Cancel
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
