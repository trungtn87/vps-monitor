import os from 'node:os';
import fs from 'node:fs';

export class SystemCollector {
  constructor() {
    this._prevCpu = null;
    this._prevNet = null;
  }

  /**
   * Get CPU utilization percentage
   * @returns {number} 0-100
   */
  getCpuUsage() {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return 0;

    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times)) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }

    if (!this._prevCpu) {
      this._prevCpu = { totalIdle, totalTick };
      // Fallback: estimate from 1-min load average divided by cpu count
      const load = os.loadavg()[0];
      const pct = Math.min(100, Math.max(0, (load / cpus.length) * 100));
      return Math.round(pct * 10) / 10;
    }

    const idleDelta = totalIdle - this._prevCpu.totalIdle;
    const totalDelta = totalTick - this._prevCpu.totalTick;
    this._prevCpu = { totalIdle, totalTick };

    if (totalDelta <= 0) return 0;
    const usage = (1 - idleDelta / totalDelta) * 100;
    return Math.round(Math.min(100, Math.max(0, usage)) * 10) / 10;
  }

  /**
   * Get RAM metrics
   * @returns {{ ramUsedMb: number, ramTotalMb: number, ramPct: number }}
   */
  getRamUsage() {
    let totalMb = 0;
    let freeMb = 0;

    // Check Linux /proc/meminfo first for MemAvailable (more accurate on Linux)
    if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
      try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
        let totalKb = 0;
        let availKb = 0;
        for (const line of meminfo.split('\n')) {
          if (line.startsWith('MemTotal:')) {
            totalKb = parseInt(line.replace(/\D/g, ''), 10);
          } else if (line.startsWith('MemAvailable:')) {
            availKb = parseInt(line.replace(/\D/g, ''), 10);
          }
        }
        if (totalKb > 0 && availKb > 0) {
          totalMb = Math.round(totalKb / 1024);
          freeMb = Math.round(availKb / 1024);
        }
      } catch {
        // fallback to os
      }
    }

    if (!totalMb) {
      totalMb = Math.round(os.totalmem() / (1024 * 1024));
      freeMb = Math.round(os.freemem() / (1024 * 1024));
    }

    const usedMb = Math.max(0, totalMb - freeMb);
    const pct = totalMb > 0 ? (usedMb / totalMb) * 100 : 0;

    return {
      ramUsedMb: usedMb,
      ramTotalMb: totalMb,
      ramPct: Math.round(pct * 10) / 10
    };
  }

  /**
   * Get Disk metrics using statfs
   * @param {string} mountPath 
   * @returns {{ diskUsedGb: number, diskTotalGb: number, diskPct: number }}
   */
  getDiskUsage(mountPath = process.platform === 'win32' ? '.' : '/') {
    try {
      const stats = fs.statfsSync(mountPath);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);

      const totalGb = Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10;
      const usedGb = Math.round((usedBytes / (1024 * 1024 * 1024)) * 10) / 10;
      const pct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

      return {
        diskUsedGb: usedGb,
        diskTotalGb: totalGb,
        diskPct: Math.round(pct * 10) / 10
      };
    } catch {
      return {
        diskUsedGb: 0,
        diskTotalGb: 0,
        diskPct: 0
      };
    }
  }

  /**
   * Get Network RX/TX bytes
   * @returns {{ netRxBytes: number, netTxBytes: number }}
   */
  getNetworkBytes() {
    let rxBytes = 0;
    let txBytes = 0;

    if (process.platform === 'linux' && fs.existsSync('/proc/net/dev')) {
      try {
        const data = fs.readFileSync('/proc/net/dev', 'utf-8');
        const lines = data.split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10 && parts[0].includes(':') && !parts[0].startsWith('lo:')) {
            const rx = parseInt(parts[1], 10);
            const tx = parseInt(parts[9], 10);
            if (!isNaN(rx)) rxBytes += rx;
            if (!isNaN(tx)) txBytes += tx;
          }
        }
      } catch {
        // fallback
      }
    }

    return { netRxBytes: rxBytes, netTxBytes: txBytes };
  }

  /**
   * Collect full snapshot of node metrics
   * @param {string} serverId 
   * @returns {object}
   */
  collect(serverId) {
    const cpuPct = this.getCpuUsage();
    const ram = this.getRamUsage();
    const disk = this.getDiskUsage();
    const net = this.getNetworkBytes();
    const uptimeSec = Math.round(os.uptime());

    return {
      serverId,
      cpuPct,
      ...ram,
      ...disk,
      ...net,
      uptimeSec,
      timestamp: new Date().toISOString()
    };
  }
}
