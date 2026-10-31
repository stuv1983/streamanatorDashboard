import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

// Bundled, not fetched: the Pi kiosk must render text with no network.
const atkinson = localFont({ src: "./fonts/atkinson-next.woff2", weight: "200 800", variable: "--font-atkinson", display: "swap" });
const atkinsonMono = localFont({ src: "./fonts/atkinson-mono.woff2", weight: "200 800", variable: "--font-atkinson-mono", display: "swap" });
const michroma = localFont({ src: "./fonts/michroma.woff2", weight: "400", variable: "--font-michroma", display: "swap" });

export const metadata: Metadata = {
  title: "Streamanator",
  description: "Operations console for the streamanator home server",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${atkinson.variable} ${atkinsonMono.variable} ${michroma.variable}`}>
      <body className="flex min-h-screen flex-col bg-background font-sans text-foreground antialiased md:h-screen md:flex-row">
        <Sidebar />
        <main id="main" className="min-w-0 flex-1 overflow-y-auto px-4 pb-14 pt-6 md:px-11 md:pt-6">
          <div className="mx-auto w-full max-w-[1240px]">{children}</div>
        </main>
      </body>
    </html>
  );
}
