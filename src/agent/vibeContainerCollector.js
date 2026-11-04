import fs from 'node:fs';
import { SystemCollector } from './collector.js';

// Vibe Hosting runs the monitor inside an application container, not on the
// Nhân Hòa host. Deliberately report process/cgroup data, never pretend these
// are whole-VPS CPU, memory, disk or uptime figures.
export class VibeContainerCollector extends SystemCollector {
  constructor() {
    super();
    this.lastProcessCpu = process.cpuUsage();
    this.lastCpuAt = process.hrtime.bigint();
  }

  getCpuUsage() {
    const cpu = process.cpuUsage();
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.lastCpuAt) / 1000;
    const cpuUsedUs = (cpu.user - this.lastProcessCpu.user) +
      (cpu.system - this.lastProcessCpu.system);
    this.lastProcessCpu = cpu;
    this.lastCpuAt = now;
    return elapsedUs > 0
      ? Math.round(Math.min(100, Math.max(0, cpuUsedUs / elapsedUs * 100)) * 10) / 10
      : 0;
  }

  getRamUsage() {
    const rssBytes = process.memoryUsage().rss;
    // cgroup v2 memory.current/max may be accessible in containerized runtimes.
    let usedBytes = rssBytes;
    let limitBytes = 0;
    try {
      const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
      const rawLimit = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      const limit = Number(rawLimit);
      if (Number.isFinite(current) && current >= 0) usedBytes = current;
      if (rawLimit !== 'max' && Number.isFinite(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER) {
        limitBytes = limit;
      }
    } catch {
      // If cgroup data is unavailable, report process RSS, not VPS RAM.
    }
    const ramUsedMb = Math.round(usedBytes / 1048576);
    const ramTotalMb = limitBytes ? Math.round(limitBytes / 1048576) : 0;
    return {
      ramUsedMb,
      ramTotalMb,
      ramPct: limitBytes ? Math.round(Math.min(100, usedBytes / limitBytes * 100) * 10) / 10 : 0
    };
  }

  // Container overlay / mounted filesystems do not reliably expose VPS disk
  // usage or per-app volume quota. Zero total is our explicit "unavailable".
  getDiskUsage() {
    return { diskUsedGb: 0, diskTotalGb: 0, diskPct: 0 };
  }

  collect(serverId) {
    const snapshot = super.collect(serverId);
    snapshot.uptimeSec = Math.floor(process.uptime());
    return snapshot;
  }
}
