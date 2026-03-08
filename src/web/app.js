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
      this.renderNav();
      if (sessions.length > 0) this.loadSession(sessions[0].id);
    } catch (e) {
      this.container.innerHTML = '<div class="empty-state">Failed to load sessions</div>';
    }
  }

  renderNav() {
    if (!this.sessions.length) {
      this.nav.innerHTML = '<span class="no-sessions">No team sessions found</span>';
      return;
    }
    this.nav.innerHTML = this.sessions.map((s, i) => {
      const date = new Date(s.startTime);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const dur = s.duration ? this.formatDuration(s.duration) : '';
      const project = s.shortProjectName || '';
      const desc = s.sessionDescription || '';
      const truncDesc = desc.length > 50 ? desc.substring(0, 50) + '...' : desc;
      return `<button class="session-card${i === 0 ? ' active' : ''}" data-id="${s.id}">
        <span class="session-card-header">
          <span class="session-card-project">${this.esc(project)}</span>
          <span class="session-card-agents">${s.agentCount} agents</span>
        </span>
        ${truncDesc ? `<span class="session-card-desc">${this.esc(truncDesc)}</span>` : ''}
        <span class="session-card-detail">${dateStr} ${timeStr}${dur ? ' &middot; ' + dur : ''}</span>
      </button>`;
    }).join('');
    this.nav.addEventListener('click', e => {
      const btn = e.target.closest('.session-card');
      if (!btn) return;
      this.nav.querySelectorAll('.session-card').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.closePanel();
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

    // 3. Timeline
    const timelineSection = document.createElement('div');
    timelineSection.innerHTML = `<div class="section-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      Timeline
    </div>`;
    timelineSection.appendChild(this.renderTimeline(agents, agentList, communications));
    wrapper.appendChild(timelineSection);

    // 4. Agent cards
    const agentsSection = document.createElement('div');
    agentsSection.innerHTML = `<div class="section-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Agents (${agentList.length})
    </div>`;
    agentsSection.appendChild(this.renderAgentGrid(agents, agentList, communications));
    wrapper.appendChild(agentsSection);

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
    el.innerHTML = `
      <div class="session-banner-desc" title="${this.esc(desc)}">${this.esc(desc)}</div>
      <div class="session-banner-meta">
        ${dateStr ? `<span>${dateStr}</span>` : ''}
        ${this.data.gitBranch ? `<span>&#9678; ${this.esc(this.data.gitBranch)}</span>` : ''}
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

    const el = document.createElement('div');
    el.className = 'stats-bar';
    el.innerHTML = `
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
      <div class="stat-card stat-card-wide" style="--stat-accent: var(--accent)">
        <div class="stat-label" style="margin-bottom:6px">Top tools</div>
        <div class="stat-tools">${topTools.map(([n, c]) =>
          `<span class="tool-badge">${this.esc(n)} <strong>${c}</strong></span>`
        ).join('')}</div>
      </div>
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
      if (truncTask) html += `<span class="tl-task" title="${this.esc(task)}">${this.esc(truncTask)}</span>`;
      html += `</div></div>`;

      // Chart column with bar
      html += `<div class="tl-chart-col">`;
      for (const mark of timeMarks) {
        const pct = ((mark.time - sessionStart) / totalMs) * 100;
        html += `<div class="timeline-gridline" style="left:${pct}%"></div>`;
      }
      html += `<div class="timeline-bar" style="left:${leftPct}%;width:${widthPct}%;background:${row.color}" title="${this.esc(displayName)}: ${dur}"></div>`;
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

      // Mini tool bar — top 3 tools as proportional bar
      const top3 = tools.slice(0, 3);
      const barTotal = top3.reduce((s, t) => s + t[1], 0);
      const miniBar = top3.map(([n, c], i) => {
        const pct = (c / Math.max(barTotal, 1)) * 100;
        const barColor = ['#58a6ff', '#3fb950', '#bc8cff'][i] || '#8b949e';
        return `<div class="mini-bar-seg" style="width:${pct}%;background:${barColor}" title="${n}: ${c}"></div>`;
      }).join('');

      const card = document.createElement('div');
      card.className = 'agent-card';
      card.style.setProperty('--card-accent', color);
      card.dataset.agentId = id;
      card.innerHTML = `
        <div class="agent-card-header">
          <span class="agent-card-dot" style="background:${color}"></span>
          <span class="agent-card-name" title="${this.esc(a.name || id)}">${this.esc(a.name || id)}</span>
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
        </div>
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

    this.panelTitle.textContent = nid === 'lead' ? 'Lead (Orchestrator)' : agent.name;
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
}

new TeamsDashboardApp();
