"use client";

import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Status, Alert } from '@/lib/status';
import type { Snapshot } from '@/lib/snapshot';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface DashboardClientProps {
  hostname: string;
}

function StatusBadge({ status }: { status: Status }) {
  let colorClass = "bg-gray-500 hover:bg-gray-600 text-white";
  switch (status) {
    case Status.HEALTHY: colorClass = "bg-green-500 hover:bg-green-600 text-white"; break;
    case Status.INFO: colorClass = "bg-blue-500 hover:bg-blue-600 text-white"; break;
    case Status.WARNING: colorClass = "bg-yellow-500 hover:bg-yellow-600 text-white"; break;
    case Status.CRITICAL: colorClass = "bg-red-500 hover:bg-red-600 text-white"; break;
  }
  
  return (
    <Badge className={`${colorClass} px-3 py-1 font-semibold text-xs tracking-wider shadow-sm transition-colors`}>
      {status}
    </Badge>
  );
}

export default function DashboardClient({ hostname }: DashboardClientProps) {
  // Poll every 60 seconds
  const { data, error, isLoading } = useSWR<Snapshot>('/api/snapshot', fetcher, { 
    refreshInterval: 60000,
    keepPreviousData: true 
  });

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-red-500 space-y-4">
        <h2 className="text-xl font-bold">Failed to load snapshot</h2>
        <pre className="text-sm bg-red-50/10 p-4 rounded-md">{String(error)}</pre>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-2">Loading system health...</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
           {[...Array(4)].map((_, i) => (
             <Card key={i}>
                <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
                <CardContent><Skeleton className="h-8 w-16" /></CardContent>
             </Card>
           ))}
        </div>
      </div>
    );
  }

  const snapshot = data!;
  const health = snapshot.health;
  
  // Convert components object to array and sort by status severity (critical first)
  const components = Object.values(snapshot.components).sort((a, b) => {
      const rank = {
          [Status.CRITICAL]: 4,
          [Status.WARNING]: 3,
          [Status.UNKNOWN]: 2,
          [Status.INFO]: 1,
          [Status.HEALTHY]: 0
      };
      return (rank[b.status] || 0) - (rank[a.status] || 0);
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-2 text-lg">
            System health and indicators for <span className="font-semibold text-foreground">{hostname}</span>
          </p>
        </div>
        
        <Card className="bg-card/50 backdrop-blur-sm border-muted shadow-sm md:w-64 shrink-0 overflow-hidden relative">
          {/* Subtle color bar at top based on health status */}
          <div className={`absolute top-0 left-0 right-0 h-1 ${
              health.status === Status.HEALTHY ? "bg-green-500" :
              health.status === Status.WARNING ? "bg-yellow-500" :
              health.status === Status.CRITICAL ? "bg-red-500" : "bg-gray-500"
          }`} />
          
          <CardHeader className="pb-2 pt-5">
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground flex justify-between items-center">
              Overall Health
              <StatusBadge status={health.status} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-extrabold tracking-tighter">
                {health.score.toFixed(0)}
              </span>
              <span className="text-lg text-muted-foreground mb-1 font-medium">/ 100</span>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Active Incidents Section */}
      {snapshot.incidents && snapshot.incidents.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            Active Incidents
            <Badge variant="destructive" className="ml-2 bg-red-500">{snapshot.incidents.length}</Badge>
          </h2>
          <div className="grid gap-4">
            {snapshot.incidents.map((incident, i) => (
              <Card key={i} className="border-red-200/50 bg-red-50/5 dark:bg-red-950/20 dark:border-red-900/50 overflow-hidden">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500" />
                <CardHeader className="pl-6 pb-2 pt-4">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg font-semibold text-red-700 dark:text-red-400">
                      {incident.title || incident.cause?.title || "Incident"}
                    </CardTitle>
                    <StatusBadge status={Status.CRITICAL} />
                  </div>
                </CardHeader>
                <CardContent className="pl-6 text-sm">
                  <p className="text-foreground/90 leading-relaxed mb-3">{incident.explanation || incident.cause?.detail}</p>
                  
                  {incident.effects && incident.effects.length > 0 && (
                     <div className="mt-4 p-3 bg-background/50 rounded-md border text-xs text-muted-foreground">
                       <p className="font-medium text-foreground mb-2">Correlated Alerts:</p>
                       <ul className="list-disc list-inside space-y-1">
                         {incident.effects.map((a: Alert, j: number) => (
                           <li key={j}>{a.title}</li>
                         ))}
                       </ul>
                     </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Components Grid */}
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Subsystems</h2>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {components.map(component => (
            <Card key={component.key} className="flex flex-col h-full border-muted/60 shadow-sm hover:shadow-md transition-shadow">
              <CardHeader className="pb-3 border-b border-border/40 bg-muted/20">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg font-semibold tracking-tight">
                    {component.label}
                  </CardTitle>
                  <StatusBadge status={component.status} />
                </div>
              </CardHeader>
              <CardContent className="pt-5 flex-grow flex flex-col justify-between">
                <div>
                   <p className="text-sm text-muted-foreground leading-relaxed">
                     {component.detail || "No details provided."}
                   </p>
                </div>
                
                {component.readings && component.readings.length > 0 && (
                   <div className="mt-6 space-y-3">
                     {component.readings.slice(0, 4).map((r, idx) => (
                        <div key={idx} className="flex justify-between items-center text-sm py-1 border-b border-border/30 last:border-0">
                          <span className="font-medium text-foreground/80">{r.label}</span>
                          <span className="text-foreground font-mono">{r.value !== undefined && r.value !== null ? `${r.value}${r.unit || ''}` : '—'}</span>
                        </div>
                     ))}
                   </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
