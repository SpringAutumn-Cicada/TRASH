# ADR 0001: Phase 0 tooling and protocol baseline

- Status: accepted for the MVP baseline
- Date: 2026-10-21

## Context

The repository contains product and architecture documents but no source tree, package manifest, Git metadata, or local development constraints. The adjacent R2R project demonstrates a TypeScript/pnpm workspace, strict TypeScript project references, Zod validation, and Node's built-in test runner. Its security/CNVD domain model is not applicable here.

## Decisions

- Initialize this project as its own Git repository and use a pnpm workspace with TypeScript project references.
- Use Zod for runtime validation at the protocol boundary and Node's built-in test runner with `tsx` for TypeScript tests.
- Start protocol versioning at `v1`; namespace IDs with stable entity prefixes (`project_`, `wfrun_`, `agenttask_`, `exptask_`, `artifact_`, `event_`).
- Freeze only the five requested records plus their event/status contracts. Keep literature, approvals, database persistence, Agent process management, and SSH execution for their corresponding phases.
- Use a loopback-only Node HTTP process as a temporary Phase 0 startup smoke target. Frontend framework and persistent storage remain open for Phase 1 implementation.
- Represent artifact location as a local or remote discriminated union; remote references retain a profile and URI and do not imply local bytes exist.
- Require a full Git commit SHA and a clean working tree for experiment task records.

## Consequences

The protocol package can be validated without launching Codex, connecting to SSH, or choosing a database. Phase 0 startup verifies local process wiring only; it is not the usable UI promised by later workflow phases. Compatibility policy for protocol evolution should be revisited before external integrations are published.
