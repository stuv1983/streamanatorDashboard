import test from "node:test";
import assert from "node:assert/strict";

import {
    humanBytes,
    humanBitsPerSecond,
    humanBytesPerSecond,
    humanDuration,
    humanAge,
    formatPercent,
    formatDelta,
    formatTimestamp,
    formatClock,
    formatDate,
    formatTemperature,
    truncate,
    pluralise,
    safeRatio
} from "./formatting";

test("humanBytes", () => {
    assert.equal(humanBytes(null), "—");
    assert.equal(humanBytes(0), "0 B");
    assert.equal(humanBytes(1023), "1023 B");
    assert.equal(humanBytes(1024), "1.0 KiB");
    assert.equal(humanBytes(1024, false), "1.0 KB");
    assert.equal(humanBytes(-1024), "-1.0 KiB");
    assert.equal(humanBytes(1024 * 1024 * 1.5, true, 2), "1.50 MiB");
});

test("humanBitsPerSecond", () => {
    assert.equal(humanBitsPerSecond(null), "—");
    assert.equal(humanBitsPerSecond(999), "999.0 bps");
    assert.equal(humanBitsPerSecond(1500), "1.5 Kbps");
});

test("humanBytesPerSecond", () => {
    assert.equal(humanBytesPerSecond(null), "—");
    assert.equal(humanBytesPerSecond(1024), "1.0 KiB/s");
});

test("humanDuration", () => {
    assert.equal(humanDuration(null), "—");
    assert.equal(humanDuration(45), "45s");
    assert.equal(humanDuration(65), "1m 5s");
    assert.equal(humanDuration(86400 + 3600), "1d 1h");
    assert.equal(humanDuration(86400 + 3600 + 60), "1d 1h"); // Respects max chunks
});

test("humanAge", () => {
    assert.equal(humanAge(null), "—");
    assert.equal(humanAge(100, 90), "in the future");
    assert.equal(humanAge(100, 110), "just now");
    assert.equal(humanAge(100, 200), "1m 40s ago");
});

test("formatPercent", () => {
    assert.equal(formatPercent(null), "—");
    assert.equal(formatPercent(12.345, 1), "12.3%");
    assert.equal(formatPercent(12.345, 2), "12.35%");
});

test("formatDelta", () => {
    assert.equal(formatDelta(null), "—");
    assert.equal(formatDelta(0), "+0");
    assert.equal(formatDelta(5), "+5");
    assert.equal(formatDelta(-5), "-5");
    assert.equal(formatDelta(1.5, "s", 1), "+1.5s");
    assert.equal(formatDelta(1.555, "s", 2), "+1.56s");
});

test("formatTimestamp & specific formatters", () => {
    assert.equal(formatTimestamp(null), "—");
    
    // We compute the expected output dynamically due to local timezone dependency.
    const ts = Math.floor(Date.now() / 1000);
    const date = new Date(ts * 1000);
    
    const d = date.getDate().toString().padStart(2, "0");
    const b = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
    const Y = date.getFullYear();
    const H = date.getHours().toString().padStart(2, "0");
    const M = date.getMinutes().toString().padStart(2, "0");
    const S = date.getSeconds().toString().padStart(2, "0");

    assert.equal(formatTimestamp(ts), `${d} ${b} ${Y} ${H}:${M}`);
    assert.equal(formatClock(ts), `${H}:${M}:${S}`);
    assert.equal(formatDate(ts), `${d} ${b} ${Y}`);
});

test("formatTemperature", () => {
    assert.equal(formatTemperature(null), "—");
    assert.equal(formatTemperature(23.4), "23 °C");
    assert.equal(formatTemperature(1234), "1,234 °C");
});

test("truncate", () => {
    assert.equal(truncate("hello", 10), "hello");
    assert.equal(truncate("hello world", 10), "hello wor…");
});

test("pluralise", () => {
    assert.equal(pluralise(1, "apple"), "1 apple");
    assert.equal(pluralise(2, "apple"), "2 apples");
    assert.equal(pluralise(2, "child", "children"), "2 children");
});

test("safeRatio", () => {
    assert.equal(safeRatio(null, 1), null);
    assert.equal(safeRatio(1, null), null);
    assert.equal(safeRatio(1, 0), null);
    assert.equal(safeRatio(1, NaN), null);
    assert.equal(safeRatio(10, 2), 5);
});
