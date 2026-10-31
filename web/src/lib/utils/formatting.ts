const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const DECIMAL_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function humanBytes(value: number | null | undefined, binary: boolean = true, digits: number = 1): string {
    if (value == null) return "—";
    if (value < 0) return `-${humanBytes(-value, binary, digits)}`;
    const step = binary ? 1024.0 : 1000.0;
    const units = binary ? BINARY_UNITS : DECIMAL_UNITS;
    let size = Number(value);
    let index = 0;
    while (size >= step && index < units.length - 1) {
        size /= step;
        index += 1;
    }
    if (index === 0) return `${Math.trunc(size)} ${units[0]}`;
    return `${size.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}

export function humanBitsPerSecond(value: number | null | undefined, digits: number = 1): string {
    if (value == null) return "—";
    const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    let rate = Number(value);
    let index = 0;
    while (rate >= 1000.0 && index < units.length - 1) {
        rate /= 1000.0;
        index += 1;
    }
    return `${rate.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}

export function humanBytesPerSecond(value: number | null | undefined, digits: number = 1): string {
    if (value == null) return "—";
    return `${humanBytes(value, true, digits)}/s`;
}

export function humanDuration(seconds: number | null | undefined, parts: number = 2): string {
    if (seconds == null) return "—";
    const secs = Math.trunc(Math.max(0, seconds));
    if (secs < 60) return `${secs}s`;
    
    const units: [string, number][] = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
    const chunks: string[] = [];
    let remaining = secs;
    
    for (const [suffix, size] of units) {
        if (remaining >= size) {
            const amount = Math.trunc(remaining / size);
            remaining = remaining % size;
            chunks.push(`${amount}${suffix}`);
        }
        if (chunks.length === parts) break;
    }
    return chunks.length > 0 ? chunks.join(" ") : "0s";
}

export function humanAge(timestamp: number | null | undefined, now?: number | null): string {
    if (timestamp == null) return "—";
    const currentTime = now != null ? now : Date.now() / 1000;
    const delta = currentTime - timestamp;
    
    if (delta < 0) return "in the future";
    if (delta < 45) return "just now";
    return `${humanDuration(delta, 2)} ago`;
}

export function formatPercent(value: number | null | undefined, digits: number = 1): string {
    if (value == null) return "—";
    return `${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function formatDelta(value: number | null | undefined, unit: string = "", digits: number = 0): string {
    if (value == null) return "—";
    const num = Number(value);
    
    let text = "";
    if (!Number.isInteger(num)) {
        const d = Math.max(digits, 1);
        text = num.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d, signDisplay: "always" });
    } else {
        text = num.toLocaleString("en-US", { maximumFractionDigits: 0, signDisplay: "always" });
    }
    return unit ? `${text}${unit}` : text;
}

export function formatTimestamp(timestamp: number | null | undefined, fmt: string = "%d %b %Y %H:%M"): string {
    if (timestamp == null) return "—";
    
    try {
        const date = new Date(timestamp * 1000);
        if (isNaN(date.getTime())) return "—";
        
        const pad = (n: number) => n.toString().padStart(2, "0");
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        
        // Very basic strftime equivalent to match the Python implementation's needs
        return fmt
            .replace(/%d/g, pad(date.getDate()))
            .replace(/%b/g, months[date.getMonth()])
            .replace(/%Y/g, date.getFullYear().toString())
            .replace(/%H/g, pad(date.getHours()))
            .replace(/%M/g, pad(date.getMinutes()))
            .replace(/%S/g, pad(date.getSeconds()));
    } catch {
        return "—";
    }
}

export function formatClock(timestamp: number | null | undefined): string {
    return formatTimestamp(timestamp, "%H:%M:%S");
}

export function formatDate(timestamp: number | null | undefined): string {
    return formatTimestamp(timestamp, "%d %b %Y");
}

export function formatTemperature(celsius: number | null | undefined): string {
    if (celsius == null) return "—";
    return `${celsius.toLocaleString("en-US", { maximumFractionDigits: 0 })} °C`;
}

export function truncate(text: string, limit: number = 60): string {
    text = text.trim();
    return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}

export function pluralise(count: number, singular: string, plural?: string): string {
    if (count === 1) return `${count} ${singular}`;
    return `${count} ${plural || singular + "s"}`;
}

export function safeRatio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
    if (numerator == null || denominator == null) return null;
    if (denominator === 0 || Number.isNaN(denominator) || Number.isNaN(numerator)) return null;
    return numerator / denominator;
}
