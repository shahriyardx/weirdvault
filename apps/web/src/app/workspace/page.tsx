import { redirect } from "next/navigation";

/**
 * The workspace used to be a separate page with its own connection handling,
 * which meant two implementations of the same thing drifting apart. The
 * dashboard is now the application, so this is just an entry point into it.
 */
export default function WorkspaceRedirect() {
  redirect("/dashboard/terminal");
}
