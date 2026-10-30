export enum Status {
    HEALTHY = "HEALTHY",
    INFO = "INFO",
    WARNING = "WARNING",
    CRITICAL = "CRITICAL",
    UNKNOWN = "UNKNOWN"
}

const _RANK: Record<Status, number> = {
    [Status.HEALTHY]: 0,
    [Status.INFO]: 1,
    [Status.UNKNOWN]: 2,
    [Status.WARNING]: 3,
    [Status.CRITICAL]: 4,
};

const _ICON: Record<Status, string> = {
    [Status.HEALTHY]: "check_circle",
    [Status.INFO]: "info",
    [Status.WARNING]: "warning",
    [Status.CRITICAL]: "e911_emergency",
    [Status.UNKNOWN]: "help",
};

const _LABEL: Record<Status, string> = {
    [Status.HEALTHY]: "Healthy",
    [Status.INFO]: "Info",
    [Status.WARNING]: "Warning",
    [Status.CRITICAL]: "Critical",
    [Status.UNKNOWN]: "Unknown",
};

const _TOOLTIP: Record<Status, string> = {
    [Status.HEALTHY]: "Measured and within thresholds.",
    [Status.INFO]: "Notable change, no action required.",
    [Status.WARNING]: "Outside normal range — investigate when convenient.",
    [Status.CRITICAL]: "Service-affecting or data-at-risk — investigate now.",
    [Status.UNKNOWN]: "Could not be measured. Not the same as healthy.",
};

export function getRank(status: Status): number {
    return _RANK[status];
}

export function getIcon(status: Status): string {
    return _ICON[status];
}

export function getLabel(status: Status): string {
    return _LABEL[status];
}

export function getTooltip(status: Status): string {
    return _TOOLTIP[status];
}

export function worst(statuses: Iterable<Status>): Status {
    const arr = Array.from(statuses);
    if (arr.length === 0) return Status.HEALTHY;
    const ranked = arr.sort((a, b) => getRank(b) - getRank(a));
    return ranked[0];
}

export function worstWith(status: Status, ...others: Status[]): Status {
    return worst([status, ...others]);
}

export enum DataState {
    OK = "OK",
    NO_DATA = "NO_DATA",
    NOT_CONFIGURED = "NOT_CONFIGURED",
    STALE = "STALE",
    ERROR = "ERROR"
}

export class Reading<T = any> {
    key: string;
    label: string;
    value: T | null;
    unit: string;
    status: Status;
    state: DataState;
    detail: string;
    source: string;
    collected_at: number;
    threshold: string;
    extra: Record<string, any>;
    optional: boolean;

    constructor({
        key,
        label,
        value = null,
        unit = "",
        status = Status.UNKNOWN,
        state = DataState.OK,
        detail = "",
        source = "",
        collected_at,
        threshold = "",
        extra = {},
        optional = false,
    }: {
        key: string;
        label: string;
        value?: T | null;
        unit?: string;
        status?: Status;
        state?: DataState;
        detail?: string;
        source?: string;
        collected_at?: number;
        threshold?: string;
        extra?: Record<string, any>;
        optional?: boolean;
    }) {
        this.key = key;
        this.label = label;
        this.value = value;
        this.unit = unit;
        this.status = status;
        this.state = state;
        this.detail = detail;
        this.source = source;
        this.collected_at = collected_at ?? (Date.now() / 1000);
        this.threshold = threshold;
        this.extra = extra;
        this.optional = optional;
    }

    get age_seconds(): number {
        return Math.max(0.0, (Date.now() / 1000) - this.collected_at);
    }

    get has_value(): boolean {
        return this.value !== null && (this.state === DataState.OK || this.state === DataState.STALE);
    }

    get display_value(): string {
        if (this.state === DataState.NOT_CONFIGURED) {
            return "NOT CONFIGURED";
        }
        if (this.state === DataState.NO_DATA) {
            return "NO DATA";
        }
        if (this.state === DataState.ERROR) {
            return "ERROR";
        }
        if (this.value === null) {
            return "—";
        }
        
        let text: string;
        if (typeof this.value === "number") {
            let formatted = this.value.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
            if (formatted.includes('.')) {
                formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
            }
            text = formatted;
        } else {
            text = String(this.value);
        }
        
        return this.unit ? `${text}${this.unit}` : text;
    }

