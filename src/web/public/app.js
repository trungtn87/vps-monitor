// VPS Monitor V1 Frontend Logic
let currentChartServer = 'vinahost';

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initRefresh();
  fetchStatus();
  fetchMetrics();
  fetchEvents();

  // Auto-refresh every 15s
  setInterval(() => {
    fetchStatus();
    fetchMetrics();
    fetchEvents();
  }, 15000);
});

function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentChartServer = tab.getAttribute('data-chart');
      fetchMetrics();
    });
  });
}

function initRefresh() {
  const btn = document.getElementById('refreshBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      btn.textContent = '⏳ Đang tải...';
      Promise.all([fetchStatus(), fetchMetrics(), fetchEvents()]).finally(() => {
        btn.textContent = '🔄 Làm mới';
      });
    });
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatus(data);
    document.getElementById('connectionStatus').textContent = `Đồng bộ: ${new Date().toLocaleTimeString('vi-VN')}`;
    document.getElementById('connectionStatus').style.color = '#10b981';
  } catch (err) {
    document.getElementById('connectionStatus').textContent = 'Mất kết nối API';
    document.getElementById('connectionStatus').style.color = '#ef4444';
  }
}

function renderStatus(data) {
  if (!data || !data.servers) return;

  let minDaysRemaining = Infinity;
  let warnServerName = '';

  for (const srv of data.servers) {
    const prefix = srv.serverId === 'vinahost' ? 'vh' : 'nh';

    // Status dot & pill
    const state = srv.connectionState || 'UNKNOWN';
    const pill = document.getElementById(`${prefix}-status`);
    const dot = document.getElementById(`${prefix}-dot`);
    if (pill && dot) {
      if (state === 'STALE') {
        pill.textContent = 'STALE (Dữ liệu cũ)';
        pill.className = 'status-pill status-stale';
        dot.className = 'status-dot dot-stale';
      } else {
        pill.textContent = state;
        pill.className = `status-pill status-${state.toLowerCase()}`;
        dot.className = `status-dot dot-${state.toLowerCase()}`;
      }
    }

    // Heartbeat & App status
    const hbEl = document.getElementById(`${prefix}-heartbeat`);
    if (hbEl) {
      if (srv.isLocal) {
        if (srv.agentHealth && srv.agentHealth.isStale) {
          hbEl.textContent = `Node cục bộ (Agent cũ: ${srv.agentHealth.ageSec || '>180'}s)`;
          hbEl.style.color = '#fbbf24';
        } else {
          hbEl.textContent = 'Node cục bộ (Tốt)';
          hbEl.style.color = '#34d399';
        }
      } else {
        hbEl.textContent = srv.lastHeartbeatAt ? `${srv.elapsedSec}s trước` : 'Chưa nhận';
        if (srv.metrics && srv.metrics.isStale) {
          hbEl.textContent += ' [Chỉ số cũ]';
          hbEl.style.color = '#fbbf24';
        } else {
          hbEl.style.color = '';
        }
      }
    }

    // App Service status
    const svcEl = document.getElementById(`${prefix}-service`);
    if (svcEl) {
      if (srv.services && srv.services.length > 0) {
        const s = srv.services[0];
        svcEl.textContent = `${s.status} (${s.name})`;
        svcEl.style.color = s.status === 'HEALTHY' ? '#34d399' : (s.status === 'DISABLED' ? '#94a3b8' : '#f87171');
      } else {
        svcEl.textContent = 'Chưa cấu hình';
        svcEl.style.color = '#94a3b8';
      }
    }

    // Metrics
    if (srv.metrics) {
      const m = srv.metrics;
      const staleTag = m.isStale ? ' (cũ)' : '';
      updateMetricBar(`${prefix}-cpu`, m.cpuPct, `${m.cpuPct}%${staleTag}`, m.isStale);
      updateMetricBar(`${prefix}-ram`, m.ramPct, `${m.ramUsedMb} / ${m.ramTotalMb} MB (${m.ramPct}%)${staleTag}`, m.isStale);
      updateMetricBar(`${prefix}-disk`, m.diskPct, `${m.diskUsedGb} / ${m.diskTotalGb} GB (${m.diskPct}%)${staleTag}`, m.isStale);

      const rxMb = (m.netRxBytes / (1024 * 1024)).toFixed(1);
      const txMb = (m.netTxBytes / (1024 * 1024)).toFixed(1);
      document.getElementById(`${prefix}-net`).textContent = `${rxMb} / ${txMb} MB${staleTag}`;

      const days = Math.floor(m.uptimeSec / 86400);
      const hours = Math.floor((m.uptimeSec % 86400) / 3600);
      document.getElementById(`${prefix}-uptime`).textContent = `${days}d ${hours}h${staleTag}`;
    } else {
      document.getElementById(`${prefix}-cpu`).textContent = '--';
      document.getElementById(`${prefix}-ram`).textContent = '--';
      document.getElementById(`${prefix}-disk`).textContent = '--';
      document.getElementById(`${prefix}-net`).textContent = '--';
      document.getElementById(`${prefix}-uptime`).textContent = '--';
    }

    // Expiry
    const expDateEl = document.getElementById(`${prefix}-expiry-date`);
    const expDaysEl = document.getElementById(`${prefix}-days-remaining`);
    if (expDateEl && expDaysEl) {
      expDateEl.textContent = srv.expiryDate || 'Chưa nhập';
      if (srv.daysRemaining !== null) {
        expDaysEl.textContent = `Còn ${srv.daysRemaining} ngày`;
        if (srv.daysRemaining <= 3) {
          expDaysEl.className = 'days-remaining days-danger';
        } else if (srv.daysRemaining <= 7) {
          expDaysEl.className = 'days-remaining days-warn';
        } else {
          expDaysEl.className = 'days-remaining';
        }

        if (srv.daysRemaining < minDaysRemaining) {
          minDaysRemaining = srv.daysRemaining;
          warnServerName = srv.name;
        }
      } else {
        expDaysEl.textContent = '--';
      }
    }
  }

  // Top banner if expiry <= 7 days
  const banner = document.getElementById('expiryBanner');
  const bannerText = document.getElementById('expiryBannerText');
  if (banner && bannerText) {
    if (minDaysRemaining <= 7 && minDaysRemaining > -999) {
      banner.style.display = 'flex';
      bannerText.textContent = `CẢNH BÁO: ${warnServerName} sắp hết hạn trong ${minDaysRemaining} ngày!`;
    } else {
      banner.style.display = 'none';
    }
  }
}

