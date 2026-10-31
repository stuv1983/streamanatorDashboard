import { Status, type ComponentHealth, type Alert, type Reading, worst } from '../status';
import { COMPONENT_WEIGHTS } from './thresholds';

export const STATUS_SCORE: Record<Status, number> = {
    [Status.HEALTHY]: 1.0,
    [Status.INFO]: 0.97,
    [Status.UNKNOWN]: 0.55,
    [Status.WARNING]: 0.55,
    [Status.CRITICAL]: 0.0,
};

export const SEVERITY_CEILING: Partial<Record<Status, number>> = {
    [Status.CRITICAL]: 84.0,
    [Status.WARNING]: 94.0,
    [Status.UNKNOWN]: 96.0,
};

export const HEALTHY_FLOOR = 90.0;
export const DEGRADED_FLOOR = 70.0;

export interface HealthScore {
    score: number;
    status: Status;
    components: ComponentHealth[];
    reason: string;
    criticalCount: number;
    warningCount: number;
    unknownCount: number;
    /** Weighted score before the severity ceiling; differs from `score` when a fault capped it. */
    rawScore?: number;
}

export class HealthScoreResult implements HealthScore {
    score: number;
    status: Status;
    components: ComponentHealth[];
    reason: string;
    criticalCount: number;
    warningCount: number;
    unknownCount: number;
    rawScore?: number;

    constructor(init: HealthScore) {
        this.score = init.score;
        this.status = init.status;
        this.components = init.components;
        this.reason = init.reason;
        this.criticalCount = init.criticalCount;
        this.warningCount = init.warningCount;
        this.unknownCount = init.unknownCount;
        this.rawScore = init.rawScore;
    }

    get label(): string {
        switch (this.status) {
            case Status.HEALTHY: return "HEALTHY";
            case Status.INFO: return "HEALTHY";
            case Status.WARNING: return "DEGRADED";
            case Status.CRITICAL: return "CRITICAL";
            case Status.UNKNOWN: return "UNKNOWN";
            default: return "UNKNOWN";
        }
    }

    get worstComponents(): ComponentHealth[] {
        const rank = {
            [Status.CRITICAL]: 4,
            [Status.WARNING]: 3,
            [Status.UNKNOWN]: 2,
            [Status.INFO]: 1,
            [Status.HEALTHY]: 0
        };

        return [...this.components].sort((a, b) => {
            const rankA = rank[a.status] ?? 0;
            const rankB = rank[b.status] ?? 0;
            if (rankA !== rankB) {
                return rankB - rankA;
            }
            return b.weight - a.weight;
        });
    }
}

export function scoreComponent(
    key: string,
    label: string,
    readings: (Reading | null | undefined)[],
    alerts: Alert[] | null = null,
    weight: number | null = null,
    detail: string = ""
): ComponentHealth {
    const validReadings = readings.filter((r): r is Reading => r != null && r.optional !== true);
    const statuses = validReadings.map(r => r.status);
    const componentStatus = statuses.length > 0 ? worst(statuses) : Status.UNKNOWN;

    let score: number;
    if (statuses.length > 0) {
        score = statuses.reduce((acc, s) => acc + (STATUS_SCORE[s] ?? 0), 0) / statuses.length;
    } else {
        score = STATUS_SCORE[Status.UNKNOWN];
    }

    return {
        key,
        label,
        status: componentStatus,
        weight: weight !== null ? weight : (COMPONENT_WEIGHTS[key] ?? 0.0),
        score,
        detail,
        readings: readings.filter((r): r is Reading => r != null),
        alerts: alerts || []
    };
}

export function calculateHealthScore(components: ComponentHealth[]): HealthScoreResult {
    if (!components || components.length === 0) {
        return new HealthScoreResult({
            score: 0.0,
            status: Status.UNKNOWN,
            components: [],
            reason: "No health components were evaluated.",
            criticalCount: 0,
            warningCount: 0,
            unknownCount: 0
        });
    }

    let totalWeight = 0;
    for (const c of components) {
        totalWeight += c.weight;
    }

    let rawScore = 0.0;
    if (totalWeight > 0) {
        let weightedScoreSum = 0;
        for (const c of components) {
            weightedScoreSum += c.score * c.weight;
        }
        rawScore = 100.0 * weightedScoreSum / totalWeight;
    }

    const worstStatus = worst(components.map(c => c.status));
    const ceiling = SEVERITY_CEILING[worstStatus];
    const score = ceiling !== undefined ? Math.min(rawScore, ceiling) : rawScore;

    const critical = components.filter(c => c.status === Status.CRITICAL);
    const warning = components.filter(c => c.status === Status.WARNING);
    const unknown = components.filter(c => c.status === Status.UNKNOWN);

    let status: Status;
    let reason: string;

    if (critical.length > 0) {
        status = Status.CRITICAL;
        reason = summarise("Critical", critical);
    } else if (warning.length > 0) {
        status = Status.WARNING;
        reason = summarise("Degraded", warning);
    } else if (unknown.length > 0) {
        status = Status.UNKNOWN;
        reason = summarise("Not measurable", unknown);
    } else if (score >= HEALTHY_FLOOR) {
        status = Status.HEALTHY;
        reason = "All monitored components are healthy.";
    } else if (score >= DEGRADED_FLOOR) {
        status = Status.WARNING;
        reason = "Multiple components are below their normal operating range.";
    } else {
        status = Status.CRITICAL;
        reason = "Overall health is well below normal.";
    }

    const roundedScore = Math.round(score * 10) / 10;

    return new HealthScoreResult({
        score: roundedScore,
        status,
        components,
        reason,
        criticalCount: critical.length,
        warningCount: warning.length,
        unknownCount: unknown.length,
        rawScore: Math.round(rawScore * 10) / 10
    });
}

function summarise(prefix: string, components: ComponentHealth[]): string {
    const names = components.slice(0, 4).map(c => c.label).join(', ');
    const extra = components.length <= 4 ? '' : ` (+${components.length - 4} more)`;
    return `${prefix}: ${names}${extra}`;
}

export function collectAlerts(components: ComponentHealth[]): Alert[] {
    const alerts: Alert[] = [];
    for (const component of components) {
        if (component.alerts) {
            alerts.push(...component.alerts);
        }
    }
    return sortAlerts(alerts);
}

export function sortAlerts(alerts: Alert[]): Alert[] {
    const rank = {
        [Status.CRITICAL]: 4,
        [Status.WARNING]: 3,
        [Status.UNKNOWN]: 2,
        [Status.INFO]: 1,
        [Status.HEALTHY]: 0
    };

    return [...alerts].sort((a, b) => {
        const rankA = rank[a.status] ?? 0;
        const rankB = rank[b.status] ?? 0;
        if (rankA !== rankB) {
            return rankB - rankA;
        }
        const sinceA = a.since ?? 0;
        const sinceB = b.since ?? 0;
        return sinceB - sinceA;
    });
}
