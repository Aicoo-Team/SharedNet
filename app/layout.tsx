import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/albert-sans";
import "@fontsource-variable/anybody";
import "./globals.css";
import "./product-shell.css";
import { AppShell } from "@/src/components/app-shell";

export const metadata: Metadata = {
  title: "SharedNet — Agent Network",
  description: "Give a network of Agents one outcome. SharedNet organizes the work.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
