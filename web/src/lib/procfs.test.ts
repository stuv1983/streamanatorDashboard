import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayName,
  containerIdFromCgroup, cpuBreakdown, parseDiskstats, parseLoadavg, parseMeminfo,
  parseNetDev, parseNetSockets, parsePasswd, parsePidIo, parsePidStat, parsePidStatus,
  parsePressure, parseProcStat, unitFromCgroup,
} from "./procfs";

// Fixtures are captured from streamanator (Ubuntu 24.04, kernel 6.8).

test("parseProcStat reads totals, every core and the scalar counters", () => {
  const stat = parseProcStat([
    "cpu  20350861 219161 3740088 1126489015 4932646 0 297928 0 0 0",
    "cpu0 805466 8574 171612 46924944 70131 0 10871 0 0 0",
    "cpu1 925912 8516 163144 46948642 99284 0 8231 0 0 0",
    "intr 1 2 3",
    "ctxt 987654321",
    "processes 2866195",
    "procs_running 3",
    "procs_blocked 1",
  ].join("\n"));
  assert.ok(stat);
  assert.equal(stat.cores.length, 2);
  assert.equal(stat.total.iowait, 4932646);
  assert.equal(stat.contextSwitches, 987654321);
  assert.equal(stat.procsBlocked, 1);
});

test("cpuBreakdown does not count iowait as busy time", () => {
  const prev = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
  const cur = { user: 20, nice: 0, system: 10, idle: 40, iowait: 30, irq: 0, softirq: 0, steal: 0 };
  const b = cpuBreakdown(prev, cur);
  assert.ok(b);
  assert.equal(b.total, 30);
  assert.equal(b.iowait, 30);
  assert.equal(b.user, 20);
});

