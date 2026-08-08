"use client";

import { useState } from "react";
import Link from "next/link";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/ssr";

import { RemoteEditor } from "@/components/editor";
import { FileExplorer } from "@/components/file-explorer";
import { Button } from "@/components/ui/button";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * Files and the remote editor, on the same SSH connection as the terminal.
 *
 * On wide screens the explorer and the editor sit side by side, so opening a
 * file doesn't hide the tree you were navigating.
 */
export default function FilesPage() {
  const { phase, sftp, session, write } = useSshSession();
  const [editing, setEditing] = useState<string | null>(null);

  if (phase !== "connected" || !sftp || !session) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="font-heading text-sm font-medium">No active session</h2>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            Connect to a host to browse, upload and edit files. SFTP rides the
            same connection as the terminal.
          </p>
          <Button asChild className="mt-4" size="sm">
            <Link href="/dashboard/connect">
              <PlugsConnectedIcon />
              Connect to a host
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[340px_1fr]">
      <div className="border-border min-h-0 border-r">
        <FileExplorer
          sftp={sftp}
          session={session}
          onEdit={setEditing}
          onOpenTerminalAt={(dir) => write(`cd ${JSON.stringify(dir)}\n`)}
        />
      </div>

      <div className="min-h-0">
        {editing ? (
          <RemoteEditor sftp={sftp} path={editing} onClose={() => setEditing(null)} />
        ) : (
          <div className="text-muted-foreground grid h-full place-items-center p-6 text-sm">
            Double-click a file to edit it here.
          </div>
        )}
      </div>
    </div>
  );
}