function updateMetricBar(prefix, pct, labelText, isStale = false) {
  const valEl = document.getElementById(prefix);
  const barEl = document.getElementById(`${prefix}-bar`);
  if (valEl) {
    valEl.textContent = labelText;
    valEl.style.color = isStale ? '#fbbf24' : '';
  }
  if (barEl) {
    barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    barEl.className = 'progress-fill';
    if (isStale) {
      barEl.classList.add('progress-stale');
    } else if (pct >= 90) {
      barEl.classList.add('progress-danger');
    } else if (pct >= 80) {
      barEl.classList.add('progress-warn');
    }
  }
}

async function fetchMetrics() {
  try {
    const res = await fetch(`/api/metrics?server=${currentChartServer}&limit=40`);
    if (!res.ok) return;
    const data = await res.json();
    renderCharts(data.metrics || []);
  } catch {
    // charts stay unchanged on error
  }
}

function renderCharts(metrics) {
  const cpuSvg = document.getElementById('cpuChart');
  const ramSvg = document.getElementById('ramChart');
  if (!cpuSvg || !ramSvg) return;

  if (metrics.length === 0) {
    cpuSvg.innerHTML = '<text x="250" y="60" text-anchor="middle" fill="#64748b" font-size="12">Chưa có dữ liệu lịch sử</text>';
    ramSvg.innerHTML = '<text x="250" y="60" text-anchor="middle" fill="#64748b" font-size="12">Chưa có dữ liệu lịch sử</text>';
    return;
  }

  const cpuPoints = metrics.map(m => m.cpu_pct);
  const ramPoints = metrics.map(m => m.ram_pct);

  cpuSvg.innerHTML = generateSvgPath(cpuPoints, '#38bdf8');
  ramSvg.innerHTML = generateSvgPath(ramPoints, '#a855f7');
}

function generateSvgPath(dataPoints, strokeColor) {
  const width = 500;
  const height = 120;
  const pad = 10;
  const n = dataPoints.length;

  if (n === 1) {
    const y = height - pad - (dataPoints[0] / 100) * (height - 2 * pad);
    return `<circle cx="${width / 2}" cy="${y}" r="4" fill="${strokeColor}" />`;
  }

  const stepX = (width - 2 * pad) / (n - 1);
  const coords = dataPoints.map((val, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (val / 100) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M ${coords.join(' L ')}`;
  const areaD = `M ${coords[0]} L ${coords.join(' L ')} L ${width - pad},${height - pad} L ${pad},${height - pad} Z`;

  return `
    <line x1="${pad}" y1="${pad}" x2="${width - pad}" y2="${pad}" stroke="#334155" stroke-dasharray="4" />
    <text x="${pad}" y="${pad + 10}" fill="#64748b" font-size="10">100%</text>
    <path d="${areaD}" fill="${strokeColor}" fill-opacity="0.1" />
    <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  `;
}

async function fetchEvents() {
  try {
    const res = await fetch('/api/events?limit=30');
    if (!res.ok) return;
    const data = await res.json();
    renderEvents(data.events || []);
  } catch {
    // leave events intact
  }
}

function renderEvents(events) {
  const tbody = document.getElementById('eventsTableBody');
  const badge = document.getElementById('eventCountBadge');
  if (!tbody) return;

  if (badge) badge.textContent = `${events.length} sự kiện`;

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Chưa có sự kiện cảnh báo nào được ghi nhận.</td></tr>';
    return;
  }

  tbody.innerHTML = events.map(e => {
    const sevClass = e.severity === 'CRITICAL' ? 'badge-critical' : (e.severity === 'WARNING' ? 'badge-warning' : 'badge-info');
    const timeStr = new Date(e.created_at + 'Z').toLocaleString('vi-VN');
    return `
      <tr>
        <td>${timeStr}</td>
        <td><strong>${escapeHtml(e.server_id)}</strong></td>
        <td><code>${escapeHtml(e.event_type)}</code></td>
        <td><span class="${sevClass}">${escapeHtml(e.severity)}</span></td>
        <td>${escapeHtml(e.message)}</td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}
