/**
 * Backup discovery, age tracking and integrity verification.
 *
 * A backup that exists is not a backup that works, so this module separates two
 * questions the dashboard must answer differently:
 *
 * * **Is a recent backup present?** — cheap, safe to run on every refresh.
 * * **Is it intact?** — expensive (a gzip test on a 3.8 GB archive reads the
 *   whole file), so verification is explicit, cached, and never runs on a page
 *   render. Results persist in the history store so the last verdict and the time
 *   it was reached stay visible.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from './system';
import { IntegrityResult, verifySqlite } from './sportsdb';

function fnmatch(name: string, pattern: string): boolean {
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape all regex chars except * and ?
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`).test(name);
}

export class BackupFile {
    path: string;
    size_bytes: number;
    modified_at: number;
    size_known: boolean;

    constructor(
        filePath: string,
        sizeBytes: number,
        modifiedAt: number,
        sizeKnown: boolean = true
    ) {
        this.path = filePath;
        this.size_bytes = sizeBytes;
        this.modified_at = modifiedAt;
        this.size_known = sizeKnown;
    }

    get name(): string {
        return path.basename(this.path);
    }

    get age_seconds(): number {
        return Math.max(0.0, (Date.now() / 1000) - this.modified_at);
    }
}

export class BackupStatus {
    key: string;
    display: string;
    directory: string;
    schedule: string;
    latest: BackupFile | null = null;
    previous: BackupFile | null = null;
    retained_count: number = 0;
    total_bytes: number = 0;
    destination_free_bytes: number | null = null;
    destination_total_bytes: number | null = null;
    integrity_ok: boolean | null = null;
    integrity_detail: string = "";
    integrity_checked_at: number | null = null;
    error: string = "";
    expected_interval_days: number;
    min_plausible_bytes: number;
    entry_kind: string = "file";
    missed_run_at: number | null = null;

    constructor(
        key: string,
        display: string,
        directory: string,
        schedule: string,
        expected_interval_days: number = 1.0,
        min_plausible_bytes: number = 0
    ) {
        this.key = key;
        this.display = display;
        this.directory = directory;
        this.schedule = schedule;
        this.expected_interval_days = expected_interval_days;
        this.min_plausible_bytes = min_plausible_bytes;
    }

    get age_seconds(): number | null {
        return this.latest ? this.latest.age_seconds : null;
    }

    get age_days(): number | null {
        const age = this.age_seconds;
        return age !== null ? age / 86400.0 : null;
    }

    get size_suspicious(): boolean {
        if (!this.latest || this.min_plausible_bytes <= 0) return false;
        if (!this.latest.size_known) return false;
        return this.latest.size_bytes < this.min_plausible_bytes;
    }

    get growth_bytes(): number | null {
        if (!this.latest || !this.previous) return null;
        if (!(this.latest.size_known && this.previous.size_known)) return null;
        return this.latest.size_bytes - this.previous.size_bytes;
    }

    get destination_used_percent(): number | null {
        if (!this.destination_total_bytes) return null;
        const used = this.destination_total_bytes - (this.destination_free_bytes || 0);
        return (100.0 * used) / this.destination_total_bytes;
    }
}

export function scanBackupDirectory(
    key: string,
    display: string,
    directory: string,
    pattern: string = "*",
    schedule: string = "",
    expectedIntervalDays: number = 1.0,
    minPlausibleBytes: number = 0,
    maxFiles: number = 500
): BackupStatus {
    const status = new BackupStatus(
        key,
        display,
        directory,
        schedule,
        expectedIntervalDays,
        minPlausibleBytes
    );

    let rootStat;
    try {
        rootStat = fs.statSync(directory);
    } catch (err) {
        status.error = `Backup directory ${directory} does not exist or is unreadable`;
        return status;
    }

    if (!rootStat.isDirectory()) {
        status.error = `Backup directory ${directory} does not exist or is unreadable`;
        return status;
    }

    try {
        const statfs = fs.statfsSync(directory);
        const block = statfs.bsize; // fs.statfs returns bsize
        status.destination_free_bytes = statfs.bavail * block;
        status.destination_total_bytes = statfs.blocks * block;
    } catch (err) {
        // Ignored. Often unavailable in Node versions < 19.6.0
    }

    let files: BackupFile[] = [];
    const directories: BackupFile[] = [];

    try {
        const dir = fs.opendirSync(directory);
        try {
            let entry;
            while ((entry = dir.readSync()) !== null) {
                if (files.length + directories.length >= maxFiles) {
                    break;
                }

                const entryPath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    try {
                        const info = fs.statSync(entryPath);
                        directories.push(
                            new BackupFile(entryPath, 0, info.mtimeMs / 1000, false)
                        );
                    } catch (err) {
                        continue;
                    }
                    continue;
                }

                if (!entry.isFile()) continue;
                if (pattern !== "*" && !fnmatch(entry.name, pattern)) continue;

                // Skip the job's own log so it is not mistaken for a backup.
                const ext = path.extname(entry.name);
                if (ext === '.log' || ext === '.tmp' || ext === '.part') {
                    continue;
                }

                try {
                    const info = fs.statSync(entryPath);
                    files.push(
                        new BackupFile(entryPath, info.size, info.mtimeMs / 1000)
                    );
                } catch (err) {
                    continue;
                }
            }
        } finally {
            dir.closeSync();
        }
    } catch (err: any) {
        status.error =
            err.code === 'EACCES' || err.code === 'EPERM'
                ? `Cannot read ${directory}: ${err.message}`
                : `Error reading ${directory}: ${err.message}`;
        return status;
    }

    // Prefer archive files when both are present; fall back to run directories.
    if (files.length === 0 && directories.length > 0) {
        files = directories;
        status.entry_kind = "directory";
    }

    if (files.length === 0) {
        status.error = `No files matching ${pattern} in ${directory}`;
        return status;
    }

    files.sort((a, b) => b.modified_at - a.modified_at);
    status.latest = files[0];
    status.previous = files.length > 1 ? files[1] : null;
    status.retained_count = files.length;
    status.total_bytes = files.reduce((acc, f) => acc + (f.size_known ? f.size_bytes : 0), 0);
    return status;
}

export function measureDirectorySize(
    dirPath: string,
    maxEntries: number = 200000,
    deadlineSeconds: number = 20.0
): [number, boolean] {
    let total = 0;
    let seen = 0;
    const started = performance.now();
    let complete = true;

    function walk(currentDir: string) {
        if (!complete) return;
        let dir;
        try {
            dir = fs.opendirSync(currentDir);
        } catch (err) {
            complete = false;
            return;
        }

        try {
            let entry;
            while ((entry = dir.readSync()) !== null) {
                seen += 1;
                if (seen > maxEntries || (performance.now() - started) / 1000 > deadlineSeconds) {
                    complete = false;
                    break;
                }
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    walk(fullPath);
                    if (!complete) break;
                } else if (entry.isFile()) { // dirent.isFile() explicitly ignores symlinks 
                    try {
                        total += fs.statSync(fullPath).size;
                    } catch (err) {
                        continue;
                    }
                }
            }
        } catch (err) {
            complete = false;
        } finally {
            try {
                dir.closeSync();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }

    walk(dirPath);
    return [total, complete];
}

export async function isStillBeingWritten(
    filePath: string,
    sampleSeconds: number = 2.0
): Promise<boolean> {
    try {
        const first = fs.statSync(filePath).size;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, sampleSeconds) * 1000));
        return fs.statSync(filePath).size !== first;
    } catch (err) {
        return false;
    }
}

export function nextExpectedRun(
    weekdays: number[],
    hour: number,
    minute: number = 0,
    now: number | null = null
): number | null {
    if (!weekdays || weekdays.length === 0) {
        return null;
    }
    const nowSecs = now !== null ? now : Date.now() / 1000;
    const current = new Date(nowSecs * 1000);

    for (let daysBack = 0; daysBack < 8; daysBack++) {
        const candidateDay = new Date(current.getTime() - daysBack * 86400000);
        const cronWeekday = candidateDay.getDay();

        if (!weekdays.includes(cronWeekday)) {
            continue;
        }

        const occurrence = new Date(candidateDay);
        occurrence.setHours(hour, minute, 0, 0);

        const occurrenceSecs = occurrence.getTime() / 1000;
        if (occurrenceSecs <= nowSecs) {
            return occurrenceSecs;
        }
    }
    return null;
}

export function checkMissedRun(
    status: BackupStatus,
    weekdays: number[],
    hour: number,
    minute: number = 0,
    graceHours: number = 3.0,
    now: number | null = null
): number | null {
    const expected = nextExpectedRun(weekdays, hour, minute, now);
    if (expected === null) return null;

    const nowSecs = now !== null ? now : Date.now() / 1000;
    if (nowSecs < expected + graceHours * 3600) {
        return null;
    }

    if (!status.latest) return expected;
    if (status.latest.modified_at < expected) return expected;
    return null;
}

// ---------------------------------------------------------------------------
// Integrity verification
// ---------------------------------------------------------------------------

export async function verifyGzip(
    filePath: string,
    timeout: number = 900.0
): Promise<IntegrityResult> {
    const started = performance.now();
    const [code, stdout, stderr] = await runCommand(["gzip", "-t", filePath], timeout);
    const durationSeconds = (performance.now() - started) / 1000;

    if (code === 124) {
        return {
            ok: false,
            detail: `gzip -t exceeded ${timeout}s`,
            method: "gzip -t",
            duration_seconds: durationSeconds,
            checked_at: Date.now() / 1000
        };
    }

    if (code !== 0 && !stderr.includes("gzip")) {
        return {
            ok: false,
            detail: `Could not run gzip: ${stderr.trim().substring(0, 200)}`,
            method: "gzip -t",
            duration_seconds: durationSeconds,
            checked_at: Date.now() / 1000
        };
    }

    const ok = code === 0;
    return {
        ok,
        detail: ok ? "ok" : stderr.trim().substring(0, 200),
        method: "gzip -t",
        duration_seconds: durationSeconds,
        checked_at: Date.now() / 1000
    };
}

export async function verifyTarListing(
    filePath: string,
    timeout: number = 900.0
): Promise<IntegrityResult> {
    const started = performance.now();
    const [code, stdout, stderr] = await runCommand(["tar", "-tzf", filePath], timeout);
    const durationSeconds = (performance.now() - started) / 1000;

    if (code === 124) {
        return {
            ok: false,
            detail: `tar listing failed: tar -tzf exceeded ${timeout}s`,
            method: "tar -tzf",
            duration_seconds: durationSeconds,
            checked_at: Date.now() / 1000
        };
    }

    if (code !== 0 && !stderr.includes("tar")) {
        return {
            ok: false,
            detail: `tar listing failed: ${stderr.trim().substring(0, 200)}`,
            method: "tar -tzf",
            duration_seconds: durationSeconds,
            checked_at: Date.now() / 1000
        };
    }

    const ok = code === 0;
    const entries = ok ? stdout.split('\n').filter((line: string) => line.trim().length > 0).length : 0;

    return {
        ok,
        detail: ok ? `${entries.toLocaleString()} entries` : stderr.trim().substring(0, 200),
        method: "tar -tzf",
        duration_seconds: durationSeconds,
        checked_at: Date.now() / 1000
    };
}

export async function verifyBackup(
    filePath: string,
    deep: boolean = false
): Promise<IntegrityResult> {
    const lower = filePath.toLowerCase();
    
    if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')) {
        return verifySqlite(filePath);
    }
    
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
        if (deep) {
            return await verifyTarListing(filePath);
        }
        return await verifyGzip(filePath);
    }
    
    if (lower.endsWith('.gz')) {
        return await verifyGzip(filePath);
    }

    return {
        ok: false,
        detail: `No verification method for ${path.extname(filePath) || 'this file type'}`,
        method: "none",
        duration_seconds: 0.0,
        checked_at: Date.now() / 1000
    };
}

export async function verifySqliteInArchive(
    archivePath: string,
    memberSuffix: string = ".db",
    timeout: number = 900.0
): Promise<IntegrityResult> {
    const started = performance.now();
    const [listCode, listStdout, listStderr] = await runCommand(["tar", "-tzf", archivePath], timeout);

    if (listCode !== 0) {
        return {
            ok: false,
            detail: listStderr.trim().substring(0, 200) || "tar listing failed",
            method: "restore test",
            duration_seconds: (performance.now() - started) / 1000,
            checked_at: Date.now() / 1000
        };
    }

    const lines = listStdout.split('\n');
    const members = lines.map((l: string) => l.trim()).filter((l: string) => l.endsWith(memberSuffix));

    if (members.length === 0) {
        return {
            ok: false,
            detail: `Archive contains no ${memberSuffix} member to verify`,
            method: "restore test",
            duration_seconds: (performance.now() - started) / 1000,
            checked_at: Date.now() / 1000
        };
    }

    const member = members.reduce((a: string, b: string) => (a.length <= b.length ? a : b));
    let workdir = '';
    let result: IntegrityResult;

    try {
        workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamanator-verify-'));

        const [extCode, extStdout, extStderr] = await runCommand(
            ["tar", "-xzf", archivePath, "-C", workdir, member],
            timeout
        );

        if (extCode !== 0) {
            return {
                ok: false,
                detail: extStderr.trim().substring(0, 200) || "extraction failed",
                method: "restore test",
                duration_seconds: (performance.now() - started) / 1000,
                checked_at: Date.now() / 1000
            };
        }

        const extracted = path.join(workdir, member);
        if (!fs.existsSync(extracted) || !fs.statSync(extracted).isFile()) {
            return {
                ok: false,
                detail: "Extracted member missing",
                method: "restore test",
                duration_seconds: (performance.now() - started) / 1000,
                checked_at: Date.now() / 1000
            };
        }

        const sqliteResult = verifySqlite(extracted);
        result = {
            ok: sqliteResult.ok,
            detail: `${member}: ${sqliteResult.detail}`,
            method: "restore test (extract + PRAGMA integrity_check)",
            duration_seconds: (performance.now() - started) / 1000,
            checked_at: Date.now() / 1000
        };
    } catch (err: any) {
        return {
            ok: false,
            detail: `Extraction failed: ${err.message}`,
            method: "restore test",
            duration_seconds: (performance.now() - started) / 1000,
            checked_at: Date.now() / 1000
        };
    } finally {
        if (workdir) {
            try {
                fs.rmSync(workdir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }

    return result;
}
