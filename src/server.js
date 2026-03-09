const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const open = require('open');
const os = require('os');
const readline = require('readline');

class AgentDashboard {
  constructor(options = {}) {
    this.options = options;
    this.app = express();
    this.port = options.port || 3338;
    this.httpServer = null;
    this.homeDir = os.homedir();
    this.claudeDir = path.join(this.homeDir, '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
    this.sessionCache = new Map();
  }

  async initialize() {
    if (!(await fs.pathExists(this.projectsDir))) {
      throw new Error(
        `Claude Code projects directory not found at ${this.projectsDir}\n` +
        'Make sure you have Claude Code installed and have run at least one session.'
      );
    }

    this.sessions = await this.discoverAllSessions();
    this.setupWebServer();
  }

  async discoverAllSessions() {
    const sessions = [];

    try {
      const projectDirs = await fs.readdir(this.projectsDir);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(this.projectsDir, projectDir);
        const stat = await fs.stat(projectPath);
        if (!stat.isDirectory()) continue;

        const entries = await fs.readdir(projectPath);

        for (const entry of entries) {
          const entryPath = path.join(projectPath, entry);
          const entryStat = await fs.stat(entryPath);
          if (!entryStat.isDirectory()) continue;

          const subagentsDir = path.join(entryPath, 'subagents');
          const hasSubagentsDir = await fs.pathExists(subagentsDir);

          let agentFiles = [];
          if (hasSubagentsDir) {
            agentFiles = (await fs.readdir(subagentsDir))
              .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl')
                && !f.includes('acompact-'));
          }

          // Skip truly empty session directories (no lead file and no agent files)
          const leadFile = entryPath + '.jsonl';
          const leadExists = await fs.pathExists(leadFile);
          if (!leadExists && agentFiles.length === 0) continue;

          const isTeam = leadExists ? await this.detectTeamProtocol(leadFile) : false;

          let sessionType;
          if (isTeam || agentFiles.length >= 2) {
            sessionType = 'multi-agent';
          } else if (agentFiles.length === 1) {
            sessionType = 'single-agent';
          } else {
            sessionType = 'solo';
          }

          const metadata = await this.readSessionMetadata(entryPath, subagentsDir, agentFiles);

          sessions.push({
            id: entry,
            projectDir,
            projectName: this.decodeProjectDir(projectDir),
            path: entryPath,
            subagentsDir,
            agentFiles,
            agentCount: agentFiles.length,
            sessionType,
            ...metadata
          });
        }
      }
    } catch (error) {
      console.warn(chalk.yellow('Warning: Error discovering sessions'), error.message);
    }

