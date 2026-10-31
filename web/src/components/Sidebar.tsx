"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { useSnapshot } from "@/components/snapshot-ui";
import { Lamp } from "@/components/instrument";

/** `component` ties a nav item to a scored subsystem, which lights its lamp. */
const NAV: Array<{ title?: string; items: Array<{ href: string; label: string; component?: string }> }> = [
  { items: [{ href: "/", label: "Overview" }, { href: "/home", label: "Apps & media" }, { href: "/hub", label: "Home hub" }, { href: "/wall", label: "Wall display" }] },
  {
    title: "Live",
    items: [
      { href: "/live", label: "Task Manager" },
      { href: "/processes", label: "Processes" },
      { href: "/connections", label: "Connections" },
      { href: "/services", label: "Services" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { href: "/network", label: "Network", component: "network" },
      { href: "/server", label: "Server", component: "server" },
      { href: "/performance", label: "Performance history" },
      { href: "/storage", label: "Storage", component: "storage" },
      { href: "/raid", label: "RAID & disks", component: "raid_disks" },
    ],
  },
  {
    title: "Services",
    items: [
      { href: "/docker", label: "Docker", component: "containers" },
      { href: "/vpn", label: "VPN", component: "vpn" },
      { href: "/media", label: "Media" },
      { href: "/applications", label: "Applications", component: "applications" },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/alerts", label: "Alert rules", component: "conditions" },
      { href: "/events", label: "Events & changes" },
      { href: "/inventory", label: "Inventory" },
      { href: "/backups", label: "Backups", component: "backups" },
      { href: "/security", label: "Security", component: "security" },
      { href: "/diagnostics", label: "Diagnostics" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const kiosk = pathname.startsWith("/wall") || pathname.startsWith("/hub");
  const { data } = useSnapshot();

  useEffect(() => setIsOpen(false), [pathname]);

  // The wall display and home hub are full-screen kiosk views with no navigation.
  if (kiosk) return null;

  const overall = data?.health?.status;

  return (
    <>
      <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-seam bg-well px-4 py-2 md:hidden">
        <span className="flex items-center gap-2.5 font-panel text-xs tracking-[0.16em] text-silk">
          {overall && <Lamp status={overall} label={`Overall ${String(overall).toLowerCase()}`} />}
          STREAMANATOR
        </span>
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(true)}
          className="grid h-11 w-11 place-items-center rounded-[3px] border border-seam bg-bezel"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>
      {isOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}
      <aside
        aria-label="Navigation"
        className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-[252px] shrink-0 flex-col border-r border-seam bg-well transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${isOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-start justify-between gap-2 px-6 pb-5 pt-[26px]">
          <Link href="/" className="flex flex-col gap-1.5 text-silk no-underline">
            <span className="flex items-center gap-2.5 font-panel text-[13px] tracking-[0.16em]">
              STREAMANATOR
            </span>
            <span className="flex items-center gap-2 font-mono text-xs text-graphite">
              {overall ? <><Lamp status={overall} />{overall === "HEALTHY" ? "All healthy" : `Overall ${String(overall).toLowerCase()}`}</> : "Operations console"}
            </span>
          </Link>
          <button type="button" aria-label="Close navigation" onClick={() => setIsOpen(false)} className="-mr-3 -mt-2 grid h-11 w-11 place-items-center rounded-[3px] hover:bg-bezel md:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-[22px] overflow-y-auto px-3.5 pb-4">
          {NAV.map(section => (
            <div key={section.title ?? "home"} className="flex flex-col gap-2">
              {section.title && <h2 className="panel-label m-0 px-2.5">{section.title}</h2>}
              <div className="flex flex-col gap-0.5">
                {section.items.map(({ href, label, component }) => {
                  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
                  const status = component ? data?.components?.[component]?.status : undefined;
                  return (
                    <Link
                      key={href}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-[38px] items-center justify-between gap-2.5 rounded-[3px] px-2.5 text-[14.5px] no-underline hover:bg-bezel hover:text-silk ${active ? "bg-bezel text-silk shadow-[inset_0_0_0_1px_var(--seam)]" : "text-silk-dim"}`}
                    >
                      <span>{label}</span>
                      {status && <Lamp status={status} label={String(status).toLowerCase()} />}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-seam px-3.5 py-3.5">
          <Link
            href="/admin"
            aria-current={pathname.startsWith("/admin") ? "page" : undefined}
            className={`flex min-h-[38px] items-center rounded-[3px] px-2.5 text-[14.5px] no-underline hover:bg-bezel hover:text-silk ${pathname.startsWith("/admin") ? "bg-bezel text-silk" : "text-silk-dim"}`}
          >
            Admin
          </Link>
        </div>
      </aside>
    </>
  );
}
