import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/**
 * The shared furniture for the privacy policy and the terms.
 *
 * /security has its own private copies of these, deliberately left alone: that
 * page is a long argument with diagrams and a verdict table, and pulling it
 * apart to share four primitives would be a large diff in a page nobody asked
 * to change. These two are new and can start shared.
 */

export function LegalSection({
  id,
  index,
  title,
  children,
}: {
  id: string
  index: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      /* last:border-b-0 — the footer already draws a rule under the last one. */
      className="scroll-mt-20 border-b border-border py-10 last:border-b-0"
    >
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-xs font-medium tracking-wider text-primary tabular-nums">
          {index}
        </span>
        <h2 className="font-heading text-lg font-semibold tracking-tight text-balance">{title}</h2>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

export function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`max-w-3xl text-sm leading-relaxed text-muted-foreground ${className ?? ""}`}>
      {children}
    </p>
  )
}

export function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="font-heading pt-2 text-sm font-medium">{children}</h3>
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="max-w-3xl list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static prose, never reordered
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

/**
 * A row of the data inventory.
 *
 * Three columns because those are the three questions the law asks and a reader
 * actually has: what is held, why it is held, and how long it stays. A policy
 * that answers the first and skips the third is the shape most of them take and
 * is the least useful part to leave out.
 */
export interface DataRow {
  what: string
  why: string
  kept: string
}

export function DataTable({ rows }: { rows: DataRow[] }) {
  return (
    <div className="max-w-3xl overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[34%]">What</TableHead>
            <TableHead>Why</TableHead>
            <TableHead className="w-[24%]">Kept</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.what}>
              <TableCell className="align-top text-foreground">{row.what}</TableCell>
              <TableCell className="align-top text-muted-foreground">{row.why}</TableCell>
              <TableCell className="align-top text-muted-foreground">{row.kept}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * The banner that says a document is not finished.
 *
 * Rendered only while lib/legal.ts still carries a placeholder, and it names
 * which one. A policy missing the controller's identity is not a policy, and
 * shipping one that looks complete is worse than shipping one that says so.
 */
export function UnfinishedNotice({ detail }: { detail: string }) {
  if (!detail.startsWith("TODO")) return null
  return (
    <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
      This document is not finished: the operator has not filled in its legal identity and contact
      details. It is published for review, not as a statement anyone should rely on.
    </div>
  )
}