    sessions.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
    return sessions;
  }

  decodeProjectDir(encoded) {
    return encoded.replace(/^-/, '/').replace(/-/g, '/');
  }

  shortProjectName(fullPath) {
    let clean = fullPath
      .replace(/^\/Users\/[^/]+\/Google\/Drive\/(?:xCode\/Apps\/)?/, '')
      .replace(/^\/Users\/[^/]+\/(?:Projects|Documents|Desktop)\//, '')
      .replace(/^\/Users\/[^/]+\//, '');

    if (!clean || clean === fullPath) {
      const parts = fullPath.split('/').filter(Boolean);
      return parts[parts.length - 1] || fullPath;
    }

    const segments = clean.split('/').filter(Boolean);
    if (segments.length <= 2) return segments.join('/');

    const skip = new Set(['done', 'v1', 'v2', 'v3', 'almost', 'for', 'Work']);
    const meaningful = segments.filter(s => !skip.has(s));
    if (meaningful.length <= 2) return meaningful.join('/');
    return meaningful.slice(-2).join('/');
  }

  async detectTeamProtocol(leadFilePath) {
    if (!(await fs.pathExists(leadFilePath))) return false;

    try {
      // Only read first 50 lines instead of entire file — team protocol markers appear early
      const lines = await this.readFirstNLines(leadFilePath, 50);
      const sample = lines.join('\n');
      return sample.includes('"TeamCreate"') || sample.includes('"SendMessage"');
    } catch (e) {
      return false;
    }
  }

  async readSessionMetadata(sessionPath, subagentsDir, agentFiles) {
    let startTime = null;
    let endTime = null;
    let leadAgentId = null;
    let gitBranch = null;
    let teammateNames = new Map();

    const leadFile = sessionPath + '.jsonl';
    if (await fs.pathExists(leadFile)) {
      try {
        const firstLines = await this.readFirstNLines(leadFile, 5);
        for (const line of firstLines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.timestamp && (parsed.type === 'user' || parsed.type === 'assistant')) {
              if (!startTime) startTime = parsed.timestamp;
              if (!gitBranch) gitBranch = parsed.gitBranch;
              break;
            }
          } catch (e) { /* skip malformed */ }
        }
        const lastLine = await this.readLastLine(leadFile);
        if (lastLine) {
          const parsed = JSON.parse(lastLine);
          if (parsed.timestamp && (!endTime || new Date(parsed.timestamp) > new Date(endTime))) {
            endTime = parsed.timestamp;
          }
        }
      } catch (e) { /* skip */ }
    }

    for (const agentFile of agentFiles) {
      const filePath = path.join(subagentsDir, agentFile);
      try {
        const firstLine = await this.readFirstLine(filePath);
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          const agentId = parsed.agentId || agentFile.replace('agent-', '').replace('.jsonl', '');

          if (!leadAgentId) leadAgentId = agentId;

          const content = parsed.message?.content || '';
          const nameMatch = content.match(/teammate_id="([^"]+)"/);
          if (nameMatch) {
            teammateNames.set(agentId, nameMatch[1]);
          }

          if (!startTime || new Date(parsed.timestamp) < new Date(startTime)) {
            startTime = parsed.timestamp;
          }
        }

        const lastLine = await this.readLastLine(filePath);
        if (lastLine) {
          const parsed = JSON.parse(lastLine);
          if (!endTime || new Date(parsed.timestamp) > new Date(endTime)) {
            endTime = parsed.timestamp;
          }
        }
      } catch (e) { /* skip */ }
    }

    // Extract session description from first meaningful user message
    let sessionDescription = '';
    if (await fs.pathExists(leadFile)) {
      try {
        const descLines = await this.readFirstNLines(leadFile, 150);
        for (const line of descLines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'user') {
              const content = parsed.message?.content;
              let text = '';
              if (typeof content === 'string') text = content;
              else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) { text = block.text; break; }
                }
              }

              // Strip XML-style noise prefixes to find the actual user message
              text = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>\s*/g, '');
              text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
              text = text.replace(/<claude-mem[^>]*>[\s\S]*?<\/claude-mem[^>]*>\s*/g, '');
              text = text.replace(/<command-message[^>]*>[\s\S]*?<\/command-message[^>]*>\s*/g, '');
              text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g, '');
              text = text.replace(/<hook-[^>]*>[\s\S]*?<\/hook-[^>]*>\s*/g, '');
              text = text.replace(/<scheduled-task[^>]*>[\s\S]*?<\/scheduled-task[^>]*>\s*/g, '');
              // Strip self-closing or unclosed tags (e.g. <ide_opened_file>...no closing tag)
              text = text.replace(/<ide_opened_file>[^]*?(?=\n\n|$)/g, '');
              // Strip any remaining XML tags
              text = text.replace(/<\/?[a-z_-][^>]*>/gi, '');
              text = text.trim();

              // Skip if still just noise or too short
              if (text.length < 10) continue;
              if (text.startsWith('<')) continue;
              if (/^https?:\/\//.test(text) && text.length < 60) continue;
              // Skip claude-mem system prompts
              if (text.startsWith('You are a Claude-Mem')) continue;
              if (text.startsWith('You are a specialized')) continue;
              // Skip image-only messages (screenshots sent to Claude)
              if (text.startsWith('[Image:')) continue;
              // Skip observer tool-call log lines
              if (/^(Grep|Read|Glob|Agent|Edit|Write|Bash|Skill|ToolSearch)\s+\d{4}-/.test(text)) continue;
              // Skip skill invocation metadata
              if (text.startsWith('Base directory for this skill:')) continue;
              // Skip claude-mem progress checkpoints
              if (text.startsWith('PROGRESS SUMMARY CHECKPOINT')) continue;
              // Skip interrupted/system messages
              if (text.startsWith('[Request interrupted')) continue;
              // Skip agent completion notifications
              if (/^[a-f0-9]{10,}\s+toolu_/.test(text)) continue;
              // Skip slash-command-only messages (no context)
              if (/^\/[a-z-]+$/.test(text.trim())) continue;
              // Skip Hello/greeting to memory agent
              if (/^Hello memory agent/.test(text)) continue;

              // Clean up for display
              text = text.replace(/\s+/g, ' ').trim();
              sessionDescription = text.substring(0, 150).trim();
              // Don't cut mid-word
              if (sessionDescription.length >= 148) {
                const lastSpace = sessionDescription.lastIndexOf(' ');
                if (lastSpace > 100) sessionDescription = sessionDescription.substring(0, lastSpace);
              }
              break;
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }
    }

    // Fallback: if no description found, build one from agent names
    if (!sessionDescription && agentFiles.length > 0) {
      const agentNames = [];
      for (const af of agentFiles.slice(0, 4)) {
        try {
          const agentPath = path.join(subagentsDir, af);
          const agentLines = await this.readFirstNLines(agentPath, 10);
          for (const al of agentLines) {
            try {
              const ap = JSON.parse(al);
              if (ap.type === 'system' && ap.message?.content) {
                const sysText = typeof ap.message.content === 'string' ? ap.message.content : '';
                // Look for agent name/description in system prompt
                const nameMatch = sysText.match(/(?:You are|Task:|GOAL:?|Description:?)\s*(.{10,80}?)(?:\.|\n|$)/i);
                if (nameMatch) {
                  agentNames.push(nameMatch[1].trim());
                  break;
                }
              }
              // Also check if the first user message has a task description
              if (ap.type === 'user' && ap.message?.content) {
                let ut = typeof ap.message.content === 'string' ? ap.message.content : '';
                if (Array.isArray(ap.message.content)) {
                  for (const b of ap.message.content) {
                    if (b.type === 'text' && b.text) { ut = b.text; break; }
                  }
                }
                ut = ut.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]+>/g, '').trim();
                if (ut.length > 15 && !ut.startsWith('[Image:') && !ut.startsWith('You are')) {
                  // Use first line as task summary
                  const firstLine = ut.split('\n')[0].substring(0, 80).trim();
                  if (firstLine.length > 15) {
                    agentNames.push(firstLine);
                    break;
                  }
                }
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* skip */ }
      }
      if (agentNames.length > 0) {
        sessionDescription = agentNames[0];
        if (sessionDescription.length > 150) {
          sessionDescription = sessionDescription.substring(0, 147) + '...';
        }
      }
    }

    return {
      startTime,
      endTime,
      gitBranch,
      leadAgentId,
      sessionDescription,
      teammateNames: Object.fromEntries(teammateNames),
      duration: startTime && endTime
        ? new Date(endTime) - new Date(startTime)
        : null
    };
  }

  async readFirstLine(filePath) {
    const lines = await this.readFirstNLines(filePath, 1);
    return lines.length > 0 ? lines[0] : null;
  }

  async readFirstNLines(filePath, n) {
    return new Promise((resolve) => {
      const lines = [];
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        lines.push(line.trim());
        if (lines.length >= n) {
          rl.close();
          stream.destroy();
          resolve(lines);
        }
      });
      rl.on('close', () => resolve(lines));
      rl.on('error', () => resolve(lines));
    });
  }

  async readLastLine(filePath) {
    try {
      const stats = await fs.stat(filePath);
      const bufferSize = Math.min(8192, stats.size);
      if (bufferSize === 0) return null;

      const nativeFs = require('fs');
      const fd = nativeFs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(bufferSize);
      nativeFs.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
      nativeFs.closeSync(fd);

      const content = buffer.toString('utf8');
      const lines = content.split('\n').filter(l => l.trim());
      return lines.length > 0 ? lines[lines.length - 1].trim() : null;
    } catch (e) {
      return null;
    }
  }

  async parseFullSession(sessionId) {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return null;

    // Check cache validity: compare file modification times
    if (this.sessionCache.has(sessionId)) {
      const cached = this.sessionCache.get(sessionId);
      const staleCheck = await this.isSessionStale(session, cached._cachedAt);
      if (!staleCheck) {
        return cached;
      }
    }

    const events = [];
    const agents = new Map();
    const teammateNames = new Map();

    // Parse lead session
    const leadFile = session.path + '.jsonl';
    if (await fs.pathExists(leadFile)) {
      const leadEvents = await this.parseJSONLFile(leadFile, 'lead');
      events.push(...leadEvents);

      for (const event of leadEvents) {
        this.extractTeammateInfo(event, teammateNames);
      }

      const leadStart = leadEvents.length > 0 ? leadEvents[0].timestamp : null;
      const leadEnd = leadEvents.length > 0 ? leadEvents[leadEvents.length - 1].timestamp : null;
      agents.set('lead', {
        id: 'lead',
        name: 'Lead',
        eventCount: leadEvents.length,
        startTime: leadStart,
        endTime: leadEnd,
        toolsUsed: this.countToolsUsed(leadEvents),
        messageCount: leadEvents.filter(e => e.type === 'assistant' && e.hasText).length,
        isLead: true
      });
    }

    // Parse each agent file
    const agentEventMap = new Map();
    for (const agentFile of session.agentFiles) {
      const filePath = path.join(session.subagentsDir, agentFile);
      const agentId = agentFile.replace('agent-', '').replace('.jsonl', '');
      const agentEvents = await this.parseJSONLFile(filePath, agentId);
      events.push(...agentEvents);
      agentEventMap.set(agentId, agentEvents);
    }

    // Resolve agent names and types
    const { nameMap, typeMap } = this.resolveAgentNames(events, agentEventMap);

    // Read .meta.json files for agent types not resolved from tool calls
    for (const agentFile of session.agentFiles) {
      const agentId = agentFile.replace('agent-', '').replace('.jsonl', '');
      if (!typeMap.has(agentId)) {
        const metaPath = path.join(session.subagentsDir, agentFile.replace('.jsonl', '.meta.json'));
        try {
          if (await fs.pathExists(metaPath)) {
            const meta = await fs.readJson(metaPath);
            if (meta.agentType) typeMap.set(agentId, meta.agentType);
          }
        } catch (e) { /* skip */ }
      }
    }

    // Build agent info
    for (const [agentId, agentEvents] of agentEventMap) {
      const agentStart = agentEvents.length > 0 ? agentEvents[0].timestamp : null;
      const agentEnd = agentEvents.length > 0 ? agentEvents[agentEvents.length - 1].timestamp : null;
      const resolvedName = nameMap.get(agentId);

      let spawnedBy = resolvedName ? 'Lead' : null;
      let taskSubject = null;
      if (!resolvedName) {
        for (const evt of agentEvents) {
          if (evt.type === 'user' && evt.textContent) {
            const trimmed = evt.textContent.trim();
            if (trimmed.startsWith('<teammate-message')) {
              const m = trimmed.match(/<teammate-message\s+teammate_id="([^"]+)"/);
              if (m) { spawnedBy = m[1]; }
              const subjectMatch = trimmed.match(/"subject"\s*:\s*"([^"]+)"/);
              if (subjectMatch) { taskSubject = subjectMatch[1]; }
              if (spawnedBy) break;
            }
          }
        }
      }

      if (!resolvedName && !spawnedBy) {
        const agentStartTs = agentEvents.length > 0 ? new Date(agentEvents[0].timestamp).getTime() : 0;
        for (const event of events.filter(e => e.agentId === 'lead')) {
          for (const tool of event.toolUse || []) {
            if (tool.name === 'Task' && !tool.input?.name) {
              const spawnTs = new Date(event.timestamp).getTime();
              if (Math.abs(agentStartTs - spawnTs) < 5000) {
                spawnedBy = 'Lead';
                break;
              }
            }
          }
          if (spawnedBy) break;
        }
      }

      // Extract task name from first user message if no name resolved
      let inferredName = null;
      if (!resolvedName && !taskSubject) {
        for (const evt of agentEvents) {
          if (evt.type === 'user' && evt.textContent) {
            const text = evt.textContent.trim();
            if (text.startsWith('<teammate-message') || text.startsWith('<system') || text.startsWith('<hook')) continue;
            // Extract first meaningful line as task name (strip markdown headers)
            const firstLine = text.split('\n').find(l => l.trim().length > 5) || '';
            inferredName = firstLine.replace(/^#+\s*/, '').replace(/^(Task|Goal|Objective):\s*/i, '').substring(0, 60).trim();
            if (inferredName.length > 50) inferredName = inferredName.substring(0, 48) + '..';
            break;
          }
        }
      }

      agents.set(agentId, {
        id: agentId,
        name: resolvedName || taskSubject || inferredName || (spawnedBy ? `${spawnedBy}/${agentId.substring(0, 4)}` : agentId.substring(0, 7)),
        subagentType: typeMap.get(agentId) || null,
        eventCount: agentEvents.length,
        startTime: agentStart,
        endTime: agentEnd,
        toolsUsed: this.countToolsUsed(agentEvents),
        messageCount: agentEvents.filter(e => e.type === 'assistant' && e.hasText).length,
        spawnedBy
      });
    }

    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const result = {
      id: session.id,
      projectName: session.projectName,
      gitBranch: session.gitBranch,
      startTime: session.startTime,
      endTime: session.endTime,
      duration: session.duration,
      agents: Object.fromEntries(agents),
      teammateNames: Object.fromEntries(teammateNames),
      events,
      communications: this.extractCommunications(events),
      tasks: this.extractTasks(events),
      stats: this.calculateSessionStats(events, agents)
    };

    result._cachedAt = Date.now();
    this.sessionCache.set(sessionId, result);
    return result;
  }

  async isSessionStale(session, cachedAt) {
    if (!cachedAt) return true;

    // Always re-parse if cached less than 10 seconds ago and session is recent
    const sessionAge = Date.now() - new Date(session.endTime || session.startTime).getTime();
    if (sessionAge < 300000) return true; // Sessions < 5 min old are always re-parsed

    try {
      // Check if lead file was modified after cache
      const leadFile = session.path + '.jsonl';
      if (await fs.pathExists(leadFile)) {
        const stat = await fs.stat(leadFile);
        if (stat.mtimeMs > cachedAt) return true;
      }

      // Check if any agent file was modified after cache
      for (const agentFile of session.agentFiles) {
        const filePath = path.join(session.subagentsDir, agentFile);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs > cachedAt) return true;
      }

      return false;
    } catch (e) {
      return true; // On error, assume stale
    }
  }

  resolveAgentNames(allEvents, agentEventMap) {
    const nameMap = new Map();

    const spawns = [];
    for (const event of allEvents) {
      for (const tool of event.toolUse || []) {
        if (tool.name === 'Task' && tool.input?.name) {
          spawns.push({ name: tool.input.name, timestamp: new Date(event.timestamp).getTime() });
        }
      }
    }
    spawns.sort((a, b) => a.timestamp - b.timestamp);

    const agentStarts = [];
    for (const [agentId, events] of agentEventMap) {
      if (events.length > 0) {
        agentStarts.push({ id: agentId, timestamp: new Date(events[0].timestamp).getTime() });
      }
    }
    agentStarts.sort((a, b) => a.timestamp - b.timestamp);

    const usedAgents = new Set();
    for (const spawn of spawns) {
      let bestId = null, bestDiff = Infinity;
      for (const agent of agentStarts) {
        if (usedAgents.has(agent.id)) continue;
        const diff = agent.timestamp - spawn.timestamp;
        if (diff >= -2000 && diff < bestDiff && diff < 120000) {
          bestDiff = diff;
          bestId = agent.id;
        }
      }
      if (bestId) {
        nameMap.set(bestId, spawn.name);
        usedAgents.add(bestId);
      }
    }

    // Also resolve from Agent tool calls (subagent spawning pattern)
    const agentToolCalls = new Map();
    for (const event of allEvents.filter(e => e.agentId === 'lead')) {
      for (const tool of event.toolUse || []) {
        if (tool.name === 'Agent' && tool.input) {
          agentToolCalls.set(tool.id, {
            description: tool.input.description || '',
            subagentType: tool.input.subagent_type || 'general',
            timestamp: event.timestamp
          });
        }
      }
      for (const result of event.toolResults || []) {
        const callInfo = agentToolCalls.get(result.tool_use_id);
        if (callInfo) {
          const agentId = result.agentId || ((result.content || '').match(/agentId:\s*([a-f0-9]+)/) || [])[1];
          if (agentId) {
            if (!nameMap.has(agentId)) {
              const typeName = callInfo.subagentType !== 'general' ? callInfo.subagentType : '';
              const desc = callInfo.description || typeName || 'worker';
              nameMap.set(agentId, desc);
            }
            callInfo.resolvedAgentId = agentId;
          }
        }
      }
    }

    // Build a type map from agentToolCalls
    const typeMap = new Map();
    for (const [, callInfo] of agentToolCalls) {
      if (callInfo.resolvedAgentId && callInfo.subagentType) {
        typeMap.set(callInfo.resolvedAgentId, callInfo.subagentType);
      }
    }

    return { nameMap, typeMap };
  }

  async parseJSONLFile(filePath, agentId) {
    const events = [];
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          if (parsed.type === 'file-history-snapshot') continue;

          const msg = parsed.message || {};
          const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
          const textContent = typeof msg.content === 'string'
            ? msg.content
            : contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n');

          const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');
          const toolResultBlocks = contentBlocks.filter(b => b.type === 'tool_result');

          // Capture token usage from assistant messages
          const usage = (parsed.type === 'assistant' && msg.usage) ? {
            input: msg.usage.input_tokens || 0,
            output: msg.usage.output_tokens || 0,
            cacheRead: msg.usage.cache_read_input_tokens || 0,
            cacheWrite: msg.usage.cache_creation_input_tokens || 0,
            cacheWrite5m: msg.usage.cache_creation?.ephemeral_5m_input_tokens || 0,
            cacheWrite1h: msg.usage.cache_creation?.ephemeral_1h_input_tokens || 0,
          } : null;

          events.push({
            agentId: parsed.agentId || agentId,
            type: parsed.type,
            role: msg.role,
            timestamp: parsed.timestamp,
            textContent: textContent.substring(0, 2000),
            hasText: textContent.length > 0,
            usage,
            toolUse: toolUseBlocks.map(t => ({
              name: t.name,
              id: t.id,
              input: t.input
            })),
            toolResults: toolResultBlocks.map(t => {
              let resultContent = '';
              let agentIdMeta = null;
              if (typeof t.content === 'string') {
                resultContent = t.content;
              } else if (Array.isArray(t.content)) {
                const texts = t.content.filter(b => b.type === 'text').map(b => b.text);
                resultContent = texts.join('\n');
                for (const text of texts) {
                  const m = text.match(/agentId:\s*([a-f0-9]+)/);
                  if (m) { agentIdMeta = m[1]; break; }
                }
              } else {
                resultContent = JSON.stringify(t.content);
              }
              if (!agentIdMeta) {
                const m = resultContent.match(/agentId:\s*([a-f0-9]+)/);
                if (m) agentIdMeta = m[1];
              }
              return {
                tool_use_id: t.tool_use_id,
                content: resultContent.substring(0, 2000),
                agentId: agentIdMeta,
                isError: !!t.is_error
              };
            }),
            model: msg.model,
            isSidechain: parsed.isSidechain
          });
        } catch (e) { /* skip malformed lines */ }
      }
    } catch (e) { /* skip unreadable files */ }

    return events;
  }

  extractTeammateInfo(event, teammateNames) {
    const text = event.textContent || '';
    const matches = text.matchAll(/teammate_id="([^"]+)"/g);
    for (const match of matches) {
      const name = match[1];
      if (!teammateNames.has(name)) {
        // Store for display
      }
    }

    for (const tool of event.toolUse || []) {
      if (tool.name === 'SendMessage' && tool.input) {
        if (tool.input.recipient) {
          // recipient is a name
        }
      }
      if (tool.name === 'Task' && tool.input?.name) {
        // Task tool spawning a named teammate
      }
    }
  }

  extractCommunications(events) {
    const communications = [];

    for (const event of events) {
      if (event.type === 'user' && event.textContent && event.textContent.trim().startsWith('<teammate-message')) {
        const match = event.textContent.match(/<teammate-message\s+teammate_id="([^"]+)"(?:\s+color="([^"]*)")?>\n?([\s\S]*?)\n?<\/teammate-message>/);
        if (match) {
          let messageContent = match[3];
          let parsedContent = null;

          try {
            parsedContent = JSON.parse(messageContent);
          } catch (e) {
            parsedContent = { text: messageContent };
          }

          communications.push({
            timestamp: event.timestamp,
            from: match[1],
            to: event.agentId,
            color: match[2] || null,
            content: parsedContent,
            messageType: parsedContent?.type || 'message',
            raw: messageContent.substring(0, 1000)
          });
        }
      }

      for (const tool of event.toolUse || []) {
        if (tool.name === 'SendMessage' && tool.input) {
          communications.push({
            timestamp: event.timestamp,
            from: event.agentId,
            to: tool.input.recipient || 'unknown',
            content: {
              type: tool.input.type || 'message',
              text: tool.input.content || '',
              summary: tool.input.summary || ''
            },
            messageType: tool.input.type || 'message',
            raw: (tool.input.content || '').substring(0, 1000)
          });
        }
      }
    }

    // Extract subagent delegations as communications
    const agentCalls = new Map();
    for (const event of events) {
      if (event.agentId !== 'lead') continue;
      for (const tool of event.toolUse || []) {
        if (tool.name === 'Agent' && tool.input) {
          agentCalls.set(tool.id, {
            timestamp: event.timestamp,
            description: tool.input.description || '',
            subagentType: tool.input.subagent_type || 'general',
            prompt: (tool.input.prompt || '').substring(0, 300),
          });
        }
      }
      for (const result of event.toolResults || []) {
        const callInfo = agentCalls.get(result.tool_use_id);
        if (callInfo) {
          const agentId = result.agentId || ((result.content || '').match(/agentId:\s*([a-f0-9]+)/) || [])[1];
          if (agentId) {
            communications.push({
              timestamp: callInfo.timestamp,
              from: 'lead',
              to: agentId,
              content: { type: 'delegation', text: callInfo.description, detail: callInfo.prompt },
              messageType: 'delegation',
              raw: callInfo.prompt
            });
            const resultText = (result.content || '').substring(0, 500);
            communications.push({
              timestamp: event.timestamp,
              from: agentId,
              to: 'lead',
              content: { type: 'result', text: resultText },
              messageType: 'result',
              raw: resultText
            });
          }
        }
      }
    }

    communications.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return communications;
  }

  extractTasks(events) {
    const tasks = [];

    for (const event of events) {
      for (const tool of event.toolUse || []) {
        if (tool.name === 'TaskCreate' && tool.input) {
          tasks.push({
            id: null,
            subject: tool.input.subject,
            description: tool.input.description,
            activeForm: tool.input.activeForm,
            createdBy: event.agentId,
            createdAt: event.timestamp,
            updates: []
          });
        }

        if (tool.name === 'TaskUpdate' && tool.input) {
          const update = {
            taskId: tool.input.taskId,
            status: tool.input.status,
            owner: tool.input.owner,
            updatedBy: event.agentId,
            updatedAt: event.timestamp,
            subject: tool.input.subject
          };

          const existingTask = tasks.find(t =>
            t.id === tool.input.taskId ||
            (!t.id && tasks.indexOf(t).toString() === tool.input.taskId)
          );

          if (existingTask) {
            existingTask.updates.push(update);
            if (tool.input.status) existingTask.latestStatus = tool.input.status;
            if (tool.input.owner) existingTask.owner = tool.input.owner;
          } else {
            tasks.push({
              id: tool.input.taskId,
              subject: tool.input.subject || `Task #${tool.input.taskId}`,
              createdBy: 'unknown',
              createdAt: event.timestamp,
              latestStatus: tool.input.status,
              owner: tool.input.owner,
              updates: [update]
            });
          }
        }
      }
    }

    return tasks;
  }

  countToolsUsed(events) {
    const toolCounts = {};
    for (const event of events) {
      for (const tool of event.toolUse || []) {
        toolCounts[tool.name] = (toolCounts[tool.name] || 0) + 1;
      }
    }
    return toolCounts;
  }

  calculateSessionStats(events, agents) {
    const totalEvents = events.length;
    const userEvents = events.filter(e => e.type === 'user').length;
    const assistantEvents = events.filter(e => e.type === 'assistant').length;
    const toolUsages = events.reduce((sum, e) => sum + (e.toolUse?.length || 0), 0);

    const toolBreakdown = {};
    for (const event of events) {
      for (const tool of event.toolUse || []) {
        toolBreakdown[tool.name] = (toolBreakdown[tool.name] || 0) + 1;
      }
    }

    // Efficiency metrics
    const lead = agents.get('lead');
    const leadTools = lead ? Object.values(lead.toolsUsed || {}).reduce((s, v) => s + v, 0) : 0;
    const subagentTools = toolUsages - leadTools;
    const efficiencyScore = toolUsages > 0 ? Math.round((subagentTools / toolUsages) * 100) : 0;

    // Lead timeline phases
    let leadPlanningEnd = null;   // When first agent starts
    let leadWaitingEnd = null;    // When last agent ends
    const leadStart = lead?.startTime ? new Date(lead.startTime).getTime() : null;
    const leadEnd = lead?.endTime ? new Date(lead.endTime).getTime() : null;

    for (const [id, agent] of agents) {
      if (id === 'lead') continue;
      const aStart = agent.startTime ? new Date(agent.startTime).getTime() : null;
      const aEnd = agent.endTime ? new Date(agent.endTime).getTime() : null;
      if (aStart && (!leadPlanningEnd || aStart < leadPlanningEnd)) leadPlanningEnd = aStart;
      if (aEnd && (!leadWaitingEnd || aEnd > leadWaitingEnd)) leadWaitingEnd = aEnd;
    }

    const leadPhases = {};
    if (leadStart && leadEnd) {
      const total = leadEnd - leadStart;
      leadPhases.planning = leadPlanningEnd ? Math.max(0, leadPlanningEnd - leadStart) : 0;
      leadPhases.waiting = (leadPlanningEnd && leadWaitingEnd) ? Math.max(0, leadWaitingEnd - leadPlanningEnd) : 0;
      leadPhases.postAgent = leadWaitingEnd ? Math.max(0, leadEnd - leadWaitingEnd) : 0;
      leadPhases.planningPct = total > 0 ? (leadPhases.planning / total) * 100 : 0;
      leadPhases.waitingPct = total > 0 ? (leadPhases.waiting / total) * 100 : 0;
      leadPhases.postAgentPct = total > 0 ? (leadPhases.postAgent / total) * 100 : 0;
    }

    // Per-agent read/write ratios
    const agentRatios = {};
    for (const [id, agent] of agents) {
      const used = agent.toolsUsed || {};
      const total = Object.values(used).reduce((s, v) => s + v, 0);
      const writes = (used.Edit || 0) + (used.Write || 0);
      const reads = (used.Read || 0) + (used.Grep || 0) + (used.Glob || 0);
      agentRatios[id] = {
        total,
        writes,
        reads,
        writePct: total > 0 ? Math.round((writes / total) * 100) : 0,
        readPct: total > 0 ? Math.round((reads / total) * 100) : 0
      };
    }

    // Per-agent token usage (moved before new metrics so costPerAgent can reference it)
    const agentTokens = {};
    for (const [id] of agents) {
      const agentEvents = events.filter(e => e.agentId === id);
      let aInput = 0, aOutput = 0, aCacheRead = 0, aCacheWrite = 0;
      for (const event of agentEvents) {
        if (event.usage) {
          aInput += event.usage.input;
          aOutput += event.usage.output;
          aCacheRead += event.usage.cacheRead;
          aCacheWrite += event.usage.cacheWrite;
        }
      }
      const aTotal = aInput + aOutput + aCacheRead + aCacheWrite;
      if (aTotal > 0) {
        agentTokens[id] = { input: aInput, output: aOutput, cacheRead: aCacheRead, cacheWrite: aCacheWrite, total: aTotal };
      }
    }

    // GBP conversion rate used by multiple cost metrics below
    const GBP_RATE = 0.79;

    // 1. Parallelism Score
    const agentIntervals = [];
    for (const [id, agent] of agents) {
      if (id === 'lead') continue;
      const s = agent.startTime ? new Date(agent.startTime).getTime() : null;
      const e = agent.endTime ? new Date(agent.endTime).getTime() : null;
      if (s && e) agentIntervals.push({ start: s, end: e });
    }
    let parallelismScore = 0, peakConcurrency = 0;
    if (agentIntervals.length >= 2) {
      const minStart = Math.min(...agentIntervals.map(a => a.start));
      const maxEnd = Math.max(...agentIntervals.map(a => a.end));
      const step = Math.max(1000, Math.floor((maxEnd - minStart) / 500));
      let parallelSamples = 0, totalSamples = 0;
      for (let t = minStart; t <= maxEnd; t += step) {
        const active = agentIntervals.filter(a => t >= a.start && t <= a.end).length;
        if (active > 0) totalSamples++;
        if (active >= 2) parallelSamples++;
        if (active > peakConcurrency) peakConcurrency = active;
      }
      parallelismScore = totalSamples > 0 ? Math.round((parallelSamples / totalSamples) * 100) : 0;
    }
    const parallelism = { score: parallelismScore, peakConcurrency, agentCount: agentIntervals.length };

    // 2. Lead Post-Agent Tools
    const leadPostAgentTools = {};
    let leadPostAgentCalls = 0;
    if (leadWaitingEnd) {
      for (const event of events.filter(e => e.agentId === 'lead')) {
        const ts = new Date(event.timestamp).getTime();
        if (ts > leadWaitingEnd) {
          for (const tool of event.toolUse || []) {
            leadPostAgentTools[tool.name] = (leadPostAgentTools[tool.name] || 0) + 1;
            leadPostAgentCalls++;
          }
        }
      }
    }
    const leadPostAgent = { tools: leadPostAgentTools, totalCalls: leadPostAgentCalls };

    // 3. Agent Autonomy Score
    const agentAutonomy = {};
    const productiveTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    const investigationTools = new Set(['Read', 'Grep', 'Glob', 'LS']);
    for (const [id, agent] of agents) {
      const used = agent.toolsUsed || {};
      let productive = 0, investigation = 0, other = 0;
      for (const [name, count] of Object.entries(used)) {
        if (productiveTools.has(name)) productive += count;
        else if (investigationTools.has(name)) investigation += count;
        else other += count;
      }
      const total = productive + investigation + other;
      agentAutonomy[id] = {
        productive, investigation, other, total,
        score: total > 0 ? Math.round((productive / total) * 100) : 0
      };
    }

    // 4. Duplicate Work Detection + 12. File Heatmap
    const fileAccess = {};
    for (const event of events) {
      const agentId = event.agentId || 'lead';
      for (const tool of event.toolUse || []) {
        let filePath = null;
        let isWrite = false;
        if (tool.name === 'Read' && tool.input?.file_path) filePath = tool.input.file_path;
        else if (tool.name === 'Grep' && tool.input?.path) filePath = tool.input.path;
        else if (tool.name === 'Edit' && tool.input?.file_path) { filePath = tool.input.file_path; isWrite = true; }
        else if (tool.name === 'Write' && tool.input?.file_path) { filePath = tool.input.file_path; isWrite = true; }
        else if (tool.name === 'MultiEdit' && tool.input?.file_path) { filePath = tool.input.file_path; isWrite = true; }
        if (filePath) {
          if (!fileAccess[filePath]) fileAccess[filePath] = { agents: new Set(), count: 0, reads: 0, writes: 0 };
          fileAccess[filePath].agents.add(agentId);
          fileAccess[filePath].count++;
          if (isWrite) fileAccess[filePath].writes++; else fileAccess[filePath].reads++;
        }
      }
    }
    const duplicateFiles = Object.entries(fileAccess)
      .filter(([, v]) => v.agents.size >= 2)
      .map(([p, v]) => ({ path: p, agents: [...v.agents], count: v.count }))
      .sort((a, b) => b.agents.length - a.agents.length);
    const duplicateWork = { files: duplicateFiles.slice(0, 20), count: duplicateFiles.length };
    const fileHeatmap = Object.entries(fileAccess)
      .map(([p, v]) => ({ path: p, count: v.count, reads: v.reads, writes: v.writes, agents: [...v.agents] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    // 5. Cost Per Agent
    const costPerAgent = {};
    for (const [id, at] of Object.entries(agentTokens)) {
      const inCost = at.input * 5 / 1_000_000;
      const outCost = at.output * 25 / 1_000_000;
      const cacheCost = at.cacheRead * 0.50 / 1_000_000 + at.cacheWrite * 10 / 1_000_000;
      const totalUSD = inCost + outCost + cacheCost;
      const totalGBP = totalUSD * GBP_RATE;
      const agentInfo = agents.get(id);
      const totalAgentTools = agentInfo ? Object.values(agentInfo.toolsUsed || {}).reduce((s, v) => s + v, 0) : 0;
      const edits = agentInfo ? ((agentInfo.toolsUsed || {}).Edit || 0) + ((agentInfo.toolsUsed || {}).Write || 0) : 0;
      costPerAgent[id] = {
        costGBP: Math.round(totalGBP * 100) / 100,
        costUSD: Math.round(totalUSD * 100) / 100,
        costPerTool: totalAgentTools > 0 ? Math.round((totalGBP / totalAgentTools) * 100) / 100 : 0,
        costPerEdit: edits > 0 ? Math.round((totalGBP / edits) * 100) / 100 : 0
      };
    }

    // 7. Prompt Lengths
    const promptLengths = {};
    for (const event of events.filter(e => e.agentId === 'lead')) {
      for (const tool of event.toolUse || []) {
        if (tool.name === 'Agent' && tool.input?.prompt) {
          const prompt = tool.input.prompt;
          const desc = tool.input.description || '';
          promptLengths[tool.id] = { chars: prompt.length, words: prompt.split(/\s+/).length, description: desc };
        }
      }
    }

    // 8. Time to First Edit
    const timeToFirstEdit = {};
    for (const [id, agent] of agents) {
      if (id === 'lead') continue;
      const agentStart = agent.startTime ? new Date(agent.startTime).getTime() : null;
      if (!agentStart) continue;
      const agentEvts = events.filter(e => e.agentId === id);
      for (const evt of agentEvts) {
        for (const tool of evt.toolUse || []) {
          if (tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'MultiEdit') {
            timeToFirstEdit[id] = new Date(evt.timestamp).getTime() - agentStart;
            break;
          }
        }
        if (timeToFirstEdit[id] != null) break;
      }
      if (timeToFirstEdit[id] == null) timeToFirstEdit[id] = -1;
    }

    // 9. Error Count
    const errorCounts = { total: 0, byAgent: {} };
    for (const event of events) {
      const aid = event.agentId || 'lead';
      for (const result of event.toolResults || []) {
        if (result.isError || (result.content && /^(Error|error:|Exit code [1-9]|FAIL|Command failed)/m.test(result.content))) {
          errorCounts.total++;
          errorCounts.byAgent[aid] = (errorCounts.byAgent[aid] || 0) + 1;
        }
      }
    }

    // 10. Model Distribution
    const modelDistribution = {};
    for (const event of events) {
      if (event.model) {
        modelDistribution[event.model] = (modelDistribution[event.model] || 0) + 1;
      }
    }

    // 11. Cumulative Cost Chart
    const cumulativeCost = [];
    let runningCost = 0;
    const sortedUsageEvents = events.filter(e => e.usage).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    for (const event of sortedUsageEvents) {
      const u = event.usage;
      const cost = (u.input * 5 + u.output * 25 + u.cacheRead * 0.50 + u.cacheWrite * 10) / 1_000_000 * GBP_RATE;
      runningCost += cost;
      cumulativeCost.push({ timestamp: event.timestamp, costGBP: Math.round(runningCost * 100) / 100 });
    }
    const maxPoints = 50;
    const costChart = cumulativeCost.length <= maxPoints ? cumulativeCost :
      cumulativeCost.filter((_, i) => i % Math.ceil(cumulativeCost.length / maxPoints) === 0 || i === cumulativeCost.length - 1);

    // 13. Spawn Latency
    const spawnLatency = {};
    const agentToolTimestamps = new Map();
    for (const event of events.filter(e => e.agentId === 'lead')) {
      for (const tool of event.toolUse || []) {
        if (tool.name === 'Agent') {
          agentToolTimestamps.set(tool.id, new Date(event.timestamp).getTime());
        }
      }
      for (const result of event.toolResults || []) {
        const spawnTs = agentToolTimestamps.get(result.tool_use_id);
        if (spawnTs && result.agentId) {
          const agentFirst = events.find(e => e.agentId === result.agentId);
          if (agentFirst) {
            spawnLatency[result.agentId] = new Date(agentFirst.timestamp).getTime() - spawnTs;
          }
        }
      }
    }

    // 14. Session Tags
    const sessionTags = [];
    const allText = events.filter(e => e.type === 'user' && e.agentId === 'lead').map(e => e.textContent || '').join(' ').toLowerCase();
    if (/\b(fix|bug|broken|error|issue|crash)\b/.test(allText)) sessionTags.push('bug-fix');
    if (/\b(refactor|cleanup|clean up|reorganize|restructure)\b/.test(allText)) sessionTags.push('refactor');
    if (/\b(audit|review|analyze|check|inspect)\b/.test(allText)) sessionTags.push('audit');
    if (/\b(feature|implement|add|create|build|new)\b/.test(allText)) sessionTags.push('feature');
    if (/\b(test|spec|coverage)\b/.test(allText)) sessionTags.push('testing');
    if (/\b(deploy|ci|cd|pipeline|vercel|github action)\b/.test(allText)) sessionTags.push('devops');
    if (/\b(ui|design|style|css|layout|visual|theme)\b/.test(allText)) sessionTags.push('ui');
    if (/\b(performance|perf|speed|optimize|slow)\b/.test(allText)) sessionTags.push('performance');
    if (/\b(security|auth|rls|permission|vulnerability)\b/.test(allText)) sessionTags.push('security');
    if (/\b(migration|migrate|schema|database|supabase)\b/.test(allText)) sessionTags.push('database');

    // Token usage aggregation
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let totalCacheWrite5m = 0, totalCacheWrite1h = 0;
    for (const event of events) {
      if (event.usage) {
        totalInput += event.usage.input;
        totalOutput += event.usage.output;
        totalCacheRead += event.usage.cacheRead;
        totalCacheWrite += event.usage.cacheWrite;
        totalCacheWrite5m += event.usage.cacheWrite5m;
        totalCacheWrite1h += event.usage.cacheWrite1h;
      }
    }

    // Cost calculation — Claude Opus 4.6 pay-as-you-go rates
    // Input: $5/MTok, Output: $25/MTok, Cache read: $0.50/MTok
    // Cache write 5min: $6.25/MTok (1.25x), Cache write 1hr: $10/MTok (2x)
    const USD_PER_MTOK_INPUT = 5;
    const USD_PER_MTOK_OUTPUT = 25;
    const USD_PER_MTOK_CACHE_READ = 0.50;
    const USD_PER_MTOK_CACHE_WRITE_5M = 6.25;
    const USD_PER_MTOK_CACHE_WRITE_1H = 10;
    const USD_TO_GBP = 0.79;

    const inputCost = totalInput * USD_PER_MTOK_INPUT / 1_000_000;
    const outputCost = totalOutput * USD_PER_MTOK_OUTPUT / 1_000_000;
    const cacheReadCost = totalCacheRead * USD_PER_MTOK_CACHE_READ / 1_000_000;
    const cacheWrite5mCost = totalCacheWrite5m * USD_PER_MTOK_CACHE_WRITE_5M / 1_000_000;
    const cacheWrite1hCost = totalCacheWrite1h * USD_PER_MTOK_CACHE_WRITE_1H / 1_000_000;
    // Fallback: if no 5m/1h breakdown, price all cache writes at 1hr rate
    const cacheWriteCost = (totalCacheWrite5m + totalCacheWrite1h > 0)
      ? cacheWrite5mCost + cacheWrite1hCost
      : totalCacheWrite * USD_PER_MTOK_CACHE_WRITE_1H / 1_000_000;
    const totalCostUSD = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    const totalCostGBP = totalCostUSD * USD_TO_GBP;

    const tokenUsage = {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      costUSD: Math.round(totalCostUSD * 100) / 100,
      costGBP: Math.round(totalCostGBP * 100) / 100,
      breakdown: { inputCost, outputCost, cacheReadCost, cacheWriteCost },
      agentTokens
    };

    return {
      totalEvents,
      userEvents,
      assistantEvents,
      toolUsages,
      agentCount: agents.size,
      toolBreakdown,
      efficiencyScore,
      leadTools,
      subagentTools,
      leadPhases,
      agentRatios,
      tokenUsage,
      parallelism,
      leadPostAgent,
      agentAutonomy,
      duplicateWork,
      costPerAgent,
      promptLengths,
      timeToFirstEdit,
      errorCounts,
      modelDistribution,
      cumulativeCost: costChart,
      fileHeatmap,
      spawnLatency,
      sessionTags
    };
  }

  setupWebServer() {
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    this.app.use(express.static(path.join(__dirname, 'web')));

    // List all team sessions (lightweight)
    this.app.get('/api/sessions', async (req, res) => {
      try {
        this.sessions = await this.discoverAllSessions();

        // Compute lightweight efficiency scores for trend sparkline
        const sessionsWithScores = await Promise.all(this.sessions.map(async (s) => {
          const base = {
            id: s.id,
            projectName: s.projectName,
            shortProjectName: this.shortProjectName(s.projectName),
            agentCount: s.agentCount,
            startTime: s.startTime,
            endTime: s.endTime,
            duration: s.duration,
            gitBranch: s.gitBranch,
            sessionType: s.sessionType || 'subagent',
            sessionDescription: s.sessionDescription || '',
            teammateNames: s.teammateNames,
            efficiencyScore: null
          };
          try {
            const parsed = await this.parseFullSession(s.id);
            if (parsed?.stats?.efficiencyScore != null) {
              base.efficiencyScore = parsed.stats.efficiencyScore;
            }
            if (parsed?.stats?.tokenUsage) {
              base.costGBP = parsed.stats.tokenUsage.costGBP;
              base.totalTokens = parsed.stats.tokenUsage.total;
            }
          } catch (e) { /* skip on error */ }
          return base;
        }));

        res.json({
          sessions: sessionsWithScores,
          count: this.sessions.length,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load sessions' });
      }
    });

    // Global summary stats
    this.app.get('/api/summary', async (req, res) => {
      try {
        res.json({
          totalSessions: this.sessions.length,
          totalAgents: this.sessions.reduce((sum, s) => sum + s.agentCount, 0),
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load summary' });
      }
    });

    // Full session detail
    this.app.get('/api/sessions/:id', async (req, res) => {
      try {
        const session = await this.parseFullSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        res.json({
          id: session.id,
          projectName: session.projectName,
          gitBranch: session.gitBranch,
          startTime: session.startTime,
          endTime: session.endTime,
          duration: session.duration,
          agents: session.agents,
          teammateNames: session.teammateNames,
          stats: session.stats
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load session' });
      }
    });

    // Timeline (paginated)
    this.app.get('/api/sessions/:id/timeline', async (req, res) => {
      try {
        const session = await this.parseFullSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const page = parseInt(req.query.page) || 0;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const start = page * pageSize;
        const eventSlice = session.events.slice(start, start + pageSize);

        res.json({
          events: eventSlice,
          total: session.events.length,
          page,
          pageSize,
          hasMore: start + pageSize < session.events.length
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load timeline' });
      }
    });

    // Communications
    this.app.get('/api/sessions/:id/communications', async (req, res) => {
      try {
        const session = await this.parseFullSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        res.json({
          communications: session.communications,
          count: session.communications.length
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load communications' });
      }
    });

    // Tasks
    this.app.get('/api/sessions/:id/tasks', async (req, res) => {
      try {
        const session = await this.parseFullSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        res.json({
          tasks: session.tasks,
          count: session.tasks.length
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load tasks' });
      }
    });

    // Single agent detail
    this.app.get('/api/sessions/:id/agents/:agentId', async (req, res) => {
      try {
        const session = await this.parseFullSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const agent = session.agents[req.params.agentId];
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const agentEvents = session.events
          .filter(e => e.agentId === req.params.agentId)
          .slice(0, 100);

        res.json({
          ...agent,
          recentEvents: agentEvents
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to load agent' });
      }
    });

    // Session comparison
    this.app.get('/api/compare', async (req, res) => {
      try {
        const ids = (req.query.ids || '').split(',').filter(Boolean);
        if (ids.length < 2) return res.status(400).json({ error: 'Provide 2+ session IDs via ?ids=id1,id2' });
        const sessions = [];
        for (const id of ids.slice(0, 3)) {
          const parsed = await this.parseFullSession(id);
          if (parsed) {
            sessions.push({
              id: parsed.id, projectName: parsed.projectName,
              startTime: parsed.startTime, duration: parsed.duration,
              stats: parsed.stats, agents: parsed.agents
            });
          }
        }
        res.json({ sessions });
      } catch (error) {
        res.status(500).json({ error: 'Failed to compare sessions' });
      }
    });

    // Main route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'web', 'index.html'));
    });
  }

  async startServer() {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(this.port, async () => {
        console.log(chalk.green(`\nAgent Dashboard running at http://localhost:${this.port}`));
        resolve();
      });
    });
  }

  async openBrowser() {
    const url = `http://localhost:${this.port}`;
    try {
      await open(url);
    } catch (error) {
      console.log(chalk.yellow('Could not open browser automatically. Please visit:'));
      console.log(chalk.cyan(url));
    }
  }

  stop() {
    if (this.httpServer) {
      this.httpServer.close();
    }
    console.log(chalk.yellow('Dashboard stopped'));
  }
}

async function runDashboard(options = {}) {
  console.log(chalk.blue('Starting Claude Agent Dashboard...'));

  const dashboard = new AgentDashboard(options);

  try {
    await dashboard.initialize();
    await dashboard.startServer();

    if (options.open !== false) {
      await dashboard.openBrowser();
    }

    console.log(chalk.green('Dashboard is running!'));
    console.log(chalk.cyan(`Access at: http://localhost:${dashboard.port}`));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));

    const sessionCount = dashboard.sessions.length;
    const agentCount = dashboard.sessions.reduce((sum, s) => sum + s.agentCount, 0);
    const multiCount = dashboard.sessions.filter(s => s.sessionType === 'multi-agent').length;
    console.log(chalk.white(`Found ${sessionCount} sessions (${multiCount} multi-agent, ${agentCount} total agents)\n`));

    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nShutting down...'));
      dashboard.stop();
      process.exit(0);
    });

    await new Promise(() => {});
  } catch (error) {
    console.error(chalk.red('Failed to start dashboard:'), error.message);
    process.exit(1);
  }
}

module.exports = {
  runDashboard,
  AgentDashboard
};

// Auto-run when executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = { open: args.includes('--open') };
  runDashboard(options);
}
