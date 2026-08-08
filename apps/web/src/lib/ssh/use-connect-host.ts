"use client";

/**
 * Connecting to a saved host, from anywhere.
 *
 * The hosts list, the dashboard overview and the split-pane host picker all
 * want the same behaviour — take a saved record, resolve its credentials, open
 * a session — and it had drifted into near-copies. It lives here now.
 *
 * A host records *how* it authenticates, never the secret. Key hosts resolve to
 * a stored key or ask which one; password hosts ask every time, because a saved
 * password would be a plaintext credential sitting in the vault for the
 * convenience of skipping one dialog.
 */

import * as React from "react";
import { toast } from "sonner";

import type { Credential, Need } from "@/components/ssh/credential-prompt";
import type { Host } from "@/lib/hosts";
import { useSshSession } from "@/lib/ssh/session-provider";
import { requestUnlock, useVaultUnlocked } from "@/lib/vault/session";

export interface ConnectHostOptions {
  /** Runs with the new session id once the handshake succeeds. */
  onConnected?: (sessionId: string) => void;
  /** Ask for whatever the host did not specify. Resolves null if cancelled. */
  askFor?: (host: Host, need: Need) => Promise<Credential | null>;
}

export function useConnectHost(opts: ConnectHostOptions = {}) {
  const { keys, connect } = useSshSession();
  const vaultUnlocked = useVaultUnlocked();
  const { onConnected, askFor } = opts;

  const [connecting, setConnecting] = React.useState<string | null>(null);

  const connectToHost = React.useCallback(
    async (host: Host): Promise<string | null> => {
      const wantsPassword = host.auth === "password";
      let key = wantsPassword ? undefined : keys.find((k) => k.id === host.keyId);
      let password: string | undefined;

      // A locked vault is the usual reason a saved key is missing: portable
      // keys cannot be unwrapped until it opens. Ask for the vault password
      // rather than prompting for a key that is about to reappear.
      if (!wantsPassword && !key && !vaultUnlocked && host.keyId) {
        requestUnlock();
        return null;
      }

      if (wantsPassword || !key) {
        // With no key to offer, open on the password field — the prompt still
        // lets you switch, but starting on an empty dropdown is a dead end.
        const need: Need = wantsPassword || keys.length === 0 ? "password" : "key";
        if (!askFor) {
          toast.error("This host needs credentials. Connect from the Hosts page.");
          return null;
        }
        const answer = await askFor(host, need);
        if (!answer) return null;
        if ("password" in answer) password = answer.password;
        else key = keys.find((k) => k.id === answer.keyId);
        if (!password && !key) return null;
      }

      const toastId = toast.loading(`Connecting to ${host.username}@${host.hostname}…`);
      setConnecting(host.id);
      try {
        const id = await connect({
          hostname: host.hostname,
          port: host.port,
          username: host.username,
          key,
          password,
        });
        toast.success(`Connected to ${host.hostname}`, { id: toastId });
        onConnected?.(id);
        return id;
      } catch (e) {
        toast.error(String((e as Error).message ?? e), { id: toastId, duration: 10000 });
        return null;
      } finally {
        setConnecting(null);
      }
    },
    [askFor, connect, keys, onConnected, vaultUnlocked],
  );

  return { connectToHost, connecting };
}
