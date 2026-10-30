"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Database,
  FileText,
  HardDrive,
  Home,
  Layers,
  Lock,
  Film,
  Network,
  Server,
  Shield,
  Stethoscope,
  Gauge,
  Menu,
  X,
  Cpu,
  ListTree,
  Cable,
  Cog,
  History,
  Package,
  MonitorPlay,
  BellRing,
} from "lucide-react";

const NAV: Array<{ title?: string; items: Array<{ href: string; label: string; icon: typeof Home }> }> = [
  { items: [{ href: "/", label: "Overview", icon: Home }, { href: "/wall", label: "Wall display", icon: MonitorPlay }] },
  {
    title: "Live",
    items: [
      { href: "/live", label: "Task Manager", icon: Cpu },
      { href: "/processes", label: "Processes", icon: ListTree },
      { href: "/connections", label: "Connections", icon: Cable },
      { href: "/services", label: "Services", icon: Cog },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { href: "/network", label: "Network", icon: Network },
      { href: "/server", label: "Server", icon: Server },
      { href: "/performance", label: "Performance history", icon: Gauge },
      { href: "/storage", label: "Storage", icon: HardDrive },
      { href: "/raid", label: "RAID & Disks", icon: Database },
    ],
  },
  {
    title: "Services",
    items: [
      { href: "/docker", label: "Docker", icon: Layers },
      { href: "/vpn", label: "VPN", icon: Shield },
      { href: "/media", label: "Media", icon: Film },
      { href: "/applications", label: "Applications", icon: Activity },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/alerts", label: "Alert rules", icon: BellRing },
      { href: "/events", label: "Events & changes", icon: History },
      { href: "/inventory", label: "Inventory", icon: Package },
      { href: "/backups", label: "Backups", icon: FileText },
      { href: "/security", label: "Security", icon: Shield },
      { href: "/diagnostics", label: "Diagnostics", icon: Stethoscope },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => setIsOpen(false), [pathname]);

  // The wall display is a full-screen kiosk view with no navigation.
  if (pathname.startsWith("/wall")) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
        className="fixed left-4 top-4 z-40 grid h-11 w-11 place-items-center rounded-lg border bg-background/95 shadow-sm backdrop-blur md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      {isOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}
      <aside className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-64 flex-col border-r bg-background transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${isOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="flex items-start justify-between border-b p-6">
        <div>
        <h2 className="text-xl font-bold tracking-tight">Streamanator</h2>
        <p className="text-sm text-muted-foreground mt-1">Dashboard</p>
        </div>
        <button type="button" aria-label="Close navigation menu" onClick={() => setIsOpen(false)} className="-mr-2 -mt-2 grid h-11 w-11 place-items-center rounded-lg hover:bg-accent md:hidden">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
        {NAV.map(section => (
          <div key={section.title ?? "home"}>
            {section.title && <h3 className="px-3 text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">{section.title}</h3>}
            <div className="space-y-1">
              {section.items.map(({ href, label, icon: Icon }) => {
                const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link key={href} href={href} aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground ${active ? "bg-accent text-accent-foreground" : ""}`}>
                    <Icon className="h-4 w-4" /> {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t p-4">
        <Link href="/admin" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <Lock className="h-4 w-4" /> Admin
        </Link>
      </div>
      </aside>
    </>
  );
}
