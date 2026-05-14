import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "H2H Arbitrage — Kalshi x Polymarket",
  description: "Real-time head-to-head arbitrage scanner",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
