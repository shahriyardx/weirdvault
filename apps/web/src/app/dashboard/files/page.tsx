"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlugsConnectedIcon, TerminalWindowIcon } from "@phosphor-icons/react/dist/ssr";

import { RemoteEditor } from "@/components/editor";
import { FileExplorer } from "@/components/file-explorer";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * Files, for a session you choose.
 *
 * Browsing is not always about the shell you happen to be typing in — you
 * might be running something in one session and pulling a file from another.
 * So this picks its own session rather than silently following the terminal,
 * defaulting to whichever is active when you arrive.
 */
export default function FilesPage() {
  const router = useRouter();
  const { sessions, activeId, setActive, sftpFor, sessionFor, write } = useSshSession();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  /**
   * The picked session is a preference, not the source of truth, so it is
   * resolved during render instead of being copied into state by an effect.
   * Storing it meant a frame where the picker pointed at a session that had
   * just closed, and a second render to correct it. Falling back here means
   * a closed session degrades to the active one on the very same paint.
   */
  const id =
    chosenId && sessions.some((s) => s.id === chosenId)
      ? chosenId
      : (activeId ?? sessions[0]?.id ?? null);
  const sftp = id ? sftpFor(id) : null;
  const session = id ? sessionFor(id) : null;
  const entry = sessions.find((s) => s.id === id) ?? null;

  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="font-heading text-sm font-medium">No sessions open</h2>
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Which machine am I looking at? */}
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground text-xs">Browsing</span>
        <Select value={id ?? ""} onValueChange={(v) => { setChosenId(v); setEditing(null); }}>
          <SelectTrigger size="sm" className="w-auto min-w-56">
            <SelectValue placeholder="Choose a session" />
          </SelectTrigger>
          <SelectContent>
            {sessions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}:{s.target.port}
                {s.id === activeId ? " · active" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link href="/dashboard/terminal">
            <TerminalWindowIcon />
            Terminal
          </Link>
        </Button>
      </div>

      {!sftp || !session ? (
        <div className="text-muted-foreground grid flex-1 place-items-center p-6 text-sm">
          Opening SFTP on {entry?.label}…
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[340px_1fr]">
          <div className="border-border min-h-0 border-r">
            <FileExplorer
              key={id}
              sftp={sftp}
              session={session}
              onEdit={setEditing}
              // "Open terminal here" used to cd the shell and leave you looking
              // at the file listing, so the only visible effect was none. It
              // goes to the terminal now — and retargets the focused pane at
              // this session first, since the session being browsed is not
              // necessarily the one that pane was showing.
              onOpenTerminalAt={(dir) => {
                if (!id) return;
                write(id, `cd ${JSON.stringify(dir)}\n`);
                setActive(id);
                router.push("/dashboard/terminal");
              }}
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
      )}
    </div>
  );
}
