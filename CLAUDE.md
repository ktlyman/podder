# Project: Podder — Podcast Knowledge Base

A podcast knowledge base system that syncs podcast feeds, fetches transcripts from Podscribe services, stores them in a searchable SQLite database with FTS5, and exposes an agent-friendly query interface via CLI, MCP server, and web UI.

## Project Structure

- `src/types/` - Core type definitions
- `src/adapters/` - RSS parser and Podscribe transcript adapters
- `src/storage/` - SQLite database with FTS5 full-text search
- `src/agent/` - Query engine for agent/RAG-style access
- `src/cli/` - CLI entry point (commander-based)
- `src/mcp/` - MCP server for AI agent integration
- `src/server/` - HTTP API server for the web frontend
- `src/sync.ts` - Sync engine orchestrating feed parsing and transcript fetching
- `src/config.ts` - Configuration loading
- `public/` - Frontend SPA (single HTML file, no build step)

## Commands

- Build: `npm run build`
- Dev CLI: `npm run dev -- <command>`
- Lint CLAUDE.md: `npm run lint`
- Type check: `npm run lint:ts`
- MCP server: `npm run mcp:dev`
- Web UI: `npm run serve:dev` (http://localhost:3000)

## Code Conventions

- TypeScript with strict mode enabled
- ES modules (type: "module" in package.json)
- Node.js >= 20
- Use `better-sqlite3` for database operations
- Use `fast-xml-parser` for RSS feed parsing
- Prefer explicit types over `any`
- Handle errors at boundaries, not internally
- Keep adapters stateless where possible

## Architecture Decisions

- SQLite with FTS5 for full-text search (no external search engine needed)
- Composite adapter pattern for transcript sources (RSS tags, podscribe.app, podscribe.io)
- MCP protocol over stdio for agent integration (compatible with Claude Code, Claude Desktop)
- Rate-limited transcript fetching to be respectful of source servers
- HTTP API server using Node.js built-ins only (no express) for the web frontend
- Single-file SPA frontend (no build step, no framework)
