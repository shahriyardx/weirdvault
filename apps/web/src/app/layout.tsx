import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import "./globals.css";

const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: {
    default: "webxterm — SSH in your browser",
    template: "%s · webxterm",
  },
  description:
    "A zero-install SSH workspace. Generate a key in the browser, connect to any server, " +
    "and get a terminal, file explorer and remote editor — with keys that never leave your device.",
  applicationName: "webxterm",
};

export const viewport: Viewport = {
  // Dark only, so tell the browser up front and let native controls match.
  colorScheme: "dark",
  themeColor: "#111318",
  width: "device-width",
  initialScale: 1,
  // The terminal needs the full viewport when the on-screen keyboard opens.
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn("h-full font-mono antialiased", geistSans.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
