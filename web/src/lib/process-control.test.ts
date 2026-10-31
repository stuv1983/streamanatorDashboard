import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlRequest, sameProcess } from "./process-control";
import { protectionReason } from "./processes";
import { parseNvidiaSmiLine } from "./live";

const SELF = 1000;
const row = (over: Partial<{ pid: number; ppid: number; uid: number | null; name: string; kernelThread: boolean; container: { id: string; name: string | null } | null }> = {}) =>
  ({ pid: 4242, ppid: 3000, uid: SELF, name: "python3", kernelThread: false, container: null, ...over });

test("an own-account ordinary process is controllable", () => {
  assert.equal(protectionReason(row(), SELF, 1, 1), null);
});

test("root, other users, kernel threads and pid 1 are always refused", () => {
  assert.match(protectionReason(row({ uid: 0 }), SELF, 1, 1)!, /root/);
  assert.match(protectionReason(row({ uid: 1001 }), SELF, 1, 1)!, /another account/);
  assert.match(protectionReason(row({ uid: null }), SELF, 1, 1)!, /another account/);
  assert.match(protectionReason(row({ kernelThread: true }), SELF, 1, 1)!, /Kernel/);
  assert.match(protectionReason(row({ pid: 1 }), SELF, 2, 2)!, /init/);
});

test("the dashboard cannot kill itself or its parent", () => {
  assert.match(protectionReason(row({ pid: 500 }), SELF, 500, 499)!, /dashboard itself/);
  assert.match(protectionReason(row({ pid: 499 }), SELF, 500, 499)!, /parent/);
});

test("the dashboard's own worker children are protected", () => {
  assert.match(protectionReason(row({ pid: 501, ppid: 500 }), SELF, 500, 499)!, /worker/);
  assert.match(protectionReason(row({ pid: 502, ppid: 499 }), SELF, 500, 499)!, /worker/);
});

test("when the dashboard's parent is init, other children of init are not treated as siblings", () => {
  // Regression: under systemd ppid is 1, which made every daemon look like a dashboard worker.
  assert.equal(protectionReason(row({ pid: 4242, ppid: 1 }), SELF, 500, 1), null);
  assert.match(protectionReason(row({ pid: 4242, ppid: 1, uid: 0, name: "dockerd" }), SELF, 500, 1)!, /dockerd|root/);
});

test("processes inside containers are refused even when the uid matches", () => {
  assert.match(protectionReason(row({ container: { id: "a".repeat(64), name: "sonarr" } }), SELF, 1, 1)!, /container sonarr/);
});

test("core plumbing is protected even when owned by this account", () => {
  for (const name of ["sshd", "systemd", "dockerd", "mdadm"]) {
    assert.ok(protectionReason(row({ name }), SELF, 1, 1), name);
  }
});

test("parseControlRequest accepts only allowlisted signals", () => {
  assert.deepEqual(parseControlRequest({ action: "signal", pid: 50, startedAt: 1.5, signal: "SIGTERM" }),
    { action: "signal", pid: 50, startedAt: 1.5, signal: "SIGTERM" });
  assert.equal(typeof parseControlRequest({ action: "signal", pid: 50, startedAt: 1, signal: "SIGSEGV" }), "string");
  assert.equal(typeof parseControlRequest({ action: "signal", pid: 50, startedAt: 1, signal: "9; rm -rf /" }), "string");
});

test("parseControlRequest refuses pid 0/1, missing start time and out-of-range nice", () => {
  assert.equal(typeof parseControlRequest({ action: "signal", pid: 1, startedAt: 1, signal: "SIGTERM" }), "string");
  assert.equal(typeof parseControlRequest({ action: "signal", pid: 0, startedAt: 1, signal: "SIGTERM" }), "string");
  assert.equal(typeof parseControlRequest({ action: "signal", pid: 50, signal: "SIGTERM" }), "string");
  assert.equal(typeof parseControlRequest({ action: "renice", pid: 50, startedAt: 1, nice: 25 }), "string");
  assert.equal(typeof parseControlRequest({ action: "renice", pid: 50, startedAt: 1, nice: 2.5 }), "string");
  assert.equal(typeof parseControlRequest({ action: "exec", pid: 50, startedAt: 1 }), "string");
});

test("sameProcess rejects a recycled pid with a different start time", () => {
  assert.equal(sameProcess({ startedAt: 1_700_000_000.12 }, 1_700_000_000.12), true);
  assert.equal(sameProcess({ startedAt: 1_700_000_000.12 }, 1_700_000_000.13), true);
  assert.equal(sameProcess({ startedAt: 1_700_000_005 }, 1_700_000_000), false);
  assert.equal(sameProcess({ startedAt: null }, 1_700_000_000), false);
});

test("parseNvidiaSmiLine reads a Quadro P400 line and maps [N/A] to null", () => {
  const parsed = parseNvidiaSmiLine("0, Quadro P400, 550.120, 3, 1, 5, 2048, 32, [N/A], 34, 139, 0, 12");
  assert.ok(parsed);
  assert.equal(parsed.info.name, "Quadro P400");
  assert.equal(parsed.sample.powerW, null);
  assert.equal(parsed.sample.memTotalBytes, 2048 * 1024 * 1024);
  assert.equal(parsed.sample.decoderPercent, 12);
  assert.equal(parseNvidiaSmiLine("No devices were found"), null);
});
