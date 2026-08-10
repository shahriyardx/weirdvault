import Link from "next/link"

import { Brand } from "@/components/shell/brand"

const GROUPS = [
  {
    title: "Product",
    links: [
      { href: "/dashboard/terminal", label: "Workspace" },
      { href: "/pricing", label: "Pricing" },
      { href: "/dashboard", label: "Dashboard" },
    ],
  },
  {
    title: "Security",
    links: [
      { href: "/security", label: "How it works" },
      { href: "/security#threat-model", label: "Threat model" },
      { href: "/security#self-host", label: "Self-hosting" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs", label: "Getting started" },
      { href: "/docs#server", label: "Server setup" },
      { href: "/docs#keys", label: "Keys" },
    ],
  },
] as const

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_repeat(3,1fr)]">
        <div>
          <Brand />
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
            SSH from any browser. Keys are generated non-extractable and never leave your device —
            our relay forwards ciphertext it cannot read.
          </p>
        </div>

        {GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {group.title}
            </h3>
            <ul className="mt-3 space-y-2">
              {group.links.map((link) => (
                <li key={link.href + link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:px-6">
          <span>© {new Date().getFullYear()} webxterm</span>
          <span className="sm:ml-auto">End-to-end encrypted · open relay · self-hostable</span>
        </div>
      </div>
    </footer>
  )
}
