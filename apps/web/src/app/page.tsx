import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">webxterm</h1>
      <p className="mt-3 text-lg text-neutral-500 dark:text-neutral-400">
        Open a browser. Generate a key. Connect to any server.
        <br />
        Nothing to install — on either end.
      </p>

      <div className="mt-8 flex gap-3">
        <Link
          href="/workspace"
          className="rounded-md bg-[#6aa9ff] px-4 py-2 font-medium text-[#07101f] hover:bg-[#7fb5ff]"
        >
          Open workspace
        </Link>
        <Link
          href="/sign-in"
          className="rounded-md border border-neutral-300 px-4 py-2 font-medium dark:border-neutral-700"
        >
          Sign in
        </Link>
      </div>

      <section className="mt-14 grid gap-6 sm:grid-cols-3">
        <Feature title="End-to-end encrypted">
          The SSH client runs in your tab. Our relay forwards ciphertext it
          cannot read.
        </Feature>
        <Feature title="Keys that can't leak">
          Generated non-extractable in WebCrypto. Not readable by our code, an
          extension, or an injected script.
        </Feature>
        <Feature title="One line on the server">
          Append a public key to <code>authorized_keys</code>. Stock sshd, no
          agent, no daemon.
        </Feature>
      </section>

      <p className="mt-14 text-xs text-neutral-500">
        Phase 1 · terminal, key custody, and SFTP over a browser WASM SSH core.
      </p>
    </main>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">{children}</p>
    </div>
  );
}
