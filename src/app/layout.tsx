import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ApiTokenProvider } from "@/components/ApiTokenProvider";

export const metadata: Metadata = {
  title: "EdgeFinder — Kalshi x Polymarket",
  description: "Real-time head-to-head arbitrage scanner",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased min-h-screen">
        <ApiTokenProvider><ThemeProvider>{children}</ThemeProvider></ApiTokenProvider>
      </body>
    </html>
  );
}
