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
} from "lucide-react";

export function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => setIsOpen(false), [pathname]);

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
        <div className="space-y-1">
          <Link href="/" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground bg-accent">
            <Home className="h-4 w-4" />
            Overview
          </Link>
        </div>

        <div>
          <h3 className="px-3 text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Infrastructure</h3>
          <div className="space-y-1">
            <Link href="/network" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Network className="h-4 w-4" /> Network
            </Link>
            <Link href="/server" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Server className="h-4 w-4" /> Server
            </Link>
            <Link href="/performance" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Gauge className="h-4 w-4" /> Performance
            </Link>
            <Link href="/storage" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <HardDrive className="h-4 w-4" /> Storage
            </Link>
            <Link href="/raid" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Database className="h-4 w-4" /> RAID & Disks
            </Link>
          </div>
        </div>

        <div>
          <h3 className="px-3 text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Services</h3>
          <div className="space-y-1">
            <Link href="/docker" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Layers className="h-4 w-4" /> Docker
            </Link>
            <Link href="/vpn" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Shield className="h-4 w-4" /> VPN
            </Link>
            <Link href="/media" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Film className="h-4 w-4" /> Media
            </Link>
            <Link href="/applications" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Activity className="h-4 w-4" /> Applications
            </Link>
          </div>
        </div>

        <div>
          <h3 className="px-3 text-xs font-semibold uppercase text-muted-foreground mb-2 tracking-wider">Operations</h3>
          <div className="space-y-1">
            <Link href="/backups" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <FileText className="h-4 w-4" /> Backups
            </Link>
            <Link href="/security" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Shield className="h-4 w-4" /> Security
            </Link>
            <Link href="/diagnostics" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              <Stethoscope className="h-4 w-4" /> Diagnostics
            </Link>
          </div>
        </div>

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
