"use client";

import { useState } from "react";
import Link from "next/link";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/ssr";

import { RemoteEditor } from "@/components/editor";
import { FileExplorer } from "@/components/file-explorer";
import { Button } from "@/components/ui/button";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * Files for the active session.
 *
 * SFTP rides that session's existing SSH connection, so switching sessions in
 * the sidebar switches which machine you are browsing with no second login.
 */
export default function FilesPage() {
  const { activeId, active, sftpFor, sessionFor, write } = useSshSession();
  const [editing, setEditing] = useState<string | null>(null);

  const sftp = activeId ? sftpFor(activeId) : null;
  const session = activeId ? sessionFor(activeId) : null;

  if (!activeId || !session) {
    return (
      <Empty
        title="No active session"
        body="Connect to a host to browse, upload and edit files. SFTP rides the same connection as the terminal."
      />
    );
  }

  if (!sftp) {
    return (
      <div className="text-muted-foreground grid h-full place-items-center p-6 text-sm">
        Opening SFTP on {active?.label}…
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[340px_1fr]">
      <div className="border-border min-h-0 border-r">
        <FileExplorer
          key={activeId}
          sftp={sftp}
          session={session}
          onEdit={setEditing}
          onOpenTerminalAt={(dir) => write(activeId, `cd ${JSON.stringify(dir)}\n`)}
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

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-sm text-center">
        <h2 className="font-heading text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{body}</p>
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
