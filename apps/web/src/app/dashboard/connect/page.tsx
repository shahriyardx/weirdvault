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
    hostname: "127.0.0.1",
    port: 2222,
    username: "webxterm",
    password: "",
  });
  const [usePassword, setUsePassword] = useState(false);

  async function submit(e: React.FormEvent, opts: { save?: boolean } = {}) {
    e.preventDefault();
    if (!activeKey) {
      // Almost always a locked vault hiding the portable keys.
      if (!vaultUnlocked) requestUnlock();
      return;
    }
    try {
      await connect({
        hostname: form.hostname,
        port: form.port,
        username: form.username,
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
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor="hostname">Hostname</Label>
                <Input
                  id="hostname"
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
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: +e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
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
                <Input
                  id="password"
                  type="password"
                  autoComplete="off"
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
