import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Streamanator Dashboard",
  description: "NOC Console for Streamanator Home Server",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="flex h-screen bg-background font-sans text-foreground antialiased">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto px-4 pb-6 pt-20 md:p-8">
          {children}
        </main>
      </body>
    </html>
  );
}
