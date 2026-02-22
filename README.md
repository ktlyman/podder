# Podder

A podcast knowledge base that syncs podcast feeds, fetches transcripts via [Podscribe](https://podscribe.app), and stores everything in a searchable SQLite database with full-text search. Query your podcast library through a CLI, web UI, or MCP server for AI agent integration.

## Features

- **Feed syncing** — Parse RSS feeds and track episodes automatically
- **Transcript fetching** — Pull transcripts from RSS tags, podscribe.app, and podscribe.io with automatic fallback
- **Full-text search** — SQLite FTS5-powered search with BM25 ranking across all transcripts
- **Web UI** — Single-page app for browsing podcasts, searching transcripts, and tracking topics
- **MCP server** — Expose your podcast knowledge base to Claude Code, Claude Desktop, or any MCP-compatible AI agent
- **CLI** — Sync feeds, search transcripts, and inspect episodes from the terminal

## Quick Start

```bash
# Install dependencies
npm install

# Copy and edit the podcast config
cp podcasts.example.json podcasts.json
# Edit podcasts.json with your podcast feeds

# Sync feeds and fetch transcripts
npm run dev -- sync

# Search your transcripts
npm run dev -- search "artificial intelligence"

# Start the web UI
npm run serve:dev
# Open http://localhost:3000
```

## CLI Usage

```bash
# Sync all configured podcasts
npm run dev -- sync

# Sync a specific podcast
npm run dev -- sync --podcast huberman-lab

# Search across all transcripts
npm run dev -- search "machine learning"

# Get context for a topic (formatted for LLM use)
npm run dev -- context "quantum computing"

# List episodes for a podcast
npm run dev -- episodes huberman-lab

# View a specific transcript
npm run dev -- transcript <episode-id>

# Show database stats
npm run dev -- stats
```

## MCP Server

Add to your Claude Code or Claude Desktop config:

```json
{
  "mcpServers": {
    "podcasts": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "/path/to/podder"
    }
  }
}
```

Build first with `npm run build`, then the MCP server exposes tools for searching, browsing, and syncing your podcast library.

## Configuration

Create a `podcasts.json` file (see `podcasts.example.json` for the format):

```json
[
  {
    "id": "my-podcast",
    "name": "My Favorite Podcast",
    "feedUrl": "https://example.com/feed.xml",
    "tags": ["tech", "science"]
  }
]
```

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Run CLI in dev mode (via tsx)
npm run serve:dev    # Start web server in dev mode
npm run mcp:dev      # Start MCP server in dev mode
npm run lint:ts      # Type check
npm run lint         # Lint CLAUDE.md
```

Requires Node.js >= 20.

## Tech Stack

- **TypeScript** with strict mode
- **SQLite** via better-sqlite3 with FTS5 full-text search
- **fast-xml-parser** for RSS feed parsing
- **Commander.js** for CLI
- **MCP protocol** over stdio for AI agent integration
- **Node.js HTTP** server (no framework) for the web API
- **Vanilla HTML/CSS/JS** single-page frontend (no build step)
