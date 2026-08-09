"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  FloppyDiskIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr";

import { HostKeyMismatchWarning } from "@/components/host-key-mismatch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSshSession } from "@/lib/ssh/session-provider";
import { requestUnlock, useVaultUnlocked } from "@/lib/vault/session";
import { noAutofillSecret, noAutofillText } from "@/lib/no-autofill";

export default function ConnectPage() {
  const router = useRouter();
  const { keys, activeKey, setActiveKey, connect, phase, error, pinned, mismatch, refreshKeys } =
    useSshSession();
  const vaultUnlocked = useVaultUnlocked();

  // Keys may have been created on another page since the provider loaded, and
  // arriving here to find "no usable keys" would be wrong.
  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  const [form, setForm] = useState({
    hostname: "",
    port: "",
    username: "",
    password: "",
  });
  const [usePassword, setUsePassword] = useState(false);

  /**
   * Enrolled machines, if any.
   *
   * Fetched rather than assumed: most deployments have none, and the whole
   * destination picker below is hidden when the list comes back empty. A "reach
   * it directly / through an agent" toggle on an account with no agents is a
   * choice about a feature the user has not set up, offered at the moment they
   * are trying to do something else.
   */
  const [machines, setMachines] = useState<{ id: string; label: string }[]>([]);
  // "direct" rather than "" as the no-agent value: Radix treats an empty string
  // as "nothing selected" and throws if an item claims it, so the sentinel has to
  // be a real value that means the absence of one.
  const DIRECT = "direct";
  const [reach, setReach] = useState<string>(DIRECT);
  const agentId = reach === DIRECT ? "" : reach;

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/agents");
      if (!res.ok) return;
      const body = (await res.json()) as {
        agents: { id: string; label: string; revokedAt: string | null }[];
      };
      setMachines(body.agents.filter((a) => !a.revokedAt).map(({ id, label }) => ({ id, label })));
    })();
  }, []);

  async function submit(e: React.FormEvent, opts: { save?: boolean } = {}) {
    e.preventDefault();
    if (!activeKey) {
      // Almost always a locked vault hiding the portable keys.
      if (!vaultUnlocked) requestUnlock();
      return;
    }
    try {
      await connect({
        hostname: form.hostname.trim(),
        // Blank means the default SSH port, which is what the placeholder says.
        // Through an agent this is the port on *that machine's* loopback, which
        // is the same number for the same reason.
        port: Number(form.port) || 22,
        username: form.username.trim(),
        agentId: agentId || undefined,
        key: activeKey,
        password: usePassword ? form.password : undefined,
        save: opts.save,
      });
      setForm((f) => ({ ...f, password: "" }));
      setUsePassword(false);
      router.push("/dashboard/terminal");
    } catch {
      // Surfaced through context state; nothing to add here.
    }
  }

  return (
    <div className="">
      {mismatch && <HostKeyMismatchWarning />}

      <h1 className="font-heading text-xl font-semibold tracking-tight">Connect to a host</h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        The SSH client runs in this tab. Your key signs the handshake without
        ever being readable, and the host key is pinned on first contact.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Destination</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {machines.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="reach">Reach it</Label>
                <Select value={reach} onValueChange={setReach}>
                  <SelectTrigger id="reach" className="w-full">
                    <SelectValue placeholder="Directly, by address" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DIRECT}>Directly, by address</SelectItem>
                    {machines.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        Through {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {agentId && (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    The hostname below becomes a label rather than an address — the
                    connection goes to that machine&rsquo;s own loopback. Keep it stable:
                    host key pins are stored against it.
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor="hostname">{agentId ? "Name" : "Hostname"}</Label>
                <Input
                  id="hostname"
                  name="remote-hostname"
                  placeholder={agentId ? "home-server" : "server.example.com"}
                  {...noAutofillText}
                  value={form.hostname}
                  onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  inputMode="numeric"
                  placeholder="22"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              {/* The remote account's name, not this account's. A field called
                  "username" is filled by heuristic whatever the attributes say,
                  so the name goes too. See lib/no-autofill.ts. */}
              <Input
                id="username"
                name="remote-login"
                placeholder="root"
                {...noAutofillText}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
              />
            </div>

          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Authentication</CardTitle>
            <CardDescription>
              {keys.length === 0
                ? "You have no usable keys yet. Create one on the Keys page first."
                : "Keys are non-extractable — they sign the handshake but cannot be read."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {keys.length > 0 && (
              <div className="space-y-1.5">
                <Label>Key</Label>
                <Select
                  value={activeKey?.id ?? ""}
                  onValueChange={(id) => {
                    const k = keys.find((x) => x.id === id);
                    if (k) setActiveKey(k);
                  }}
                >
                  <SelectTrigger className="w-full">
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
              </div>
            )}

            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor="usepw" className="text-sm">
                  Use a password once
                </Label>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  Connect with your password and webxterm appends the public key
                  to authorized_keys for you, so you never have to run a command
                  by hand.
                </p>
              </div>
              <Switch id="usepw" checked={usePassword} onCheckedChange={setUsePassword} />
            </div>

            {usePassword && (
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                {/* autoComplete="off" is ignored on password fields by Chrome
                    and Safari; only "new-password" suppresses the fill. This is
                    the remote host's password — filling the webxterm one here
                    would send it to that host on connect. */}
                <Input
                  id="password"
                  name="remote-host-secret"
                  type="password"
                  {...noAutofillSecret}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {error && (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {pinned && (
          <Alert>
            <ShieldCheckIcon />
            <AlertDescription className="text-xs">
              Pinned host key ({pinned.type})
              <br />
              <span className="break-all">{pinned.fingerprint}</span>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!activeKey || phase === "connecting"}>
            <PlugsConnectedIcon />
            {phase === "connecting" ? "Connecting…" : "Connect"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!activeKey || phase === "connecting"}
            onClick={(e) => submit(e, { save: true })}
          >
            <FloppyDiskIcon />
            Save and connect
          </Button>
          {keys.length === 0 &&
            (vaultUnlocked ? (
              <Badge variant="outline" className="font-normal">
                Create a key first
              </Badge>
            ) : (
              <Button type="button" variant="outline" onClick={requestUnlock}>
                Unlock vault to use your keys
              </Button>
            ))}
        </div>
      </form>
    </div>
  );
}
