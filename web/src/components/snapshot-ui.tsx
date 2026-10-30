"use client";

import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Snapshot } from "@/lib/snapshot";
import { Status } from "@/lib/status";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

export function useSnapshot() {
  return useSWR<Snapshot>("/api/snapshot", fetcher, {
    refreshInterval: 60_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });
}

export function SnapshotBoundary({ data, error, isLoading, children }: {
  data?: Snapshot;
  error?: unknown;
  isLoading: boolean;
  children: (snapshot: Snapshot) => React.ReactNode;
}) {
  if (error) return <Card><CardContent className="py-8 text-red-500">Failed to collect live data: {String(error)}</CardContent></Card>;
  if (isLoading && !data) return <Skeleton className="h-96 w-full" />;
  return data ? <>{children(data)}</> : null;
}

export function StatusBadge({ status }: { status?: Status | string }) {
  const colors: Record<string, string> = {
    [Status.HEALTHY]: "bg-green-600 text-white",
    [Status.INFO]: "bg-blue-600 text-white",
    [Status.WARNING]: "bg-amber-500 text-black",
    [Status.CRITICAL]: "bg-red-600 text-white",
    [Status.UNKNOWN]: "bg-slate-500 text-white",
  };
  const value = status ?? Status.UNKNOWN;
  return <Badge className={colors[value] ?? colors[Status.UNKNOWN]}>{value}</Badge>;
}

export function ReadingCards({ readings }: { readings: any[] }) {
  if (!readings.length) return <Card><CardContent className="py-6 text-muted-foreground">No readings are available yet.</CardContent></Card>;
  return <div className="grid gap-4 lg:grid-cols-2">{readings.map((reading) => (
    <Card key={reading.key}>
      <CardHeader className="pb-2"><div className="flex items-start justify-between gap-3"><CardTitle className="text-base">{reading.label}</CardTitle><StatusBadge status={reading.status} /></div></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold font-mono">{reading.value ?? "—"}{reading.value != null ? reading.unit ?? "" : ""}</p>
        <p className="text-sm text-muted-foreground">{reading.detail || "No detail reported."}</p>
        <p className="text-xs text-muted-foreground">Source: {reading.source || "unknown"}</p>
      </CardContent>
    </Card>
  ))}</div>;
}

export function DataTable({ rows, empty = "No data available." }: { rows: Array<Record<string, unknown>>; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b">{columns.map((column) => <th key={column} className="py-2 pr-4 text-left font-medium text-muted-foreground">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-b border-border/40">{columns.map((column) => <td key={column} className="py-2 pr-4 font-mono text-xs">{formatCell(row[column])}</td>)}</tr>)}</tbody></table></div>;
}

function formatCell(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