    stale_after(seconds: number): this {
        if (this.state === DataState.OK && this.age_seconds > seconds) {
            this.state = DataState.STALE;
            this.status = Status.UNKNOWN;
            
            const ageStr = Math.round(this.age_seconds).toLocaleString('en-US');
            const secStr = Math.round(seconds).toLocaleString('en-US');
            
            const prefix = `Data is ${ageStr}s old (freshness budget ${secStr}s).`;
            this.detail = this.detail ? `${prefix} ${this.detail}`.trim() : prefix;
        }
        return this;
    }

    static not_configured(
        key: string,
        label: string,
        detail: string,
        source: string = "",
        optional: boolean = false
    ): Reading<any> {
        return new Reading({
            key,
            label,
            value: null,
            status: Status.UNKNOWN,
            state: DataState.NOT_CONFIGURED,
            detail,
            source,
            optional
        });
    }

    static no_data(
        key: string,
        label: string,
        detail: string = "",
        source: string = ""
    ): Reading<any> {
        return new Reading({
            key,
            label,
            value: null,
            status: Status.UNKNOWN,
            state: DataState.NO_DATA,
            detail: detail || "No data returned for this series.",
            source
        });
    }

    static error(
        key: string,
        label: string,
        detail: string,
        source: string = ""
    ): Reading<any> {
        return new Reading({
            key,
            label,
            value: null,
            status: Status.UNKNOWN,
            state: DataState.ERROR,
            detail,
            source
        });
    }
}

export class Alert {
    key: string;
    status: Status;
    title: string;
    component: string;
    detail: string;
    current_value: string;
    threshold: string;
    probable_cause: string;
    recommended_action: string;
    since: number | null;
    caused_by: string | null;
    effects: string[];

    constructor({
        key,
        status,
        title,
        component,
        detail = "",
        current_value = "",
        threshold = "",
        probable_cause = "",
        recommended_action = "",
        since = null,
        caused_by = null,
        effects = []
    }: {
        key: string;
        status: Status;
        title: string;
        component: string;
        detail?: string;
        current_value?: string;
        threshold?: string;
        probable_cause?: string;
        recommended_action?: string;
        since?: number | null;
        caused_by?: string | null;
        effects?: string[];
    }) {
        this.key = key;
        this.status = status;
        this.title = title;
        this.component = component;
        this.detail = detail;
        this.current_value = current_value;
        this.threshold = threshold;
        this.probable_cause = probable_cause;
        this.recommended_action = recommended_action;
        this.since = since;
        this.caused_by = caused_by;
        this.effects = effects;
    }

    get is_actionable(): boolean {
        return this.status === Status.WARNING || this.status === Status.CRITICAL;
    }
}

export class ChangeEvent {
    timestamp: number;
    category: string;
    summary: string;
    detail: string;
    status: Status;

    constructor({
        timestamp,
        category,
        summary,
        detail = "",
        status = Status.INFO
    }: {
        timestamp: number;
        category: string;
        summary: string;
        detail?: string;
        status?: Status;
    }) {
        this.timestamp = timestamp;
        this.category = category;
        this.summary = summary;
        this.detail = detail;
        this.status = status;
    }
}

export class ComponentHealth {
    key: string;
    label: string;
    status: Status;
    weight: number;
    score: number;
    detail: string;
    readings: Reading<any>[];
    alerts: Alert[];

    constructor({
        key,
        label,
        status,
        weight,
        score,
        detail = "",
        readings = [],
        alerts = []
    }: {
        key: string;
        label: string;
        status: Status;
        weight: number;
        score: number;
        detail?: string;
        readings?: Reading<any>[];
        alerts?: Alert[];
    }) {
        this.key = key;
        this.label = label;
        this.status = status;
        this.weight = weight;
        this.score = score;
        this.detail = detail;
        this.readings = readings;
        this.alerts = alerts;
    }
}
