# ADR 0002: Phase 1 local projects and literature

- Status: accepted
- Date: 2026-10-22

## Context

Phase 1 needs a durable local project workspace and a usable literature loop before Codex or experiment execution is introduced. The product requires user-triggered public literature discovery, imported files with source locators, persistence across restart, and strict separation between local and remote artifact references.

## Decisions

- Use Vite + React for the localhost workbench and a separate local Node HTTP API in the same modular monolith.
- Use SQLite through `better-sqlite3`; apply idempotent schema migrations and SQLite FTS5 for initial full-text retrieval. Defer vector search and embeddings.
- Store user data under the platform's application-data directory in a `trash` workspace; `TRASH_HOME` overrides the root. Keep project files outside the source repository by default.
- Import PDF, BibTeX, RIS, Markdown and user-submitted public webpage URLs. Extract PDF text with page locators; preserve paragraph and heading locators for Markdown and web pages. Parse bibliographic records into metadata and index abstracts when available.
- Implement OpenAlex Works API as the first public search provider. Provide Google Scholar only as a user-triggered browser search link; do not scrape it.
- Fetch webpage content only after explicit URL submission. Allow HTTP(S) public unicast hosts only, pin a validated DNS address per request, validate every redirect, and bound redirects, time and response size.
- Treat OpenAlex search results as provider metadata. Do not create local artifacts for remotely hosted source material unless the user imports the actual file.

## Consequences

The first literature workflow can be tested without Codex, SSH, external credentials, or vector infrastructure. SQLite FTS5 supports exact source-returning retrieval for the initial corpus; semantic retrieval can be evaluated later against real APT literature. Webpage import is intentionally limited to public pages and may fail on sites requiring authentication or browser rendering.

## Alternatives considered

- A browser-only application would not provide a suitable local database and filesystem boundary for project files.
- A remote hosted database would conflict with local-first data ownership and add deployment requirements.
- Vector search in Phase 1 would add embedding selection and model lifecycle decisions before a baseline corpus workflow exists.
- Scholar scraping is excluded; the user opens Scholar and chooses materials to import.
