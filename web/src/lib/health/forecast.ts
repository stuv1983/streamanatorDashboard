export interface LinearFit {
    slope: number; // Units per second.
    intercept: number;
    rSquared: number;
    sampleCount: number;
    spanSeconds: number;
}

export function linearFit(samples: [number, number][]): LinearFit | null {
    if (samples.length < 3) {
        return null;
    }

    const times = samples.map(s => s[0]);
    const values = samples.map(s => s[1]);
    const n = samples.length;

    const origin = times[0];
    const xs = times.map(t => t - origin);

    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    
    let sxx = 0;
    for (const x of xs) {
        sxx += Math.pow(x - meanX, 2);
    }
    
    if (sxx <= 0) {
        return null;
    }

    let sxy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - meanX) * (values[i] - meanY);
    }

    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;

    let syy = 0;
    for (const y of values) {
        syy += Math.pow(y - meanY, 2);
    }

    let rSquared = 0;
    if (syy <= 0) {
        // A perfectly flat series is a valid fit with zero growth.
        rSquared = 1.0;
    } else {
        let residual = 0;
        for (let i = 0; i < n; i++) {
            residual += Math.pow(values[i] - (intercept + slope * xs[i]), 2);
        }
        rSquared = Math.max(0.0, 1.0 - residual / syy);
    }

    return {
        slope,
        intercept,
        rSquared,
        sampleCount: n,
        spanSeconds: times[times.length - 1] - times[0]
    };
}

export class CapacityForecast {
    available: boolean;
    reason: string;
    growthBytesPerDay: number | null = null;
    growthBytes7d: number | null = null;
    growthBytes30d: number | null = null;
    growthBytes90d: number | null = null;
    rSquared: number | null = null;
    historyDays: number | null = null;
    sampleCount: number = 0;
    date80Percent: number | null = null;
    date90Percent: number | null = null;
    dateFull: number | null = null;

    constructor(available: boolean, reason: string = "", sampleCount: number = 0, historyDays: number | null = null) {
        this.available = available;
        this.reason = reason;
        this.sampleCount = sampleCount;
        this.historyDays = historyDays;
    }

    get growthTbPerMonth(): number | null {
        if (this.growthBytesPerDay === null) {
            return null;
        }
        return (this.growthBytesPerDay * 30.0) / Math.pow(1024, 4);
    }

    get shrinking(): boolean {
        return this.growthBytesPerDay !== null && this.growthBytesPerDay < 0;
    }

    daysUntil(timestamp: number | null): number | null {
        if (timestamp === null) {
            return null;
        }
        return (timestamp - (Date.now() / 1000)) / 86400.0;
    }

    get daysUntil90(): number | null {
        return this.daysUntil(this.date90Percent);
    }

    get daysUntilFull(): number | null {
        return this.daysUntil(this.dateFull);
    }
}

export function growthOver(samples: [number, number][], windowSeconds: number): number | null {
    if (samples.length === 0) {
        return null;
    }
    const [latestTs, latestValue] = samples[samples.length - 1];
    const target = latestTs - windowSeconds;
    
    let baseline: [number, number] | null = null;
    for (const [timestamp, value] of samples) {
        if (timestamp <= target) {
            baseline = [timestamp, value];
        } else {
            break;
        }
    }

    if (baseline === null) {
        // Not enough history for the full window; only report if the available
        // span covers most of it, otherwise the number understates growth.
        const [oldestTs, oldestValue] = samples[0];
        if ((latestTs - oldestTs) < windowSeconds * 0.75) {
            return null;
        }
        return latestValue - oldestValue;
    }
    return latestValue - baseline[1];
}

export function forecastCapacity(
    samples: [number, number][],
    totalBytes: number,
    minHistoryDays: number = 3.0,
    minRSquared: number = 0.5,
    minSamples: number = 10
): CapacityForecast {
    if (totalBytes <= 0) {
        return new CapacityForecast(false, "Filesystem capacity is unknown");
    }

    if (samples.length < minSamples) {
        return new CapacityForecast(
            false,
            `Insufficient history — ${samples.length} samples, need ${minSamples}`,
            samples.length
        );
    }

    const ordered = [...samples].sort((a, b) => a[0] - b[0]);
    const spanDays = (ordered[ordered.length - 1][0] - ordered[0][0]) / 86400.0;
    
    if (spanDays < minHistoryDays) {
        return new CapacityForecast(
            false,
            `Insufficient history — ${spanDays.toFixed(1)} days, need ${minHistoryDays.toFixed(0)}`,
            ordered.length,
            spanDays
        );
    }

    const fit = linearFit(ordered);
    if (fit === null) {
        return new CapacityForecast(false, "Could not fit a trend to the samples", ordered.length);
    }

    const growthPerDay = fit.slope * 86400.0;
    
    const forecast = new CapacityForecast(true);
    forecast.growthBytesPerDay = growthPerDay;
    forecast.growthBytes7d = growthOver(ordered, 7 * 86400);
    forecast.growthBytes30d = growthOver(ordered, 30 * 86400);
    forecast.growthBytes90d = growthOver(ordered, 90 * 86400);
    forecast.rSquared = fit.rSquared;
    forecast.historyDays = spanDays;
    forecast.sampleCount = fit.sampleCount;

    if (fit.rSquared < minRSquared) {
        forecast.available = false;
        forecast.reason = `Growth is too irregular to project (R²=${fit.rSquared.toFixed(2)}, need ${minRSquared.toFixed(2)}). Current growth rate is still shown.`;
        return forecast;
    }

    if (growthPerDay <= 0) {
        forecast.reason = "Usage is flat or falling — no fill date projected.";
        return forecast;
    }

    const currentUsed = ordered[ordered.length - 1][1];
    const now = ordered[ordered.length - 1][0];

    const crossing = (targetFraction: number): number | null => {
        const targetBytes = totalBytes * targetFraction;
        if (currentUsed >= targetBytes) {
            return null;
        }
        const seconds = (targetBytes - currentUsed) / fit.slope;
        if (seconds <= 0 || seconds > 20 * 365 * 86400) {
            return null;
        }
        return now + seconds;
    };

    forecast.date80Percent = crossing(0.80);
    forecast.date90Percent = crossing(0.90);
    forecast.dateFull = crossing(1.0);

    return forecast;
}

export function projectThresholdDate(
    currentValue: number,
    growthPerDay: number,
    targetValue: number
): number | null {
    if (growthPerDay <= 0 || currentValue >= targetValue) {
        return null;
    }
    const days = (targetValue - currentValue) / growthPerDay;
    if (!Number.isFinite(days) || days > 20 * 365) {
        return null;
    }
    return (Date.now() / 1000) + days * 86400.0;
}
