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
- `public/` - Frontend SPA

## Commands

- Build: `npm run build`
- Dev CLI: `npm run dev -- <command>`
- Lint CLAUDE.md: `npm run lint`
- Type check: `npm run lint:ts`
- MCP server: `npm run mcp:dev`
- Web UI: `npm run serve:dev` (http://localhost:3000)

## Code Conventions

- MUST use TypeScript with strict mode enabled
- MUST use ES modules (type: "module" in package.json)
- MUST target Node.js >= 20
- MUST use `better-sqlite3` for database operations
- MUST use `fast-xml-parser` for RSS feed parsing
- MUST prefer explicit types over `any`
- SHOULD handle errors at boundaries, not internally
- SHOULD keep adapters stateless where possible

## Architecture Decisions

- MUST use SQLite with FTS5 for full-text search (no external search engine)
- MUST use composite adapter pattern for transcript sources (RSS tags, podscribe.app, podscribe.io)
- MUST use MCP protocol over stdio for agent integration (compatible with Claude Code, Claude Desktop)
- MUST rate-limit transcript fetching to be respectful of source servers
- MUST use Node.js built-in HTTP server only (no express) for the web frontend
- MUST keep the frontend as a single-file SPA (no build step, no framework)

## Security

- MUST NOT commit `.env` or database files; instead, use `.gitignore` to exclude them and refer to `podcasts.example.json` for config templates
- MUST NOT hardcode API keys, tokens, or credentials in source files; instead, load secrets from environment variables
- MUST NOT expose sensitive data in logs or error messages; instead, sanitize output before logging
- MUST store user-specific podcast config locally (excluded from version control via `.gitignore`)
- MUST validate and sanitize all external input from RSS feeds before storing in the database
- MUST NOT commit authentication tokens or session data; instead, use `.env` for any auth configuration
