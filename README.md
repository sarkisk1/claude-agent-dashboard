# Claude Agent Dashboard

Visual dashboard for analyzing Claude Code multi-agent sessions. See how your agents collaborate, what tools they use, and where time is spent.

![Dashboard Screenshot](https://img.shields.io/badge/status-beta-blue)

## What it does

When you use Claude Code with subagents (via the `Agent` tool or Teams), session data is stored in `~/.claude/projects/`. This dashboard reads those JSONL files and gives you:

- **Timeline view** - See when each agent was active, with duration/events/tools columns
- **Agent cards** - Per-agent stats with tool usage breakdown
- **Detail panel** - Click any agent to see delegated tasks, tool bar charts, interactions, and communications
- **Session browser** - Navigate all your multi-agent sessions across all projects

## Quick start

```bash
# Clone and run
git clone https://github.com/sarkisk1/claude-agent-dashboard.git
cd claude-agent-dashboard
npm install
npm start
```

Or run directly with npx:

```bash
npx github:sarkisk1/claude-agent-dashboard
```

The dashboard opens at `http://localhost:3338` and auto-discovers all multi-agent sessions from `~/.claude/projects/`.

## Requirements

- Node.js 16+
- Claude Code installed (needs `~/.claude/projects/` directory with session data)
- At least one session that used 2+ subagents

## What you'll see

### Stats bar
High-level numbers: agent count, session duration, total tool calls, top tools used.

### Timeline
Gantt-style chart showing when each agent was active relative to the session. Lead (orchestrator) is shown first, followed by subagents sorted by start time. Each row shows duration, event count, and tool count.

### Agent cards
Grid of cards for each subagent showing:
- The delegated task (what the Lead asked it to do)
- Duration, events, messages, tool calls
- Mini tool usage bar (top 3 tools as proportional segments)

### Detail panel
Click any agent or timeline row to see:
- **Delegated task** - The prompt the Lead gave this agent
- **Tools** - Bar chart of all tools used with counts
- **Interactions** - Which agents it communicated with (in/out counts)
- **Received/Sent** - Full communication log with previews
- **Tasks** - Any tasks created or owned by this agent

## How it works

1. Scans `~/.claude/projects/[encoded-path]/[session-uuid]/subagents/` for `agent-*.jsonl` files
2. Sessions with 2+ subagent files OR native Team protocol (TeamCreate/SendMessage) are shown
3. Parses JSONL lines to extract events, tool calls, and communications
4. Resolves agent names by matching `Agent` tool calls to subagent start times
5. Serves everything via Express on port 3338

## API endpoints

The dashboard exposes a REST API you can query directly:

| Endpoint | Description |
|----------|-------------|
| `GET /api/sessions` | List all discovered multi-agent sessions |
| `GET /api/summary` | Total session and agent counts |
| `GET /api/sessions/:id` | Full session detail (agents, stats) |
| `GET /api/sessions/:id/timeline?page=0&pageSize=50` | Paginated event timeline |
| `GET /api/sessions/:id/communications` | All inter-agent communications |
| `GET /api/sessions/:id/tasks` | Tasks created/updated in the session |
| `GET /api/sessions/:id/agents/:agentId` | Single agent detail with recent events |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 3338 | Port to run the dashboard on |
| `--no-open` | false | Don't auto-open browser |

## License

MIT
