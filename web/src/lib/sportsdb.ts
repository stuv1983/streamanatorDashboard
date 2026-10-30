import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export interface SportsDbStatus {
    key: string;
    display: string;
    path: string;
    exists: boolean;
    size_bytes: number | null;
    modified_at: number | null;
    growth_bytes: number | null;
    integrity_ok: boolean | null;
    integrity_detail: string;
    integrity_checked_at: number | null;
    backup_count: number;
    latest_backup_at: number | null;
    error: string;
    max_age_hours: number;
    collected_at: number;
}

export interface IntegrityResult {
    ok: boolean;
    detail: string;
    method: string;
    duration_seconds: number;
    checked_at: number;
}

export function getAgeSeconds(status: SportsDbStatus): number | null {
    if (status.modified_at === null) return null;
    return Math.max(0, (Date.now() / 1000) - status.modified_at);
}

export function getAgeHours(status: SportsDbStatus): number | null {
    const ageSeconds = getAgeSeconds(status);
    return ageSeconds !== null ? ageSeconds / 3600.0 : null;
}

export function isStale(status: SportsDbStatus): boolean | null {
    const ageHours = getAgeHours(status);
    return ageHours !== null ? ageHours > status.max_age_hours : null;
}

export function getBackupAgeSeconds(status: SportsDbStatus): number | null {
    if (status.latest_backup_at === null) return null;
    return Math.max(0, (Date.now() / 1000) - status.latest_backup_at);
}

export function getDatabaseStatus(
    key: string,
    display: string,
    dbPath: string,
    max_age_hours: number = 48.0
): SportsDbStatus {
    const status: SportsDbStatus = {
        key,
        display,
        path: dbPath,
        exists: false,
        size_bytes: null,
        modified_at: null,
        growth_bytes: null,
        integrity_ok: null,
        integrity_detail: "",
        integrity_checked_at: null,
        backup_count: 0,
        latest_backup_at: null,
        error: "",
        max_age_hours,
        collected_at: Date.now() / 1000,
    };

    try {
        if (!fs.existsSync(dbPath)) {
            status.error = "Database file not found";
            return status;
        }

        const stats = fs.statSync(dbPath);
        if (!stats.isFile()) {
            status.error = "Database path is not a file";
            return status;
        }

        status.exists = true;
        status.size_bytes = stats.size;
        status.modified_at = stats.mtimeMs / 1000;
    } catch (err) {
        status.error = `Cannot stat database: ${err instanceof Error ? err.message : String(err)}`;
        return status;
    }

    const backupsDir = path.join(path.dirname(dbPath), "backups");
    if (fs.existsSync(backupsDir)) {
        try {
            const dirStats = fs.statSync(backupsDir);
            if (dirStats.isDirectory()) {
                const entries = fs.readdirSync(backupsDir);
                const snapshots: number[] = [];
                for (const entry of entries) {
                    const ext = path.extname(entry);
                    if ([".db", ".sqlite", ".sqlite3"].includes(ext)) {
                        const entryPath = path.join(backupsDir, entry);
                        try {
                            const entryStats = fs.statSync(entryPath);
                            if (entryStats.isFile()) {
                                snapshots.push(entryStats.mtimeMs / 1000);
                            }
                        } catch (e) {
                            // Ignore stat errors on entries
                        }
                    }
                }
                status.backup_count = snapshots.length;
                if (snapshots.length > 0) {
                    status.latest_backup_at = Math.max(...snapshots);
                }
            }
        } catch (err) {
            // Ignore errors reading backups directory
        }
    }

    return status;
}

export function verifySqlite(dbPath: string): IntegrityResult {
    const start = performance.now();
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        db.pragma('busy_timeout = 30000');
        
        const row = db.pragma('integrity_check', { simple: true });
        db.close();

        const durationSeconds = (performance.now() - start) / 1000;
        const ok = row === 'ok';

        return {
            ok,
            detail: ok ? 'ok' : String(row),
            method: 'PRAGMA integrity_check',
            duration_seconds: durationSeconds,
            checked_at: Date.now() / 1000
        };
    } catch (err: any) {
        const durationSeconds = (performance.now() - start) / 1000;
        return {
            ok: false,
            detail: err.message,
            method: 'PRAGMA integrity_check',
            duration_seconds: durationSeconds,
            checked_at: Date.now() / 1000
        };
    }
}

export function verifyDatabase(dbPath: string): IntegrityResult {
    const result = verifySqlite(dbPath);
    if (!result.ok && result.detail.toLowerCase().includes('locked')) {
        return {
            ok: false,
            detail: "Database is locked by the running application — integrity could not be verified. This is not evidence of corruption.",
            method: result.method,
            duration_seconds: result.duration_seconds,
            checked_at: result.checked_at
        };
    }
    return result;
}

export function getAllDatabases(configs: { key: string, display: string, path: string, max_age_hours?: number }[]): SportsDbStatus[] {
    return configs.map(cfg => getDatabaseStatus(cfg.key, cfg.display, cfg.path, cfg.max_age_hours));
}