test("cpuBreakdown returns null when no time elapsed instead of dividing by zero", () => {
  const t = { user: 1, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
  assert.equal(cpuBreakdown(t, t), null);
});

test("parseMeminfo converts kB to bytes but leaves HugePages counts alone", () => {
  const m = parseMeminfo("MemTotal:       32000000 kB\nCommitted_AS:   18415728 kB\nHugePages_Total:       4\n");
  assert.equal(m.MemTotal, 32000000 * 1024);
  assert.equal(m.Committed_AS, 18415728 * 1024);
  assert.equal(m.HugePages_Total, 4);
});

test("parseLoadavg reads runnable and total task counts", () => {
  assert.deepEqual(parseLoadavg("0.21 0.26 0.22 1/2144 2866195\n"), { one: 0.21, five: 0.26, fifteen: 0.22, running: 1, total: 2144 });
  assert.equal(parseLoadavg("garbage"), null);
});

test("parsePressure handles the cpu file whose 'full' line may be absent", () => {
  const p = parsePressure("some avg10=0.24 avg60=0.37 avg300=0.34 total=9114141654\n");
  assert.equal(p.some?.avg10, 0.24);
  assert.equal(p.full, null);
});

test("parseNetDev reads receive and transmit columns", () => {
  const dev = parseNetDev([
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "  eno1: 54400217949 62107967    1 11634    0     1          0     52167 135248787289 109867992    0    0    0     0       0          0",
  ].join("\n"));
  assert.equal(dev.eno1.rxBytes, 54400217949);
  assert.equal(dev.eno1.rxDropped, 11634);
  assert.equal(dev.eno1.txBytes, 135248787289);
});

test("parseDiskstats reads whole-disk and md rows", () => {
  const d = parseDiskstats([
    "   8       0 sda 552663 8427 120096849 2202598 109331 3122550 25845614 639259 0 851804 2911969 0 0 0 0 8209 70111",
    "   9     127 md127 2212281 0 480076873 9332395 305271 0 77397216 23553063 0 2104223 32885458 0 0 0 0 0 0",
  ].join("\n"));
  assert.equal(d.sda.readSectors, 120096849);
  assert.equal(d.sda.ioTicks, 851804);
  assert.equal(d.md127.writeIos, 305271);
});

test("parsePidStat survives a process name containing ') '", () => {
  const s = parsePidStat("4242 (evil) S (x) R 1 4242 4242 0 -1 4194304 90 0 0 0 7 3 0 0 20 5 4 0 48268883 5971968 432 18446744073709551615");
  assert.ok(s);
  assert.equal(s.comm, "evil) S (x");
  assert.equal(s.state, "R");
  assert.equal(s.ppid, 1);
  assert.equal(s.utimeTicks, 7);
  assert.equal(s.nice, 5);
  assert.equal(s.threads, 4);
  assert.equal(s.startTicks, 48268883);
});

test("parsePidStat reads a real kernel thread line", () => {
  const s = parsePidStat("2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 135 0 0 20 0 1 0 26 0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0");
  assert.equal(s?.comm, "kthreadd");
  assert.equal(s?.stimeTicks, 135);
  assert.equal(s?.rssPages, 0);
});

test("parsePidStatus flags kernel threads by their missing VmSize", () => {
  const user = parsePidStatus("Name:\tgrep\nUid:\t1000\t1000\t1000\t1000\nVmSize:\t    6692 kB\nVmRSS:\t    2408 kB\nVmSwap:\t       0 kB\nThreads:\t1\n");
  assert.equal(user.uid, 1000);
  assert.equal(user.rssBytes, 2408 * 1024);
  assert.equal(user.isKernelThread, false);
  const kernel = parsePidStatus("Name:\tkthreadd\nUid:\t0\t0\t0\t0\nThreads:\t1\n");
  assert.equal(kernel.isKernelThread, true);
  assert.equal(kernel.rssBytes, null);
});

test("parsePidStatus reports the effective uid, so sudo counts as root", () => {
  assert.equal(parsePidStatus("Name:\tsudo\nUid:\t1000\t0\t0\t0\nVmSize:\t 1 kB\n").uid, 0);
});

test("parsePidIo reads storage bytes, not syscall character counts", () => {
  const io = parsePidIo("rchar: 136644\nwchar: 4890\nsyscr: 176\nsyscw: 13\nread_bytes: 24576\nwrite_bytes: 0\ncancelled_write_bytes: 0\n");
  assert.deepEqual(io, { readBytes: 24576, writeBytes: 0, rchar: 136644, wchar: 4890 });
  assert.equal(parsePidIo(""), null);
});

test("cgroup paths identify docker containers and systemd units", () => {
  const id = "8681b729dc99138151dc0fa4dd84d554682f7058882b5a4335053baad85dfa35";
  assert.equal(containerIdFromCgroup(`0::/system.slice/docker-${id}.scope\n`), id);
  assert.equal(containerIdFromCgroup("0::/user.slice/user-1000.slice/session-18712.scope\n"), null);
  assert.equal(unitFromCgroup("0::/system.slice/streamanator-dashboard.service\n"), "streamanator-dashboard.service");
  assert.equal(unitFromCgroup("0::/user.slice/user-1000.slice/session-18712.scope\n"), null);
  assert.equal(unitFromCgroup(`0::/system.slice/docker-${id}.scope\n`), null);
});

test("parseNetSockets decodes little-endian IPv4 and listening state", () => {
  const [a, b] = parseNetSockets([
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:B1AB 00000000:0000 0A 00000000:00000000 00:00000000 00000000   996        0 8957621 1 0000000000000000 100 0 0 10 0",
    "   1: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   992        0 5518 1 0000000000000000 100 0 0 10 5",
  ].join("\n"), "tcp", 4);
  assert.equal(a.localAddress, "127.0.0.1");
  assert.equal(a.localPort, 0xB1AB);
  assert.equal(a.state, "LISTEN");
  assert.equal(a.uid, 996);
  assert.equal(b.localAddress, "127.0.0.53");
  assert.equal(b.localPort, 53);
});

test("parseNetSockets compresses IPv6 and unwraps v4-mapped peers", () => {
  const sockets = parseNetSockets([
    "header",
    "   0: 00000000000000000000000000000000:1AE1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 51712 1 0000000000000000 100 0 0 10 0",
    "   1: 0000000000000000FFFF00006428000A:2198 0000000000000000FFFF00000128000A:C350 01 00000000:00000000 00:00000000 00000000  1000        0 99 1 0000000000000000 100 0 0 10 0",
  ].join("\n"), "tcp", 6);
  assert.equal(sockets[0].localAddress, "::");
  assert.equal(sockets[0].localPort, 6881);
  assert.equal(sockets[1].localAddress, "10.0.40.100");
  assert.equal(sockets[1].remoteAddress, "10.0.40.1");
  assert.equal(sockets[1].state, "ESTABLISHED");
});

test("parseNetSockets reports unconnected UDP as UNCONN rather than CLOSE", () => {
  const [s] = parseNetSockets("h\n 9550: 00000000000000000000000000000000:1AE1 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 54689 2 0000000000000000 0\n", "udp", 6);
  assert.equal(s.state, "UNCONN");
});

test("parsePasswd maps uids to names", () => {
  const users = parsePasswd("root:x:0:0:root:/root:/bin/bash\narm:x:1000:1000::/home/arm:/bin/bash\n");
  assert.equal(users.get(1000), "arm");
});

test("displayName restores names the kernel cut at 15 characters", () => {
  assert.equal(displayName("Plex Media Serv", "/usr/lib/plexmediaserver/Plex Media Server\0"), "Plex Media Server");
  assert.equal(displayName("next-server (v1", "next-server (v16.3.3)\0"), "next-server (v16.3.3)");
  assert.equal(displayName("sshd", "sshd: arm@notty\0"), "sshd");
  assert.equal(displayName("qbittorrent-nox", "/usr/bin/qbittorrent-nox\0--webui-port=8080\0"), "qbittorrent-nox");
  assert.equal(displayName("kworker/u48:2-e", ""), "kworker/u48:2-e");
  assert.equal(displayName("something-long1", "/opt/other/name\0"), "something-long1", "argv rewritten to something unrelated");
});
