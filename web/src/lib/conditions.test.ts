import { test } from "node:test";
import assert from "node:assert/strict";
import { CLEAR_AFTER_MS, DEFAULT_CONDITIONS, evaluate, validateConditions, type Condition, type ConditionState } from "./conditions";
import { carryForward, changeStatus, diffInventory, summariseChanges, type Inventory } from "./inventory";
import { Status } from "./status";
import type { LiveFrame } from "./live";

const cpuRule: Condition = { id: "cpu", name: "CPU", metric: "cpu.total", operator: ">", threshold: 90, forSeconds: 10, severity: "WARNING", enabled: true };
const frame = (ts: number, cpu: number | null): LiveFrame => ({
  ts, intervalSeconds: 1, cpu: cpu === null ? null : { total: cpu, user: cpu, system: 0, iowait: 0, steal: 0, irq: 0, cores: [] },
  load: null, tasks: null, mem: null, psi: null, disks: [], nets: [], gpus: [], temps: null, cpuMhz: null, rates: null, uptimeSeconds: null,
});

function run(rule: Condition, samples: Array<[number, number | null]>): ConditionState {
  let st: ConditionState | undefined;
  for (const [t, v] of samples) st = evaluate(rule, st, frame(t * 1000, v));
  return st!;
}

test("a condition fires only after the breach is sustained for the full duration", () => {
  const nine = run(cpuRule, Array.from({ length: 10 }, (_, i) => [i, 95] as [number, number]));
  assert.equal(nine.firingSince, null, "9 s of breach is not 10 s");
  const ten = run(cpuRule, Array.from({ length: 11 }, (_, i) => [i, 95] as [number, number]));
  assert.notEqual(ten.firingSince, null);
});

test("a single dip below the threshold restarts the timer", () => {
  const st = run(cpuRule, [[0, 95], [5, 95], [6, 50], [7, 95], [15, 95]]);
  assert.equal(st.firingSince, null);
  assert.equal(st.breachingSince, 7000);
});

test("a firing condition clears only after CLEAR_AFTER_MS back inside the threshold", () => {
  const samples: Array<[number, number | null]> = [[0, 95], [10, 95], [11, 50]];
  assert.notEqual(run(cpuRule, samples).firingSince, null, "still firing right after the dip");
  const cleared = run(cpuRule, [...samples, [11 + CLEAR_AFTER_MS / 1000, 50]]);
  assert.equal(cleared.firingSince, null);
});

test("missing data neither fires nor clears a condition", () => {
  const firing = run(cpuRule, [[0, 95], [10, 95], [11, null], [100, null]]);
  assert.notEqual(firing.firingSince, null);
  assert.equal(firing.value, null);
  assert.equal(firing.lastSeen, 10_000);
  const quiet = run(cpuRule, [[0, null], [100, null]]);
  assert.equal(quiet.firingSince, null);
  assert.equal(quiet.lastSeen, null);
});

test("'below' conditions fire on low values", () => {
  const low = { ...cpuRule, operator: "<" as const, threshold: 5, forSeconds: 0 };
  assert.notEqual(run(low, [[0, 1]]).firingSince, null);
  assert.equal(run(low, [[0, 50]]).firingSince, null);
});

test("the shipped defaults validate", () => {
  assert.deepEqual(validateConditions(DEFAULT_CONDITIONS), DEFAULT_CONDITIONS);
});

test("validateConditions rejects unknown metrics, bad ids, duplicates and absurd durations", () => {
  assert.equal(typeof validateConditions([{ ...cpuRule, metric: "rm -rf" }]), "string");
  assert.equal(typeof validateConditions([{ ...cpuRule, id: "../etc" }]), "string");
  assert.equal(typeof validateConditions([cpuRule, cpuRule]), "string");
  assert.equal(typeof validateConditions([{ ...cpuRule, forSeconds: -1 }]), "string");
  assert.equal(typeof validateConditions([{ ...cpuRule, threshold: "90" }]), "string");
  assert.equal(typeof validateConditions({}), "string");
});

// ---------------------------------------------------------------------------

const inv = (over: Partial<Inventory>): Inventory => ({
  collectedAt: 0, packages: {}, units: {}, listeners: {}, containers: {}, users: {}, modules: {}, files: {}, system: {}, ...over,
});

test("diffInventory reports added, removed and changed items per category", () => {
  const changes = diffInventory(
    inv({ packages: { openssl: "3.0.13-0ubuntu3.4", nano: "7.2" } }),
    inv({ packages: { openssl: "3.0.13-0ubuntu3.5", curl: "8.5" } }),
  );
  assert.deepEqual(changes.map(c => `${c.kind}:${c.item}`).sort(), ["added:curl", "changed:openssl", "removed:nano"]);
});

test("access-widening changes are WARNING, routine churn is INFO", () => {
  assert.equal(changeStatus({ category: "users", kind: "added", item: "eve", before: null, after: "uid=1001" }), Status.WARNING);
  assert.equal(changeStatus({ category: "files", kind: "changed", item: "/etc/ssh/sshd_config", before: "a", after: "b" }), Status.WARNING);
  assert.equal(changeStatus({ category: "listeners", kind: "added", item: "tcp:*:4444", before: null, after: "present" }), Status.WARNING);
  assert.equal(changeStatus({ category: "listeners", kind: "added", item: "tcp:lo:4444", before: null, after: "present" }), Status.INFO);
  assert.equal(changeStatus({ category: "packages", kind: "changed", item: "curl", before: "1", after: "2" }), Status.INFO);
});

test("bulk package upgrades collapse to one event, but a new account stays separate", () => {
  const packages = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pkg${i}`, "1"]));
  const upgraded = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pkg${i}`, "2"]));
  const events = summariseChanges(diffInventory(inv({ packages }), inv({ packages: upgraded, users: { eve: "uid=1001 shell=/bin/bash" } })));
  assert.equal(events.filter(e => e.category === "packages").length, 1);
  assert.match(events.find(e => e.category === "packages")!.summary, /40 upgraded/);
  assert.equal(events.find(e => e.category === "users")?.status, Status.WARNING);
});

test("a category whose collector failed keeps its previous contents instead of reporting everything removed", () => {
  const previous = inv({ containers: { sonarr: "lscr.io/linuxserver/sonarr @abc" }, packages: { curl: "1" } });
  const next = carryForward(previous, inv({ containers: {}, packages: { curl: "2" }, unavailable: { containers: "docker ps failed (exit 1)" } }));
  assert.deepEqual(next.containers, previous.containers);
  assert.deepEqual(diffInventory(previous, next).map(c => `${c.category}:${c.kind}:${c.item}`), ["packages:changed:curl"]);
});
