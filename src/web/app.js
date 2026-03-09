const COLORS = ['#3fb950', '#58a6ff', '#bc8cff', '#06b6d4', '#f0883e', '#db61a2',
  '#f778ba', '#7ee787', '#d2a8ff', '#79c0ff', '#ffa657', '#ff7b72'];

class TeamsDashboardApp {
  constructor() {
    this.container = document.getElementById('flowContainer');
    this.nav = document.getElementById('sessionsNav');
    this.panel = document.getElementById('detailPanel');
    this.panelTitle = document.getElementById('panelTitle');
    this.panelMeta = document.getElementById('panelMeta');
    this.panelBody = document.getElementById('panelBody');
    this.panelClose = document.getElementById('panelClose');
    this.selectedAgent = null;
    this.agentColors = {};

    this.panelClose.addEventListener('click', () => this.closePanel());
    this.init();
  }

  async init() {
    try {
      const { sessions } = await (await fetch('/api/sessions')).json();
      this.sessions = sessions;
      this.currentSessionId = null;
      this.renderNav();
      if (sessions.length > 0) {
        this.currentSessionId = sessions[0].id;
        this.loadSession(sessions[0].id);
      }
      // Auto-refresh: poll for new/updated sessions every 10 seconds
      this.startAutoRefresh();
    } catch (e) {
      this.container.innerHTML = '<div class="empty-state">Failed to load sessions</div>';
    }
  }

  startAutoRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this.refreshSessions(), 10000);
  }

  async refreshSessions() {
    try {
      const { sessions } = await (await fetch('/api/sessions')).json();

      // Check if session list changed (new sessions, updated agent counts, etc.)
      const changed = sessions.length !== this.sessions.length ||
        sessions.some((s, i) => {
          const old = this.sessions[i];
          return !old || s.id !== old.id || s.agentCount !== old.agentCount ||
            s.endTime !== old.endTime || s.duration !== old.duration;
        });

      if (changed) {
        const activeId = this.currentSessionId;
        this.sessions = sessions;
        this.renderNav();

        // Re-select the previously active session
        if (activeId) {
          const btn = this.nav.querySelector(`.session-card[data-id="${activeId}"]`);
          if (btn) {
            this.nav.querySelectorAll('.session-card').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          }
        }

        // If we're viewing an active session, reload its data
        if (activeId && sessions.find(s => s.id === activeId)) {
          this.loadSession(activeId);
        } else if (sessions.length > 0 && !sessions.find(s => s.id === activeId)) {
          // Active session gone or new sessions available, select first
          this.currentSessionId = sessions[0].id;
          this.loadSession(sessions[0].id);
          const first = this.nav.querySelector('.session-card');
          if (first) {
            this.nav.querySelectorAll('.session-card').forEach(b => b.classList.remove('active'));
            first.classList.add('active');
          }
        }
      }
    } catch (e) {
      // Silently ignore refresh errors
    }
  }

  renderNav() {
    if (!this.sessions.length) {
      this.nav.innerHTML = '<span class="no-sessions">No sessions found</span>';
      return;
    }

    // Build trend sparkline data (last 20 sessions, reversed for chronological order)
    const trendData = this.sessions.slice(0, 20).map(s => s.efficiencyScore).reverse();
    const trendSvg = this.renderSparkline(trendData);

    this.nav.innerHTML = (trendData.some(v => v != null) ? `<div class="trend-container">
      <span class="trend-label">Efficiency trend</span>
      ${trendSvg}
    </div>` : '') + this.sessions.map((s, i) => {
      const date = new Date(s.startTime);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const dur = s.duration ? this.formatDuration(s.duration) : '';
      const project = s.shortProjectName || '';
      const desc = s.sessionDescription || '';
      const truncDesc = desc.length > 80 ? desc.substring(0, 80) + '...' : desc;
      const eff = s.efficiencyScore;
      const effColor = eff == null ? '#8b949e' : eff >= 70 ? '#3fb950' : eff >= 50 ? '#d29922' : '#f85149';
      const effStr = eff != null ? `${eff}%` : '–';
      const costStr = s.costGBP != null ? `\u00a3${s.costGBP.toFixed(2)}` : '';
      return `<button class="session-card${i === 0 ? ' active' : ''}" data-id="${s.id}">
        <span class="session-card-header">
          <span class="session-card-project">${this.esc(project)}</span>
          <span class="session-card-agents">${s.agentCount === 0 ? 'solo' : s.agentCount === 1 ? '1 agent' : s.agentCount + ' agents'}</span>
        </span>
        ${truncDesc ? `<span class="session-card-desc">${this.esc(truncDesc)}</span>` : ''}
        <span class="session-card-detail">${dateStr} ${timeStr}${dur ? ' &middot; ' + dur : ''} &middot; <span style="color:${effColor};font-weight:600">${effStr}</span>${costStr ? ' &middot; <span style="color:#d29922">' + costStr + '</span>' : ''}</span>
      </button>`;
    }).join('');
    this.nav.addEventListener('click', e => {
      const btn = e.target.closest('.session-card');
      if (!btn) return;
      this.nav.querySelectorAll('.session-card').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.closePanel();
      this.currentSessionId = btn.dataset.id;
      this.loadSession(btn.dataset.id);
    });
  }

  async loadSession(id) {
    this.container.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
    try {
      const [sRes, cRes, tRes] = await Promise.all([
        fetch(`/api/sessions/${id}`),
        fetch(`/api/sessions/${id}/communications`),
        fetch(`/api/sessions/${id}/tasks`)
      ]);
      this.data = {
        ...(await sRes.json()),
        communications: (await cRes.json()).communications,
        tasks: (await tRes.json()).tasks
      };
      this.sessionMeta = this.sessions.find(s => s.id === id) || {};

      const info = document.getElementById('sessionInfo');
      if (info) {
        const agents = Object.keys(this.data.agents || {}).length;
        const branch = this.data.gitBranch || '';
        const dur = this.data.duration ? this.formatDuration(this.data.duration) : '';
        const parts = [];
        parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
        if (branch) parts.push(`branch: ${branch}`);
        if (dur) parts.push(dur);
        info.textContent = parts.join(' \u00b7 ');
      }
      this.renderDashboard();
    } catch (e) {
      this.container.innerHTML = '<div class="empty-state">Failed to load session</div>';
    }
  }

  // ── Main dashboard ────────────────────────────────────────────────

  renderDashboard() {
    const { agents, communications, stats } = this.data;
    const agentList = Object.entries(agents).filter(([id]) => id !== 'lead');

    // Assign colors
    this.agentColors = { lead: '#d57455' };
    agentList.forEach(([id], i) => { this.agentColors[id] = COLORS[i % COLORS.length]; });

    // Build name lookup for communications
    this.lookup = {};
    this.nameOf = {};
    for (const [id, a] of Object.entries(agents)) {
      this.lookup[a.name] = id;
      this.lookup[id] = id;
      this.nameOf[id] = id === 'lead' ? 'Lead' : (a.name || id.substring(0, 8));
      this.nameOf[a.name] = this.nameOf[id];
    }

    // Pre-compute delegation tasks for each agent
    this.agentTasks = {};
    for (const c of communications) {
      if (c.messageType === 'delegation' && c.content) {
        const toId = this.lookup[c.to] || c.to;
        if (!this.agentTasks[toId]) {
          this.agentTasks[toId] = c.content.text || c.content.detail || '';
        }
      }
    }

    this.container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'dashboard-wrapper';

    // 1. Banner
    const desc = this.sessionMeta.sessionDescription;
    if (desc) wrapper.appendChild(this.renderBanner(desc));

    // 2. Stats
    wrapper.appendChild(this.renderStats(agents, stats, communications));

    // 3. Performance Insights
    const insights = this.renderInsights(stats);
    if (insights) wrapper.appendChild(insights);

    // 4. Timeline
    const timelineSection = document.createElement('div');
    timelineSection.innerHTML = `<div class="section-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      Timeline
    </div>`;
    timelineSection.appendChild(this.renderTimeline(agents, agentList, communications));
    wrapper.appendChild(timelineSection);

    // 5. Agent cards
    const agentsSection = document.createElement('div');
    agentsSection.innerHTML = `<div class="section-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Agents (${agentList.length})
    </div>`;
    agentsSection.appendChild(this.renderAgentGrid(agents, agentList, communications));
    wrapper.appendChild(agentsSection);

    // 6. File Heatmap
    const heatmap = this.renderFileHeatmap(stats);
    if (heatmap) wrapper.appendChild(heatmap);

    this.container.appendChild(wrapper);
  }

  // ── Banner ────────────────────────────────────────────────────────

  renderBanner(desc) {
    const el = document.createElement('div');
    el.className = 'session-banner';
    const startDate = this.data.startTime ? new Date(this.data.startTime) : null;
    const dateStr = startDate
      ? startDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' ' + startDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : '';

    // Session tags
    const tags = this.data.stats?.sessionTags || [];
    const tagColorMap = {
      'bug-fix': 'tag-bug', 'bugfix': 'tag-bug', 'bug': 'tag-bug',
      'feature': 'tag-feature', 'feat': 'tag-feature',
      'ui': 'tag-ui', 'frontend': 'tag-ui', 'ux': 'tag-ui',
      'backend': 'tag-backend', 'api': 'tag-backend', 'database': 'tag-backend', 'db': 'tag-backend',
      'refactor': 'tag-refactor', 'cleanup': 'tag-refactor',
      'test': 'tag-test', 'testing': 'tag-test',
      'docs': 'tag-docs', 'documentation': 'tag-docs',
      'perf': 'tag-perf', 'performance': 'tag-perf', 'optimize': 'tag-perf',
      'devops': 'tag-devops', 'deploy': 'tag-devops', 'ci': 'tag-devops',
    };
    const tagsHtml = tags.length
      ? `<div class="session-tags">${tags.map(t => {
          const cls = tagColorMap[t.toLowerCase()] || 'tag-other';
          return `<span class="session-tag ${cls}">${this.esc(t)}</span>`;
        }).join('')}</div>`
      : '';

    el.innerHTML = `
      <div class="session-banner-desc" title="${this.esc(desc)}">${this.esc(desc)}</div>
      <div class="session-banner-right">
        ${tagsHtml}
        <div class="session-banner-meta">
          ${dateStr ? `<span>${dateStr}</span>` : ''}
          ${this.data.gitBranch ? `<span>&#9678; ${this.esc(this.data.gitBranch)}</span>` : ''}
        </div>
      </div>
    `;
    return el;
  }

  // ── Stats bar ─────────────────────────────────────────────────────

  renderStats(agents, stats, communications) {
    const totalTools = stats?.toolUsages || 0;
    const topTools = Object.entries(stats?.toolBreakdown || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const agentCount = Object.keys(agents).length - 1;
    const dur = this.data.duration ? this.formatDuration(this.data.duration) : null;
    const totalEvents = stats?.totalEvents || 0;

    // Efficiency score
    const eff = stats?.efficiencyScore ?? 0;
    const effColor = eff >= 70 ? '#3fb950' : eff >= 50 ? '#d29922' : '#f85149';
    const effLabel = eff >= 70 ? 'Good' : eff >= 50 ? 'Fair' : 'Poor';

    // Lead phases summary
    const phases = stats?.leadPhases || {};
    const postAgent = phases.postAgent ? this.formatDuration(phases.postAgent) : '0s';
    const postPct = Math.round(phases.postAgentPct || 0);

    // Token usage & cost
    const tokens = stats?.tokenUsage || {};
    const totalTokensStr = this.formatTokenCount(tokens.total || 0);
    const costGBP = tokens.costGBP || 0;
    const costUSD = tokens.costUSD || 0;

    const el = document.createElement('div');
    el.className = 'stats-bar';
    el.innerHTML = `
      <div class="stat-card" style="--stat-accent: ${effColor}">
        <div class="stat-value" style="color:${effColor}">${eff}%</div>
        <div class="stat-label">Efficiency <span class="stat-hint">${effLabel}</span></div>
      </div>
      <div class="stat-card" style="--stat-accent: ${COLORS[0]}">
        <div class="stat-value">${agentCount}</div>
        <div class="stat-label">Agents</div>
      </div>
      ${dur ? `<div class="stat-card" style="--stat-accent: ${COLORS[1]}">
        <div class="stat-value">${dur}</div>
        <div class="stat-label">Duration</div>
      </div>` : ''}
      <div class="stat-card" style="--stat-accent: ${COLORS[2]}">
        <div class="stat-value">${totalTools}</div>
        <div class="stat-label">Tool calls</div>
      </div>
      <div class="stat-card" style="--stat-accent: ${COLORS[3]}">
        <div class="stat-value">${totalEvents}</div>
        <div class="stat-label">Events</div>
      </div>
      <div class="stat-card" style="--stat-accent: #f0883e" title="Input: ${this.formatTokenCount(tokens.input || 0)} | Output: ${this.formatTokenCount(tokens.output || 0)} | Cache read: ${this.formatTokenCount(tokens.cacheRead || 0)} | Cache write: ${this.formatTokenCount(tokens.cacheWrite || 0)}">
        <div class="stat-value">${totalTokensStr}</div>
        <div class="stat-label">Tokens</div>
      </div>
      <div class="stat-card" style="--stat-accent: #d29922" title="$${costUSD.toFixed(2)} USD at Opus 4.6 pay-as-you-go rates">
        <div class="stat-value">\u00a3${costGBP.toFixed(2)}</div>
        <div class="stat-label">API cost <span class="stat-hint">pay-as-you-go</span></div>
      </div>
      <div class="stat-card stat-card-wide" style="--stat-accent: var(--accent)">
        <div class="stat-label" style="margin-bottom:6px">Top tools</div>
        <div class="stat-tools">${topTools.map(([n, c]) =>
          `<span class="tool-badge">${this.esc(n)} <strong>${c}</strong></span>`
        ).join('')}</div>
      </div>
      ${stats?.parallelism != null ? (() => {
        const pscore = stats.parallelism.score ?? 0;
        const pcolor = pscore >= 70 ? '#3fb950' : pscore >= 40 ? '#d29922' : '#f85149';
        const peak = stats.parallelism.peakConcurrency ?? 0;
        return `<div class="stat-card" style="--stat-accent: ${pcolor}" title="Peak concurrency: ${peak} agents running simultaneously">
          <div class="stat-value" style="color:${pcolor}">${pscore}%</div>
          <div class="stat-label">Parallelism <span class="stat-hint">peak ${peak}</span></div>
        </div>`;
      })() : ''}
    `;
    return el;
  }

  // ── Timeline ──────────────────────────────────────────────────────

  renderTimeline(agents, agentList, communications) {
    const container = document.createElement('div');
    container.className = 'timeline-section';

    const sessionStart = new Date(this.data.startTime).getTime();
    const sessionEnd = new Date(this.data.endTime).getTime();
    const totalMs = Math.max(sessionEnd - sessionStart, 1000);

    // Lead + agents sorted by start time
    const rows = [];
    if (agents.lead) {
      rows.push({ id: 'lead', agent: agents.lead, color: this.agentColors.lead });
    }
    agentList
      .sort((a, b) => new Date(a[1].startTime) - new Date(b[1].startTime))
      .forEach(([id, a]) => {
        rows.push({ id, agent: a, color: this.agentColors[id] });
      });

    const timeMarks = this.generateTimeMarks(sessionStart, sessionEnd);

    let html = '<div class="timeline-container">';

    // Table-style layout: header row
    html += '<div class="tl-header">';
    html += '<div class="tl-name-col"></div>';
    html += '<div class="tl-chart-col">';
    for (const mark of timeMarks) {
      const pct = ((mark.time - sessionStart) / totalMs) * 100;
      html += `<span class="time-mark" style="left:${pct}%">${mark.label}</span>`;
    }
    html += '</div>';
    html += '<div class="tl-stats-col"><span class="tl-stats-header">Duration</span><span class="tl-stats-header">Events</span><span class="tl-stats-header">Tools</span></div>';
    html += '</div>';

    // Data rows
    for (const row of rows) {
      const a = row.agent;
      const start = new Date(a.startTime).getTime();
      const end = new Date(a.endTime).getTime();
      const leftPct = ((start - sessionStart) / totalMs) * 100;
      const rawWidthPct = ((end - start) / totalMs) * 100;
      const widthPct = Math.max(rawWidthPct, 1.5);
      const dur = this.formatDuration(end - start);
      const events = a.eventCount || 0;
      const isLead = row.id === 'lead';
      const totalTools = Object.values(a.toolsUsed || {}).reduce((s, v) => s + v, 0);

      const displayName = isLead ? 'Lead (Orchestrator)' : (a.name || row.id.substring(0, 7));
      const truncName = displayName.length > 24 ? displayName.substring(0, 22) + '..' : displayName;

      // Get delegation task for subagents
      const task = isLead ? '' : (this.agentTasks[row.id] || '');
      const truncTask = task.length > 40 ? task.substring(0, 38) + '..' : task;

      html += `<div class="tl-row${isLead ? ' tl-row-lead' : ''}" data-agent-id="${row.id}">`;

      // Name column
      html += `<div class="tl-name-col">`;
      html += `<span class="timeline-dot" style="background:${row.color}"></span>`;
      html += `<div class="tl-name-wrap">`;
      html += `<span class="timeline-name" title="${this.esc(displayName)}">${this.esc(truncName)}</span>`;
      const agentData = agents[row.id];
      if (agentData && !agentData.isLead) {
        const badgeType = agentData.subagentType || 'no type';
        const badgeClass = this.agentTypeBadgeClass(badgeType);
        html += `<span class="agent-type-badge ${badgeClass}">${this.esc(badgeType)}</span>`;
      }
      if (truncTask) html += `<span class="tl-task" title="${this.esc(task)}">${this.esc(truncTask)}</span>`;
      html += `</div></div>`;

      // Chart column with bar
      html += `<div class="tl-chart-col">`;
      for (const mark of timeMarks) {
        const pct = ((mark.time - sessionStart) / totalMs) * 100;
        html += `<div class="timeline-gridline" style="left:${pct}%"></div>`;
      }

      // Lead gets phased bar (planning → waiting → post-agent)
      const phases = this.data.stats?.leadPhases;
      if (isLead && phases && phases.planning != null) {
        const planW = Math.max((phases.planning / totalMs) * 100, 0.3);
        const waitW = Math.max((phases.waiting / totalMs) * 100, 0.3);
        const postW = Math.max((phases.postAgent / totalMs) * 100, 0.3);
        const postDur = phases.postAgent > 0 ? this.formatDuration(phases.postAgent) : '0s';
        html += `<div class="timeline-bar-phased" style="left:${leftPct}%;width:${widthPct}%;" title="Planning: ${this.formatDuration(phases.planning)} | Waiting: ${this.formatDuration(phases.waiting)} | Post-agent: ${postDur}">`;
        html += `<div class="phase-planning" style="width:${(phases.planningPct || 0).toFixed(1)}%"></div>`;
        html += `<div class="phase-waiting" style="width:${(phases.waitingPct || 0).toFixed(1)}%"></div>`;
        html += `<div class="phase-postagent" style="width:${(phases.postAgentPct || 0).toFixed(1)}%"></div>`;
        html += `</div>`;
      } else {
        html += `<div class="timeline-bar" style="left:${leftPct}%;width:${widthPct}%;background:${row.color}" title="${this.esc(displayName)}: ${dur}"></div>`;
      }
      html += `</div>`;

      // Stats columns — always visible
      html += `<div class="tl-stats-col">`;
      html += `<span class="tl-stat">${dur}</span>`;
      html += `<span class="tl-stat">${events}</span>`;
      html += `<span class="tl-stat">${totalTools}</span>`;
      html += `</div>`;

      html += `</div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.tl-row').forEach(rowEl => {
      rowEl.addEventListener('click', () => {
        this.openPanel(rowEl.dataset.agentId, agents, this.data.tasks, communications);
      });
    });

    return container;
  }

  generateTimeMarks(start, end) {
    const totalMs = end - start;
    const marks = [];
    let interval;
    if (totalMs < 120000) interval = 15000;
    else if (totalMs < 600000) interval = 60000;
    else if (totalMs < 3600000) interval = 300000;
    else if (totalMs < 36000000) interval = 1800000;
    else interval = 3600000;

    const firstMark = Math.ceil(start / interval) * interval;
    for (let t = firstMark; t <= end; t += interval) {
      const d = new Date(t);
      let label;
      if (interval < 60000) {
        label = `${Math.floor((t - start) / 1000)}s`;
      } else {
        label = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      marks.push({ time: t, label });
    }
    return marks;
  }

  // ── Agent cards ───────────────────────────────────────────────────

  renderAgentGrid(agents, agentList, communications) {
    const container = document.createElement('div');
    container.className = 'agent-grid';

    const sorted = [...agentList].sort((a, b) => (b[1].eventCount || 0) - (a[1].eventCount || 0));

    for (const [id, a] of sorted) {
      const color = this.agentColors[id];
      const tools = Object.entries(a.toolsUsed || {}).sort((x, y) => y[1] - x[1]);
      const totalTools = tools.reduce((s, t) => s + t[1], 0);
      const task = this.agentTasks[id] || '';
      const truncTask = task.length > 120 ? task.substring(0, 120) + '...' : task;

      const start = a.startTime ? new Date(a.startTime) : null;
      const end = a.endTime ? new Date(a.endTime) : null;
      const dur = start && end ? this.formatDuration(end - start) : '';

      // Per-agent tokens
      const agentTokenData = this.data.stats?.tokenUsage?.agentTokens?.[id];
      const agentTokenStr = agentTokenData ? this.formatTokenCount(agentTokenData.total) : null;

      // Read/Write ratio
      const ratio = this.data.stats?.agentRatios?.[id] || {};
      const writePct = ratio.writePct || 0;
      const readPct = ratio.readPct || 0;
      const isImplType = a.subagentType && ['backend-developer', 'frontend-developer', 'fullstack-developer', 'backend-architect', 'devops-engineer', 'mobile-developer'].includes(a.subagentType);
      const rwWarning = isImplType && writePct < 10;

      // Mini tool bar — top 3 tools as proportional bar
      const top3 = tools.slice(0, 3);
      const barTotal = top3.reduce((s, t) => s + t[1], 0);
      const miniBar = top3.map(([n, c], i) => {
        const pct = (c / Math.max(barTotal, 1)) * 100;
        const barColor = ['#58a6ff', '#3fb950', '#bc8cff'][i] || '#8b949e';
        return `<div class="mini-bar-seg" style="width:${pct}%;background:${barColor}" title="${n}: ${c}"></div>`;
      }).join('');

      // ── New performance metrics ──
      // Autonomy Score
      const autonomy = this.data.stats?.agentAutonomy?.[id];
      let autonomyHtml = '';
      if (autonomy != null) {
        const total = autonomy.total || 1;
        const prodPct = Math.round((autonomy.productive / total) * 100);
        const invPct = Math.round((autonomy.investigation / total) * 100);
        const otherPct = Math.max(0, 100 - prodPct - invPct);
        const score = autonomy.score ?? prodPct;
        autonomyHtml = `<div class="agent-autonomy">
          <div class="agent-autonomy-bar">
            <div class="autonomy-productive" style="width:${prodPct}%" title="Productive: ${prodPct}%"></div>
            <div class="autonomy-investigation" style="width:${invPct}%" title="Investigation: ${invPct}%"></div>
            <div class="autonomy-other" style="width:${otherPct}%" title="Other: ${otherPct}%"></div>
          </div>
          <span class="agent-autonomy-score">${score}%</span>
        </div>`;
      }

      // Cost
      const costData = this.data.stats?.costPerAgent?.[id];
      let costHtml = '';
      if (costData != null) {
        const costGBP = costData.costGBP ?? 0;
        const cpt = costData.costPerTool != null ? `\u00a3${costData.costPerTool.toFixed(4)}/tool` : '';
        const cpe = costData.costPerEdit != null ? `\u00a3${costData.costPerEdit.toFixed(4)}/edit` : '';
        const tooltipParts = [cpt, cpe].filter(Boolean).join(' | ');
        costHtml = `<div class="agent-cost" title="${this.esc(tooltipParts)}">\u00a3${costGBP.toFixed(2)}</div>`;
      }

      // Time to First Edit
      const ttfe = this.data.stats?.timeToFirstEdit?.[id];
      let ttfeHtml = '';
      if (ttfe != null) {
        const never = ttfe === -1;
        const tooSlow = !never && isImplType && ttfe > 120000;
        const ttfeStr = never ? 'Never' : this.formatDuration(ttfe);
        const ttfeColor = never ? '#f85149' : tooSlow ? '#d29922' : 'var(--text-secondary)';
        ttfeHtml = `<div class="agent-ttfe" style="color:${ttfeColor}" title="Time to first file edit">${ttfeStr}</div>`;
      }

      // Spawn Latency
      const spawnMs = this.data.stats?.spawnLatency?.[id];
      let spawnHtml = '';
      if (spawnMs != null) {
        const spawnStr = this.formatDuration(spawnMs);
        const spawnColor = spawnMs > 15000 ? '#f85149' : spawnMs > 5000 ? '#d29922' : 'var(--text-muted)';
        spawnHtml = `<div class="agent-spawn" style="color:${spawnColor}" title="Spawn latency">${spawnStr}</div>`;
      }

      // Error count badge
      const agentErrors = this.data.stats?.errorCounts?.byAgent?.[id] ?? 0;
      const errorBadgeHtml = agentErrors > 0
        ? `<span class="agent-error-badge">${agentErrors} err${agentErrors > 1 ? 's' : ''}</span>`
        : '';

      // Combine performance metrics row
      const hasPerf = autonomyHtml || costHtml || ttfeHtml || spawnHtml || errorBadgeHtml;
      const perfRowHtml = hasPerf ? `<div class="agent-perf-row">
        ${autonomyHtml}
        <div class="agent-perf-meta">
          ${costHtml}
          ${ttfeHtml ? `<div class="agent-perf-item"><span class="agent-perf-label">1st edit</span>${ttfeHtml}</div>` : ''}
          ${spawnHtml ? `<div class="agent-perf-item"><span class="agent-perf-label">spawn</span>${spawnHtml}</div>` : ''}
          ${errorBadgeHtml}
        </div>
      </div>` : '';

      const card = document.createElement('div');
      card.className = 'agent-card';
      card.style.setProperty('--card-accent', color);
      card.dataset.agentId = id;
      card.innerHTML = `
        <div class="agent-card-header">
          <span class="agent-card-dot" style="background:${color}"></span>
          <span class="agent-card-name" title="${this.esc(a.name || id)}">${this.esc(a.name || id)}</span>
          ${a.subagentType ? `<span class="agent-type-badge ${this.agentTypeBadgeClass(a.subagentType)}">${this.esc(a.subagentType)}</span>` : '<span class="agent-type-badge badge-unknown">no type</span>'}
        </div>
        ${truncTask ? `<div class="agent-card-task">${this.esc(truncTask)}</div>` : ''}
        <div class="agent-card-stats">
          <div class="agent-card-stat">
            <span class="agent-card-stat-value">${dur || '-'}</span>
            <span class="agent-card-stat-label">Duration</span>
          </div>
          <div class="agent-card-stat">
            <span class="agent-card-stat-value">${a.eventCount || 0}</span>
            <span class="agent-card-stat-label">Events</span>
          </div>
          <div class="agent-card-stat">
            <span class="agent-card-stat-value">${a.messageCount || 0}</span>
            <span class="agent-card-stat-label">Messages</span>
          </div>
          <div class="agent-card-stat">
            <span class="agent-card-stat-value">${totalTools}</span>
            <span class="agent-card-stat-label">Tools</span>
          </div>
          ${agentTokenStr ? `<div class="agent-card-stat">
            <span class="agent-card-stat-value">${agentTokenStr}</span>
            <span class="agent-card-stat-label">Tokens</span>
          </div>` : ''}
        </div>
        ${perfRowHtml}
        ${totalTools > 0 ? `
          <div class="rw-ratio-container${rwWarning ? ' rw-warning' : ''}">
            <div class="rw-ratio-bar">
              <div class="rw-read" style="width:${readPct}%" title="Read: ${readPct}%"></div>
              <div class="rw-write" style="width:${writePct}%" title="Write: ${writePct}%"></div>
            </div>
            <div class="rw-ratio-label">
              <span>Read ${readPct}%</span>
              <span${rwWarning ? ' style="color:#f85149"' : ''}>Write ${writePct}%${rwWarning ? ' ⚠' : ''}</span>
            </div>
          </div>
        ` : ''}
        ${tools.length ? `
          <div class="mini-bar-container">
            <div class="mini-bar">${miniBar}</div>
            <div class="mini-bar-legend">${top3.map(([n, c], i) => {
              const dotColor = ['#58a6ff', '#3fb950', '#bc8cff'][i] || '#8b949e';
              return `<span><span class="mini-bar-dot" style="background:${dotColor}"></span>${this.esc(n)} ${c}</span>`;
            }).join('')}${tools.length > 3 ? `<span class="mini-bar-more">+${tools.length - 3} more</span>` : ''}</div>
          </div>
        ` : ''}
      `;
      card.addEventListener('click', () => {
        this.openPanel(id, agents, this.data.tasks, communications);
      });
      container.appendChild(card);
    }
    return container;
  }

  // ── Performance Insights section ─────────────────────────────────

  renderInsights(stats) {
    if (!stats) return null;
    const section = document.createElement('div');
    section.className = 'insights-section';
    section.innerHTML = `<div class="section-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Performance Insights
    </div>`;

    const grid = document.createElement('div');
    grid.className = 'insights-grid';

    // ── Card 1: Lead Post-Agent Activity ──
    const leadPost = stats.leadPostAgent;
    if (leadPost != null) {
      const totalCalls = leadPost.totalCalls || 0;
      const warn = totalCalls > 10;
      const topPostTools = Object.entries(leadPost.tools || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      const card = document.createElement('div');
      card.className = `insight-card${warn ? ' insight-warn' : ''}`;
      card.innerHTML = `
        <div class="insight-card-title">
          Lead Post-Agent Activity
          ${warn ? '<span class="insight-warning-badge">Too much work</span>' : ''}
        </div>
        <div class="insight-big-number" style="color:${warn ? '#f85149' : 'var(--text-primary)'}">${totalCalls}</div>
        <div class="insight-sublabel">tool calls after agents finished</div>
        ${topPostTools.length ? `<div class="insight-badges">${topPostTools.map(([n, c]) =>
          `<span class="tool-badge-sm">${this.esc(n)} <span class="tool-count">${c}</span></span>`
        ).join('')}</div>` : ''}
      `;
      grid.appendChild(card);
    }

    // ── Card 2: Duplicate Work ──
    const dupWork = stats.duplicateWork;
    if (dupWork != null) {
      const count = dupWork.count || 0;
      const warn = count > 3;
      const top5 = (dupWork.files || []).slice(0, 5);
      const card = document.createElement('div');
      card.className = `insight-card${warn ? ' insight-warn' : ''}`;
      card.innerHTML = `
        <div class="insight-card-title">
          Duplicate Work
          ${warn ? '<span class="insight-warning-badge">Overlap detected</span>' : ''}
        </div>
        <div class="insight-big-number" style="color:${warn ? '#f85149' : 'var(--text-primary)'}">${count}</div>
        <div class="insight-sublabel">files touched by 2+ agents</div>
        ${top5.length ? `<div class="insight-dup-list">${top5.map(f => {
          const shortPath = f.path.length > 32 ? '...' + f.path.slice(-32) : f.path;
          return `<div class="insight-dup-row">
            <span class="insight-dup-path" title="${this.esc(f.path)}">${this.esc(shortPath)}</span>
            <span class="insight-dup-agents">${(f.agents || []).length} agents</span>
          </div>`;
        }).join('')}</div>` : ''}
      `;
      grid.appendChild(card);
    }

    // ── Card 3: Error Summary ──
    const errorCounts = stats.errorCounts;
    if (errorCounts != null) {
      const total = errorCounts.total || 0;
      const warn = total > 5;
      const byAgent = Object.entries(errorCounts.byAgent || {})
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1]);
      const maxCount = byAgent.length ? Math.max(...byAgent.map(([, c]) => c)) : 1;
      const card = document.createElement('div');
      card.className = `insight-card${warn ? ' insight-warn' : ''}`;
      card.innerHTML = `
        <div class="insight-card-title">
          Error Summary
          ${warn ? '<span class="insight-warning-badge">High errors</span>' : ''}
        </div>
        <div class="insight-big-number" style="color:${total > 0 ? '#f85149' : 'var(--text-primary)'}">${total}</div>
        <div class="insight-sublabel">total errors across session</div>
        ${byAgent.length ? `<div class="insight-error-bars">${byAgent.slice(0, 6).map(([id, c]) => {
          const pct = (c / maxCount) * 100;
          const name = this.nameOf[id] || id.substring(0, 8);
          const barColor = this.agentColors[id] || '#f85149';
          return `<div class="insight-error-bar-row">
            <span class="insight-error-agent">${this.esc(name)}</span>
            <div class="insight-error-track"><div class="insight-error-fill" style="width:${pct}%;background:${barColor}"></div></div>
            <span class="insight-error-count">${c}</span>
          </div>`;
        }).join('')}</div>` : '<div class="insight-sublabel" style="margin-top:6px">No errors recorded</div>'}
      `;
      grid.appendChild(card);
    }

    // ── Card 4: Model Distribution ──
    const modelDist = stats.modelDistribution;
    if (modelDist != null && Object.keys(modelDist).length > 0) {
      const models = Object.entries(modelDist).sort((a, b) => b[1] - a[1]);
      const totalModelCalls = models.reduce((s, [, c]) => s + c, 0);
      const modelColors = ['#58a6ff', '#3fb950', '#bc8cff', '#f0883e', '#d29922', '#db61a2'];
      const card = document.createElement('div');
      card.className = 'insight-card';
      const stackSegments = models.map(([name, count], i) => {
        const pct = (count / Math.max(totalModelCalls, 1)) * 100;
        const color = modelColors[i % modelColors.length];
        const shortName = name.replace(/^claude-/i, '').replace(/-\d{8}$/, '');
        return `<div class="model-stack-seg" style="width:${pct}%;background:${color}" title="${this.esc(name)}: ${count}"></div>`;
      }).join('');
      const legend = models.map(([name, count], i) => {
        const pct = ((count / Math.max(totalModelCalls, 1)) * 100).toFixed(0);
        const color = modelColors[i % modelColors.length];
        const shortName = name.replace(/^claude-/i, '').replace(/-\d{8}$/, '');
        return `<div class="model-legend-row">
          <span class="model-legend-dot" style="background:${color}"></span>
          <span class="model-legend-name" title="${this.esc(name)}">${this.esc(shortName)}</span>
          <span class="model-legend-count">${count} <span class="model-legend-pct">(${pct}%)</span></span>
        </div>`;
      }).join('');
      card.innerHTML = `
        <div class="insight-card-title">Model Distribution</div>
        <div class="model-stack-bar">${stackSegments}</div>
        <div class="model-legend">${legend}</div>
      `;
      grid.appendChild(card);
    }

    // ── Card 5: Cumulative Cost Chart ──
    const cumCost = stats.cumulativeCost;
    if (cumCost != null && cumCost.length >= 2) {
      const card = document.createElement('div');
      card.className = 'insight-card insight-card-wide';
      const finalCost = cumCost[cumCost.length - 1]?.costGBP || 0;
      card.innerHTML = `
        <div class="insight-card-title">Cumulative API Cost</div>
        <div class="insight-cost-header">
          <span class="insight-big-number">\u00a3${finalCost.toFixed(2)}</span>
          <span class="insight-sublabel">total session cost</span>
        </div>
        ${this.renderCumulativeCostChart(cumCost)}
      `;
      grid.appendChild(card);
    }

    section.appendChild(grid);
    return section;
  }

  renderCumulativeCostChart(data) {
    if (!data || data.length < 2) return '';
    const w = 600, h = 80, padX = 8, padY = 6;
    const times = data.map(d => new Date(d.timestamp).getTime());
    const costs = data.map(d => d.costGBP || 0);
    const minT = times[0], maxT = times[times.length - 1];
    const minC = 0, maxC = Math.max(...costs, 0.001);
    const rangeT = Math.max(maxT - minT, 1);
    const rangeC = maxC - minC || 1;

    const pts = data.map((d, i) => {
      const x = padX + ((times[i] - minT) / rangeT) * (w - 2 * padX);
      const y = h - padY - ((costs[i] - minC) / rangeC) * (h - 2 * padY);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Area fill path
    const firstPt = pts[0].split(',');
    const lastPt = pts[pts.length - 1].split(',');
    const areaPath = `M ${firstPt[0]} ${h - padY} L ${pts.map(p => p.replace(',', ' ')).join(' L ')} L ${lastPt[0]} ${h - padY} Z`;

    return `<svg class="cost-chart" width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#d29922" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#d29922" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#costGrad)"/>
      <polyline fill="none" stroke="#d29922" stroke-width="1.5" points="${pts.join(' ')}"/>
      <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="3" fill="#d29922"/>
    </svg>`;
  }

  // ── File Heatmap section ──────────────────────────────────────────

  renderFileHeatmap(stats) {
    if (!stats?.fileHeatmap || stats.fileHeatmap.length === 0) return null;

    const section = document.createElement('div');
    section.className = 'heatmap-section';
    section.innerHTML = `<div class="section-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      File Heatmap
    </div>`;

    const top15 = stats.fileHeatmap.slice(0, 15);
    const maxCount = Math.max(...top15.map(f => f.count), 1);

    let rows = top15.map(f => {
      const intensity = f.count / maxCount;
      const barPct = (f.count / maxCount) * 100;
      const agentDots = (f.agents || []).slice(0, 6).map(id => {
        const color = this.agentColors[id] || '#8b949e';
        const name = this.nameOf[id] || id.substring(0, 6);
        return `<span class="heatmap-agent-dot" style="background:${color}" title="${this.esc(name)}"></span>`;
      }).join('');
      const extraAgents = (f.agents || []).length > 6 ? `<span class="heatmap-agent-more">+${f.agents.length - 6}</span>` : '';

      const filename = f.path.split('/').pop();
      const dirPart = f.path.length > filename.length ? f.path.slice(0, f.path.length - filename.length - 1) : '';
      const truncDir = dirPart.length > 28 ? '...' + dirPart.slice(-28) : dirPart;

      return `<tr class="heatmap-row" style="--heat-intensity: ${intensity.toFixed(2)}">
        <td class="heatmap-path" title="${this.esc(f.path)}">
          ${truncDir ? `<span class="heatmap-dir">${this.esc(truncDir)}/</span>` : ''}
          <span class="heatmap-file">${this.esc(filename)}</span>
        </td>
        <td class="heatmap-bar-cell">
          <div class="heatmap-bar-track">
            <div class="heatmap-bar-fill" style="width:${barPct}%"></div>
          </div>
        </td>
        <td class="heatmap-count">${f.count}</td>
        <td class="heatmap-reads">${f.reads ?? '-'}</td>
        <td class="heatmap-writes">${f.writes ?? '-'}</td>
        <td class="heatmap-agents">${agentDots}${extraAgents}</td>
      </tr>`;
    }).join('');

    const tableEl = document.createElement('div');
    tableEl.className = 'heatmap-table-wrap';
    tableEl.innerHTML = `<table class="heatmap-table">
      <thead>
        <tr>
          <th class="heatmap-th">File</th>
          <th class="heatmap-th">Accesses</th>
          <th class="heatmap-th heatmap-th-num">Total</th>
          <th class="heatmap-th heatmap-th-num">Reads</th>
          <th class="heatmap-th heatmap-th-num">Writes</th>
          <th class="heatmap-th">Agents</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

    section.appendChild(tableEl);
    return section;
  }

  // ── Detail panel ──────────────────────────────────────────────────

  openPanel(nid, agents, tasks, communications) {
    const agent = agents[nid];
    if (!agent) return;

    if (this.selectedAgent) {
      this.container.querySelectorAll('.agent-card.selected, .tl-row.selected')
        .forEach(el => el.classList.remove('selected'));
    }
    this.selectedAgent = nid;
    this.container.querySelectorAll(`[data-agent-id="${nid}"]`)
      .forEach(el => el.classList.add('selected'));

    const color = this.agentColors[nid] || '#8b949e';

    const agentTypeSuffix = agent.subagentType && agent.subagentType !== 'general' ? ` (${agent.subagentType})` : '';
    this.panelTitle.textContent = nid === 'lead' ? 'Lead (Orchestrator)' : agent.name + agentTypeSuffix;
    this.panelTitle.style.color = color;

    const start = agent.startTime ? new Date(agent.startTime) : null;
    const end = agent.endTime ? new Date(agent.endTime) : null;
    const dur = start && end ? this.formatDuration(end - start) : '';
    const totalTools = Object.values(agent.toolsUsed || {}).reduce((s, v) => s + v, 0);
    this.panelMeta.textContent = `${agent.eventCount} events \u00b7 ${agent.messageCount} msgs \u00b7 ${totalTools} tools${dur ? ' \u00b7 ' + dur : ''}`;

    const received = communications.filter(c => (this.lookup[c.to]) === nid);
    const sent = communications.filter(c => (this.lookup[c.from]) === nid);

    const interactionMap = new Map();
    for (const c of received) {
      const fid = this.lookup[c.from] || c.from;
      if (!interactionMap.has(fid)) interactionMap.set(fid, { received: 0, sent: 0 });
      interactionMap.get(fid).received++;
    }
    for (const c of sent) {
      const tid = this.lookup[c.to] || c.to;
      if (!interactionMap.has(tid)) interactionMap.set(tid, { received: 0, sent: 0 });
      interactionMap.get(tid).sent++;
    }

    const agentTasks = tasks.filter(t =>
      t.createdBy === nid || t.owner === nid ||
      t.createdBy === agent.name || t.owner === agent.name
    );

    const tools = Object.entries(agent.toolsUsed || {}).sort((a, b) => b[1] - a[1]);

    let html = '';

    // Delegation task (what was this agent asked to do?)
    const taskDesc = this.agentTasks[nid];
    if (taskDesc) {
      html += `<div class="panel-task-section">
        <div class="panel-task-label">Delegated task</div>
        <div class="panel-task-text">${this.esc(taskDesc)}</div>
      </div>`;
    }

    // Tools bar chart
    html += this.accordion('Tools', tools.length, () => {
      if (!tools.length) return '<div class="empty-section">No tools used</div>';
      const total = tools.reduce((s, t) => s + t[1], 0);
      return `<div class="tools-bar-chart">${tools.map(([name, count]) => {
        const pct = (count / total) * 100;
        return `<div class="tools-bar-row">
          <span class="tools-bar-name" title="${this.esc(name)}">${this.esc(name)}</span>
          <div class="tools-bar-track"><div class="tools-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="tools-bar-count">${count}</span>
        </div>`;
      }).join('')}</div>`;
    }, true);

    // Interactions
    html += this.accordion('Interactions', interactionMap.size, () => {
      if (!interactionMap.size) return '<div class="empty-section">No interactions</div>';
      let items = '';
      for (const [agentId, counts] of interactionMap) {
        const name = this.nameOf[agentId] || agentId;
        items += `<div class="interaction-item">
          <span class="interaction-dot" style="background:${this.agentColors[agentId] || '#8b949e'}"></span>
          <span class="interaction-name">${this.esc(name)}</span>
          <span class="interaction-count">${counts.received} in / ${counts.sent} out</span>
        </div>`;
      }
      return items;
    }, true);

    // Received
    html += this.accordion('Received', received.length, () => {
      if (!received.length) return '<div class="empty-section">No messages received</div>';
      return received.map(c => {
        const fromId = this.lookup[c.from] || c.from;
        const fromName = this.nameOf[fromId] || this.nameOf[c.from] || c.from;
        const text = this.cleanPreview(this.commText(c.content));
        const preview = text ? text.substring(0, 150) : '';
        return `<div class="comm-item">
          <div class="comm-direction">from <span class="comm-agent" style="color:${this.agentColors[fromId] || '#8b949e'}">${this.esc(fromName)}</span><span class="comm-type-badge">${c.messageType}</span></div>
          ${preview ? `<div class="comm-preview">${this.esc(preview)}</div>` : ''}
        </div>`;
      }).join('');
    });

    // Sent
    html += this.accordion('Sent', sent.length, () => {
      if (!sent.length) return '<div class="empty-section">No messages sent</div>';
      return sent.map(c => {
        const toId = this.lookup[c.to] || c.to;
        const toName = this.nameOf[toId] || this.nameOf[c.to] || c.to;
        const text = this.cleanPreview(this.commText(c.content));
        const preview = text ? text.substring(0, 150) : '';
        return `<div class="comm-item">
          <div class="comm-direction">to <span class="comm-agent" style="color:${this.agentColors[toId] || '#8b949e'}">${this.esc(toName)}</span><span class="comm-type-badge">${c.messageType}</span></div>
          ${preview ? `<div class="comm-preview">${this.esc(preview)}</div>` : ''}
        </div>`;
      }).join('');
    });

    // Tasks
    if (agentTasks.length > 0) {
      html += this.accordion('Tasks', agentTasks.length, () => {
        return agentTasks.map(t => {
          const st = t.latestStatus || 'pending';
          const icons = { completed: '&#10003;', in_progress: '&#9673;', pending: '&#9675;' };
          return `<div class="task-item">
            <span class="task-status status-${st}">${icons[st] || icons.pending}</span>
            <span class="task-subject">${this.esc(t.subject || 'Unnamed')}</span>
          </div>`;
        }).join('');
      });
    }

    this.panelBody.innerHTML = html;
    this.panelBody.querySelectorAll('.accordion-header').forEach(h => {
      h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
    });
    this.panel.classList.add('open');
  }

  closePanel() {
    this.panel.classList.remove('open');
    if (this.selectedAgent) {
      this.container.querySelectorAll('.agent-card.selected, .tl-row.selected')
        .forEach(el => el.classList.remove('selected'));
      this.selectedAgent = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  accordion(title, count, contentFn, openByDefault = false) {
    const chevron = `<svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>`;
    return `<div class="accordion${openByDefault ? ' open' : ''}">
      <div class="accordion-header">${chevron}<span>${title}</span><span class="accordion-count">${count}</span></div>
      <div class="accordion-body">${contentFn()}</div>
    </div>`;
  }

  commText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    return content.text || content.detail || content.message || '';
  }

  cleanPreview(text) {
    if (!text) return '';
    return text
      .replace(/Async agent launched successfully,?\s*/gi, '')
      .replace(/agentId:\s*[a-f0-9]+\s*\(internal ID[^)]*\)/gi, '')
      .replace(/agentId:\s*[a-f0-9]+/gi, '')
      .replace(/\(internal ID[^)]*\)/gi, '')
      .replace(/^\s*[,.\s]+/, '')
      .trim();
  }

  renderSparkline(data) {
    const valid = data.filter(v => v != null);
    if (valid.length < 2) return '';
    const w = 160, h = 32, pad = 2;
    const min = Math.min(...valid, 0);
    const max = Math.max(...valid, 100);
    const range = max - min || 1;
    const points = [];
    let vi = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] == null) continue;
      const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((data[i] - min) / range) * (h - 2 * pad);
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const last = valid[valid.length - 1];
    const color = last >= 70 ? '#3fb950' : last >= 50 ? '#d29922' : '#f85149';
    // 70% threshold line
    const threshY = h - pad - ((70 - min) / range) * (h - 2 * pad);
    return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <line x1="${pad}" y1="${threshY.toFixed(1)}" x2="${w-pad}" y2="${threshY.toFixed(1)}" stroke="#3fb950" stroke-opacity="0.25" stroke-dasharray="3,3"/>
      <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points.join(' ')}"/>
      <circle cx="${points[points.length-1].split(',')[0]}" cy="${points[points.length-1].split(',')[1]}" r="2.5" fill="${color}"/>
    </svg>`;
  }

  agentTypeBadgeClass(type) {
    if (!type) return 'badge-unknown';
    const t = type.toLowerCase();
    // Implementation agents (can write code)
    if (['backend-developer', 'frontend-developer', 'fullstack-developer', 'backend-architect', 'mobile-developer', 'ios-developer', 'mobile-app-developer', 'devops-engineer', 'electron-pro'].includes(t)) return 'badge-impl';
    // Read-only agents
    if (['explore', 'code-explorer', 'plan', 'code-architect'].includes(t)) return 'badge-readonly';
    // Test/validation agents
    if (['test-runner', 'test-generator'].includes(t)) return 'badge-test';
    // General/default
    if (['general', 'general-purpose'].includes(t)) return 'badge-general';
    return 'badge-other';
  }

  esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  formatDuration(ms) {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  }

  formatTokenCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }
}

new TeamsDashboardApp();
