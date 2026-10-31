import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, statSync } from 'fs';

export class HistoryStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HistoryStoreError';
    }
}

const _SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
    metric TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '',
    ts     REAL NOT NULL,
    value  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_lookup ON samples (metric, labels, ts);

CREATE TABLE IF NOT EXISTS events (
    ts       REAL NOT NULL,
    category TEXT NOT NULL,
    summary  TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '',
    status   TEXT NOT NULL DEFAULT 'INFO'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS state (
    key            TEXT PRIMARY KEY,
    value          TEXT NOT NULL,
    previous_value TEXT,
    updated_at     REAL NOT NULL,
    changed_at     REAL NOT NULL
);
`;

const _TABLES = ["samples", "events", "state"];

function _tablesPresent(db: Database.Database): boolean {
    const placeholders = _TABLES.map(() => '?').join(', ');
    const row = db.prepare(`SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`).get(_TABLES) as { count: number } | undefined;
    return !!row && row.count === _TABLES.length;
}

function _ensureSchema(db: Database.Database): void {
    db.exec(_SCHEMA);
}

function _encodeLabels(labels?: Record<string, string> | null): string {
    if (!labels || Object.keys(labels).length === 0) {
        return "";
    }
    const sortedKeys = Object.keys(labels).sort();
    const sortedLabels: Record<string, string> = {};
    for (const key of sortedKeys) {
        sortedLabels[key] = labels[key];
    }
    return JSON.stringify(sortedLabels);
}

export interface StateChange {
    key: string;
    value: string;
    previous: string | null;
    changed: boolean;
    changed_at: number;
    first_seen: boolean;
}

export interface EventRecord {
    timestamp: number;
    category: string;
    summary: string;
    detail: string;
    status: string;
}

export interface StoreStats {
    samples: number;
    metrics: number;
    oldest: number;
    newest: number;
    bytes: number;
}

export class HistoryStore {
    path: string;
    retentionDays: number;
    busyTimeoutMs: number;
    lastWriteError: string | null = null;
    private db: Database.Database;

    constructor(path: string, retentionDays: number = 400, busyTimeoutMs: number = 10000) {
        this.path = path;
        this.retentionDays = retentionDays;
        this.busyTimeoutMs = busyTimeoutMs;

        const dir = dirname(this.path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(this.path, { timeout: this.busyTimeoutMs });
        this.db.pragma('journal_mode = WAL');
        this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
        this.db.pragma('synchronous = NORMAL');
        
        if (!_tablesPresent(this.db)) {
            _ensureSchema(this.db);
        }
    }

    private _writeBestEffort<T>(operation: () => T): T | boolean {
        try {
            return this.db.transaction(operation)();
        } catch (exc: any) {
            this.lastWriteError = exc.message || String(exc);
            console.warn(`History write failed (${exc.message}); continuing without it`);
            return false;
        }
    }

    private _write<T>(operation: () => T): T {
        try {
            return this.db.transaction(operation)();
        } catch (exc: any) {
            throw new HistoryStoreError(exc.message || String(exc));
        }
    }

    record(metric: string, value: number | null, labels?: Record<string, string> | null, ts?: number | null): void {
        if (value === null || value === undefined) return;
        
        const timestamp = ts || Date.now() / 1000;
        const encodedLabels = _encodeLabels(labels);
        
        this._writeBestEffort(() => {
            this.db.prepare("INSERT INTO samples (metric, labels, ts, value) VALUES (?, ?, ?, ?)").run(metric, encodedLabels, timestamp, value);
        });
    }

    recordMany(rows: Array<[string, Record<string, string> | null | undefined, number | null | undefined]>): void {
        const now = Date.now() / 1000;
        const payload = rows
            .filter(([, , value]) => value !== null && value !== undefined)
            .map(([metric, labels, value]) => [metric, _encodeLabels(labels || null), now, value]);

        if (payload.length === 0) return;

        this._write(() => {
            const stmt = this.db.prepare("INSERT INTO samples (metric, labels, ts, value) VALUES (?, ?, ?, ?)");
            for (const p of payload) {
                stmt.run(p[0], p[1], p[2], p[3]);
            }
        });
    }

    latest(metric: string, labels?: Record<string, string> | null): [number, number] | null {
        try {
            const row = this.db.prepare("SELECT ts, value FROM samples WHERE metric = ? AND labels = ? ORDER BY ts DESC LIMIT 1")
                .get(metric, _encodeLabels(labels)) as { ts: number, value: number } | undefined;
            return row ? [row.ts, row.value] : null;
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return null;
        }
    }

    series(metric: string, labels?: Record<string, string> | null, since?: number | null, limit: number = 5000): Array<[number, number]> {
        try {
            const rows = this.db.prepare("SELECT ts, value FROM samples WHERE metric = ? AND labels = ? AND ts >= ? ORDER BY ts ASC LIMIT ?")
                .all(metric, _encodeLabels(labels), since || 0.0, limit) as Array<{ ts: number, value: number }>;
            return rows.map(r => [r.ts, r.value]);
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return [];
        }
    }

    valueAtOrBefore(metric: string, ts: number, labels?: Record<string, string> | null): [number, number] | null {
        try {
            const row = this.db.prepare("SELECT ts, value FROM samples WHERE metric = ? AND labels = ? AND ts <= ? ORDER BY ts DESC LIMIT 1")
                .get(metric, _encodeLabels(labels), ts) as { ts: number, value: number } | undefined;
            return row ? [row.ts, row.value] : null;
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return null;
        }
    }

    delta(metric: string, windowSeconds: number, labels?: Record<string, string> | null, tolerance: number = 0.25): number | null {
        const current = this.latest(metric, labels);
        if (!current) return null;
        
        const [nowTs, nowValue] = current;
        const target = nowTs - windowSeconds;
        const baseline = this.valueAtOrBefore(metric, target, labels);
        
        if (!baseline) {
            const oldest = this.series(metric, labels, 0.0, 1);
            if (oldest.length === 0) return null;
            const [baseTs, baseValue] = oldest[0];
            if ((nowTs - baseTs) < windowSeconds * (1.0 - tolerance)) return null;
            return nowValue - baseValue;
        }
        return nowValue - baseline[1];
    }

    coverageSeconds(metric: string, labels?: Record<string, string> | null): number {
        try {
            const row = this.db.prepare("SELECT MIN(ts) as min_ts, MAX(ts) as max_ts FROM samples WHERE metric = ? AND labels = ?")
                .get(metric, _encodeLabels(labels)) as { min_ts: number | null, max_ts: number | null } | undefined;
            if (!row || row.min_ts === null || row.max_ts === null) return 0.0;
            return row.max_ts - row.min_ts;
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return 0.0;
        }
    }

    putState(key: string, value: string): StateChange {
        const now = Date.now() / 1000;
        let result: StateChange | null = null;

        const transaction = () => {
            const row = this.db.prepare("SELECT value, changed_at FROM state WHERE key = ?").get(key) as { value: string, changed_at: number } | undefined;
            if (!row) {
                this.db.prepare("INSERT INTO state (key, value, previous_value, updated_at, changed_at) VALUES (?, ?, NULL, ?, ?)").run(key, value, now, now);
                result = { key, value, previous: null, changed: false, changed_at: now, first_seen: true };
                return;
            }
            const previous = row.value;
            const changedAt = row.changed_at;
            if (previous === value) {
                this.db.prepare("UPDATE state SET updated_at = ? WHERE key = ?").run(now, key);
                result = { key, value, previous, changed: false, changed_at: changedAt, first_seen: false };
                return;
            }
            this.db.prepare("UPDATE state SET value = ?, previous_value = ?, updated_at = ?, changed_at = ? WHERE key = ?").run(value, previous, now, now, key);
            result = { key, value, previous, changed: true, changed_at: now, first_seen: false };
        };

        if (this._writeBestEffort(transaction) === false || !result) {
            return { key, value, previous: null, changed: false, changed_at: now, first_seen: true };
        }
        return result;
    }

    getState(key: string): StateChange | null {
        try {
            const row = this.db.prepare("SELECT value, previous_value, changed_at FROM state WHERE key = ?").get(key) as { value: string, previous_value: string | null, changed_at: number } | undefined;
            if (!row) return null;
            return { key, value: row.value, previous: row.previous_value, changed: false, changed_at: row.changed_at, first_seen: false };
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return null;
        }
    }

    addEvent(category: string, summary: string, detail: string = "", status: string = "INFO"): void {
        this._writeBestEffort(() => {
            this.db.prepare("INSERT INTO events (ts, category, summary, detail, status) VALUES (?, ?, ?, ?, ?)").run(Date.now() / 1000, category, summary, detail, status);
        });
    }

    recentEvents(limit: number = 50, since?: number | null): EventRecord[] {
        try {
            const rows = this.db.prepare("SELECT ts, category, summary, detail, status FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
                .all(since || 0.0, limit) as any[];
            return rows.map(r => ({
                timestamp: r.ts,
                category: r.category,
                summary: r.summary,
                detail: r.detail,
                status: r.status
            }));
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return [];
        }
    }

    prune(): number {
        const cutoff = (Date.now() / 1000) - (this.retentionDays * 86400);
        let removed = 0;

        this._write(() => {
            const res1 = this.db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
            this.db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
            removed = res1.changes;
        });
        return removed;
    }

    stats(): StoreStats {
        try {
            const samplesRow = this.db.prepare("SELECT COUNT(*) as count FROM samples").get() as { count: number } | undefined;
            const metricsRow = this.db.prepare("SELECT COUNT(DISTINCT metric) as count FROM samples").get() as { count: number } | undefined;
            const spanRow = this.db.prepare("SELECT MIN(ts) as min_ts, MAX(ts) as max_ts FROM samples").get() as { min_ts: number | null, max_ts: number | null } | undefined;
            
            let size = 0;
            if (existsSync(this.path)) {
                size = statSync(this.path).size;
            }

            return {
                samples: samplesRow ? samplesRow.count : 0,
                metrics: metricsRow ? metricsRow.count : 0,
                oldest: (spanRow && spanRow.min_ts) ? spanRow.min_ts : 0.0,
                newest: (spanRow && spanRow.max_ts) ? spanRow.max_ts : 0.0,
                bytes: size
            };
        } catch (exc: any) {
            console.warn(`History read failed (${exc.message}); reporting no data`);
            return { samples: 0, metrics: 0, oldest: 0.0, newest: 0.0, bytes: 0 };
        }
    }
}

export type CollectFn = () => Array<[string, Record<string, string> | null | undefined, number | null | undefined]> | Promise<Array<[string, Record<string, string> | null | undefined, number | null | undefined]>>;

export class Sampler {
    store: HistoryStore;
    collect: CollectFn;
    interval: number;
    lastRun: number | null = null;
    lastError: string | null = null;
    runs: number = 0;
    
    private timer: NodeJS.Timeout | null = null;
    private pruneCounter: number = 0;
    private running: boolean = false;

    constructor(store: HistoryStore, collect: CollectFn, intervalSeconds: number = 60) {
        this.store = store;
        this.collect = collect;
        this.interval = Math.max(15, intervalSeconds);
    }

    start(): this {
        if (this.running) return this;
        this.running = true;
        console.info(`History sampler started (interval=${this.interval}s)`);
        
        const loop = async () => {
            if (!this.running) return;
            const started = Date.now() / 1000;
            
            try {
                const rows = await Promise.resolve(this.collect());
                this.store.recordMany(rows);
                this.lastRun = started;
                this.lastError = null;
                this.runs++;
            } catch (exc: any) {
                this.lastError = `${exc.name || 'Error'}: ${exc.message}`;
                console.error("History sample run failed", exc);
            }

            this.pruneCounter++;
            if (this.pruneCounter >= 1440) {
                this.pruneCounter = 0;
                try {
                    this.store.prune();
                } catch (exc: any) {
                    console.error("History prune failed", exc);
                }
            }

            const elapsed = (Date.now() / 1000) - started;
            const delay = Math.max(1.0, this.interval - elapsed) * 1000;
            
            if (this.running) {
                this.timer = setTimeout(loop, delay);
            }
        };

        this.timer = setTimeout(loop, 0); // start immediately
        return this;
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    isRunning(): boolean {
        return this.running;
    }
}
