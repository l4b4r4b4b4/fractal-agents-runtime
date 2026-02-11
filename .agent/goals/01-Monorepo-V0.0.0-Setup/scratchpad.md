# Goal 01: Monorepo v0.0.0 Setup — Full DevOps Pipeline

> **Status:** 🟡 In Progress
> **Priority:** Critical
> **Created:** 2026-02-11
> **Last Updated:** 2026-02-11

---

## Objectives

Ship v0.0.0 of both `apps/python` (real implementation) and `apps/ts` (stub) with:

1. **Migrated Python app** — All code from `oap-langgraph-tools-agent` reorganized into `apps/python/`
2. **TypeScript stub app** — Minimal Bun HTTP server (health/info + OpenAPI) to validate the full pipeline
3. **Lefthook git hooks** — Pre-commit (lint + generate OpenAPI spec), pre-push (validate)
4. **Branch protection** — `development` and `main` branches with required CI checks
5. **Full CI/CD pipeline** — 2-branch workflow with feature/dev/release image builds + library publishing
6. **OpenAPI specs** — Generated, committed, and served at runtime for both apps
7. **Docker images** — Building and publishing to GHCR for both apps
8. **Library releases** — PyPI for Python, npm for TS (on main merge)

---

## DevOps Pipeline: 2-Branch Strategy

```
feature branch ──push──► Feature image build (sha tag)
       │
       └──PR──► development (protected)
                    │
                    └──merge──► CI + development image builds
                                    │
                                    └──PR──► main (protected)
                                                │
                                                └──merge──► CI + image build + release tags
                                                            + PyPI publish
                                                            + npm publish
```

### Image Tagging Convention

| Trigger | Image Tag |
|---------|-----------|
| Push to feature branch | `sha-<short_sha>` |
| Merge to `development` | `development`, `sha-<short_sha>` |
| Merge to `main` (release) | `latest`, `v0.0.0`, `sha-<short_sha>` |

### Branch Protection Rules

**`development`:**
- Require PR (no direct push)
- Require CI checks to pass (lint + test for affected app)
- Allow squash merge

**`main`:**
- Require PR (no direct push)
- Require CI checks to pass
- Require PR from `development` only (or hotfix branches)
- Allow squash merge

---

## OpenAPI Spec Strategy

| When | What | How |
|------|------|-----|
| Pre-commit (lefthook) | Generate spec, auto-stage | `scripts/generate-openapi.sh` per app |
| Pre-push (lefthook) | Validate spec is current | Diff generated vs committed, fail if stale |
| CI workflow | Validate spec is current | Same check as pre-push |
| Runtime | Serve at `/openapi.json` | Both servers serve their spec |
| Repo | Committed per app | `apps/python/openapi-spec.json`, `apps/ts/openapi-spec.json` |

---

## Task Breakdown

### Task-01: Scaffold `apps/python/`
- Create `apps/python/` directory structure
- Move/copy source code:
  - `tools_agent/` → `apps/python/src/react_agent_with_mcp_tools/`
  - `robyn_server/` → `apps/python/src/robyn_server/`
- Create `apps/python/pyproject.toml` (package name: `fractal-agents-runtime`, version `0.0.0`)
- Move `uv.lock`, `langgraph.json`, `Makefile`, `docker-compose.yml`
- Update ALL internal imports: `tools_agent.` → `react_agent_with_mcp_tools.`
- Update `langgraph.json` paths
- Verify: `cd apps/python && uv sync && uv run pytest && uv run ruff check .`
- **Depends on:** Nothing

### Task-02: Scaffold `apps/ts/`
- Create `apps/ts/package.json` (name: `@fractal/agents-runtime-ts`, version `0.0.0`)
- Create `apps/ts/tsconfig.json` (strict, ESNext, Bun-native)
- Create `apps/ts/src/index.ts` — Minimal Bun HTTP server:
  - `GET /health` → `{ "status": "ok" }`
  - `GET /info` → `{ "service": "fractal-agents-runtime-ts", "version": "0.0.0", ... }`
  - `GET /openapi.json` → Serve the OpenAPI spec
- Create `apps/ts/src/openapi.ts` — Minimal OpenAPI spec (health + info only for v0.0.0)
- Create `apps/ts/tests/` — Basic tests with `bun test`
- Verify: `cd apps/ts && bun install && bun test`
- **Depends on:** Nothing (parallel with Task-01)

### Task-03: Root `package.json` + Bun Workspace
- Update root `package.json`:
  - Add `"workspaces": ["apps/*", "packages/*"]`
  - Set `"version": "0.0.0"`, `"private": true`
  - Add monorepo scripts (dev:python, dev:ts, test, lint, format, docker)
  - Remove `"module": "index.ts"` and root-level deps
- Create `apps/python/package.json` (workspace entry with uv-delegating scripts)
- Verify: `bun install` at root works
- **Depends on:** Task-01, Task-02

### Task-04: Lefthook Git Hooks
- Add `lefthook` to Nix flake
- Create `lefthook.yml` at root:
  - **pre-commit:**
    - Python: `ruff check --fix && ruff format` (scoped to `apps/python/`)
    - Python: Generate OpenAPI spec, auto-stage if changed
    - TS: `bunx tsc --noEmit` (scoped to `apps/ts/`)
    - TS: Generate OpenAPI spec, auto-stage if changed
  - **pre-push:**
    - Validate OpenAPI specs are current (fail if stale)
    - Run tests for both apps
- Create `scripts/generate-openapi-python.sh`
- Create `scripts/generate-openapi-ts.sh`
- Verify: `lefthook run pre-commit` and `lefthook run pre-push`
- **Depends on:** Task-01, Task-02

### Task-05: OpenAPI Generation & Serving
- Python: Update/create `apps/python/scripts/generate_openapi.py`
  - Generates `apps/python/openapi-spec.json`
  - Robyn server serves it at `GET /openapi.json`
- TypeScript: Create spec generation in `apps/ts/src/openapi.ts`
  - Generates `apps/ts/openapi-spec.json`
  - Bun server serves it at `GET /openapi.json`
- Both specs committed to repo
- **Depends on:** Task-01, Task-02

### Task-06: Dockerfiles
- Create/update `apps/python/Dockerfile` (Robyn runtime, multi-stage, uv-based)
- Create `apps/ts/Dockerfile` (Bun runtime, multi-stage)
- Verify both build locally:
  - `docker build -f apps/python/Dockerfile apps/python`
  - `docker build -f apps/ts/Dockerfile apps/ts`
- **Depends on:** Task-01, Task-02

### Task-07: GitHub Actions — CI Workflow
- Create `.github/workflows/ci.yml`:
  - Triggered on: push to any branch, PR to development/main
  - Path-filtered: only run Python CI on `apps/python/**` changes, TS on `apps/ts/**`
  - Jobs:
    - `lint-python`: ruff check + format check
    - `test-python`: pytest
    - `lint-ts`: tsc --noEmit
    - `test-ts`: bun test
    - `validate-openapi`: check specs are current
  - Summary job for branch protection
- **Depends on:** Task-01, Task-02

### Task-08: GitHub Actions — Image Builds
- Create `.github/workflows/image-python.yml`:
  - Triggered on: push to any branch (feature builds), merge to development, merge to main
  - Builds `apps/python/Dockerfile`
  - Tags per strategy (sha, development, latest+version)
  - Pushes to `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-python`
- Create `.github/workflows/image-ts.yml`:
  - Same pattern for `ghcr.io/l4b4r4b4b4/fractal-agents-runtime-ts`
- **Depends on:** Task-06, Task-07

### Task-09: GitHub Actions — Library Releases
- Create `.github/workflows/release-python.yml`:
  - Triggered on: tag `python-v*` OR merge to main with changes in `apps/python/`
  - Builds and publishes to PyPI
  - `uv build && uv publish` (or twine)
- Create `.github/workflows/release-ts.yml`:
  - Triggered on: tag `ts-v*` OR merge to main with changes in `apps/ts/`
  - Publishes to npm via `bun publish`
- **Depends on:** Task-07, Task-08

### Task-10: Initial Commit, Push & Branch Setup [L179-189]
- Create `development` branch from `main`
- Configure branch protection rules on GitHub (development + main)
- Create GitHub rulesets (or use branch protection API)
- Tag `python-v0.0.0` and `ts-v0.0.0`
- Verify full pipeline: feature → development → main → images + releases
- **Depends on:** All previous tasks

---

## Success Criteria

- [x] `apps/python/` contains all migrated source code with `react_agent_with_mcp_tools` module name
- [x] `cd apps/python && uv sync && uv run pytest` passes
- [x] `cd apps/python && uv run ruff check . && uv run ruff format --check .` passes
- [x] `apps/ts/` contains working Bun HTTP server stub
- [x] `cd apps/ts && bun test` passes
- [x] `bun install` at root works with workspace resolution
- [x] Root `package.json` scripts delegate correctly to both apps
- [x] `lefthook run pre-commit` succeeds
- [x] `lefthook run pre-push` succeeds
- [x] Both Docker images build in CI (Python passed on initial push, TS passed after Dockerfile fix in PR #1)
- [x] CI workflow runs on PR and blocks merge on failure (validated: PR #1 required CI Success before merge)
- [x] Feature branch push triggers image build with `sha-` tag (validated: fix/ts-dockerfile-bun-version built images)
- [x] Merge to `development` triggers development image build (validated: squash-merge of PR #1 triggered builds)
- [ ] Merge to `main` triggers release image + library publish (workflow written, needs tag — deferred to Goal 02/03)
- [x] `apps/python/openapi-spec.json` committed and served at runtime
- [x] `apps/ts/openapi-spec.json` committed and served at runtime
- [ ] `python-v0.0.0` tag exists and triggered PyPI publish (deferred to Goal 02)
- [ ] `ts-v0.0.0` tag exists and triggered npm publish (deferred to Goal 03)
- [x] Branch protection active on `development` and `main` (rulesets applied via `gh api`, IDs 12713513 + 12713518)
- [x] Full branch protection flow validated: feature branch → PR → CI gate → squash merge → development
- [x] SBOM + provenance attestation attached to GHCR images (`sbom: true`, `provenance: true`)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Import rename breakage | High | Full test suite validates after rename |
| CI path filters miss changes | Medium | Test with dry-run PRs before protecting branches |
| PyPI/npm publish auth | Medium | Set up tokens as GitHub secrets early |
| Docker build context paths | Medium | Test locally before CI |
| Lefthook install across platforms | Low | Nix flake provides it; CI doesn't need hooks |
| OpenAPI generation requires running server | Medium | Generate from code/schema, not live server |

---

## Progress Log

### 2026-02-11 — Session 1 (Planning & Foundation)

**Completed:**
- [x] Created `fractal-agents-runtime` repo on GitHub (public, NOT a fork)
- [x] Adapted `flake.nix` from DocProc template for monorepo context
  - Tooling: bun, python312, uv, ruff, docker, kubectl, helm, k9s, minikube, kubectx, stern
  - FHS env: `fractal-dev` (handles native Python wheel builds)
  - Auto-setup: venv creation in `apps/python/`, bun workspace install, dep sync
  - Fixed `runScript` — must be bare command path, not shell script body
- [x] `nix develop` works — all tools available
- [x] Ran `bun init` — created root `package.json` (needs workspace config)
- [x] Rewrote `.rules` for monorepo context
  - Added: Bun Monorepo Rules, TypeScript Rules, Helm & Kubernetes Deployment
  - Updated: Python scoped to `apps/python/`, dependency mgmt split Python/TS
  - Updated: Docker pattern, versioning (independent per app), commit scoping
- [x] Created all three goal scratchpads (01, 02, 03)
- [x] Updated goals index for fresh repo

### 2026-02-12 — Session 2 (Tasks 01–09: Scaffold, Stage, Wire, CI/CD)

**Task-01 — Scaffold & Stage (completed):**
- [x] Wrote root `README.md` — monorepo overview, architecture, getting started, env vars, CI/CD
- [x] Staged Python source into `.agent/tmp/python/`, misc into `.agent/tmp/misc/`
- [x] User approved staging — dropped Makefile per request
- [x] Scaffolded `apps/python/`, `apps/ts/`, `packages/`, `docs/` directories
- [x] Moved all staged files into monorepo structure
- [x] Renamed `tools_agent` → `react_agent_with_mcp_tools` (directory + all imports/references across 14 files)
- [x] Updated `pyproject.toml`: name `fractal-agents-runtime`, v0.0.0, author, `src/` layout, removed `langgraph-cli`
- [x] Dropped `langgraph.json` and `Dockerfile.langgraph` — proprietary LangGraph Platform config
- [x] Updated root `package.json`: workspaces, v0.0.0, scripts, removed bun-init artifacts
- [x] Removed root `index.ts` and `tsconfig.json` (bun-init artifacts)
- [x] Split `.gitignore`: root (generic) + `apps/python/` (gitignore.io/python) + `apps/ts/` (gitignore.io/node+bun)
- [x] Fixed `flake.nix`: `unset VIRTUAL_ENV` before venv activation
- [x] **Verification:** `uv sync` ✅, `pytest` 550 passed ✅, `ruff` clean ✅, `bun install` clean ✅

**Task-02 — Scaffold `apps/ts/` (completed):**
- [x] Created `apps/ts/package.json` (`@fractal/agents-runtime-ts`, v0.0.0, Bun-native)
- [x] Created `apps/ts/tsconfig.json` (strict, ESNext, bundler module resolution, `@types/bun`)
- [x] Created `apps/ts/src/index.ts` — Bun HTTP server (health, info, openapi) with `import.meta.main` guard
- [x] Created `apps/ts/src/openapi.ts` — OpenAPI 3.1 spec (3 paths, 3 operations)
- [x] Created `apps/ts/tests/index.test.ts` — 10 tests (health, info, openapi, 404, method-not-allowed)
- [x] **Verification:** `bun test` 10 passed ✅, `tsc --noEmit` clean ✅

**Task-03 — Workspace Wiring (completed):**
- [x] Created `apps/python/package.json` (workspace entry delegating scripts to uv)
- [x] **Verification:** `bun install` resolves both workspaces ✅, `bun run test:python` 550 pass ✅, `bun run test:ts` 10 pass ✅

**Task-04 — Lefthook Git Hooks (completed):**
- [x] Added `lefthook` to Nix flake + installed as root npm devDep (works in Zed terminal too)
- [x] Created `lefthook.yml` with pre-commit (lint + openapi gen) and pre-push (test + lint + openapi validate + type check)
- [x] Added `postinstall` script in root `package.json` for auto-install on `bun install`
- [x] **Verification:** `lefthook run pre-commit` ✅ (4 hooks), `lefthook run pre-push --force` ✅ (6 hooks, 560 tests total)

**Task-05 — OpenAPI Generation & Serving (completed):**
- [x] Fixed `apps/python/scripts/generate_openapi.py` for `src/` layout, default output `openapi-spec.json`
- [x] Created `apps/ts/scripts/generate-openapi.ts` with `--validate` support
- [x] Generated both specs: Python (116KB, 34 paths, 44 ops, 28 schemas), TS (2.8KB, 3 paths, 3 ops)
- [x] Wired into lefthook: pre-commit generates + auto-stages, pre-push validates staleness

**Task-06 — Dockerfiles (completed):**
- [x] Created `apps/python/Dockerfile` — multi-stage UV build, `src/` layout, non-root user, healthcheck
- [x] Created `apps/ts/Dockerfile` — multi-stage Bun build, non-root user, healthcheck
- [x] Created `.dockerignore` for both apps (exclude venvs, tests, dev files, node_modules)

**Task-07 — CI Workflow (completed):**
- [x] Rewrote `.github/workflows/ci.yml` for monorepo:
  - Change detection via `dorny/paths-filter@v3`
  - Path-filtered jobs: lint, test, openapi-validate per app (only runs if app changed)
  - Uses `astral-sh/setup-uv@v4` and `oven-sh/setup-bun@v2`
  - Summary gate job (`CI Success`) for branch protection
  - Concurrency control (cancel in-progress on same ref)
- [x] Removed old single-repo workflows (`image.yml`, `robyn-image.yml`)

**Task-08 — Image Build Workflows (completed):**
- [x] Created `.github/workflows/image-python.yml` — path-filtered, GHCR push, tag strategy (sha/development/latest+version)
- [x] Created `.github/workflows/image-ts.yml` — same pattern for TS

**Task-09 — Release Workflow (completed):**
- [x] Rewrote `.github/workflows/release.yml`:
  - Tag-triggered: `python-v*` and `ts-v*` (independent per app)
  - Meta job parses tag → conditional publish paths
  - Python: version check → lint → test → openapi validate → `uv build` → PyPI trusted publishing → GHCR image
  - TypeScript: version check → tsc → test → openapi validate → `bun build` → npm publish → GHCR image
  - GitHub Release with auto-generated notes

**Task-10 — Branch Protection (partially completed):**
- [x] Created `.github/rulesets/development.json` (require PR, squash merge, CI Success check)
- [x] Updated `.github/rulesets/main.json` (require PR, squash merge, CI Success check, 0 approvals for solo dev)
- [ ] Create `development` branch
- [ ] Apply rulesets on GitHub
- [ ] Initial commit + push to `main`

**Other fixes:**
- [x] Fixed `.zed/settings.json` — Pyright pointed at `apps/api` (DocProc template leftover) → `apps/python`
- [x] Changed `typeCheckingMode` from `strict` to `standard` (third-party libs lack stubs)
- [x] Extended `apps/ts/tsconfig.json` to include `scripts/` directory
- [x] All YAML workflows validated with Python yaml parser

**Decisions made:**
- No `langgraph.json` — project builds ON LangGraph open-source ecosystem but offers a free, self-hostable runtime
- No Makefile — root `package.json` scripts handle monorepo commands
- `.gitignore` layered: root generic, app-specific in subdirectories
- Lefthook installed both in Nix flake AND as npm devDep (works in all terminals)
- OpenAPI specs are both generated artifacts AND source-controlled (belt and suspenders)
- Rulesets require 0 approvals (solo dev) but enforce squash merge + CI Success

### 2026-02-11 — Session 3 (Task-10: Initial Commit, Push & Branch Setup)

**Pre-commit cleanup:**
- [x] Removed 8 completed/superseded old goal directories (01-Repo-Scaffolding, 02-Remove-LangSmith, 03-Add-Langfuse-Tracing, 05-LLM-Integration, 07-Bun-TypeScript-Runtime, 08-CI-CD-Feature-Parity, 11-Create-Agent-Migration, 17-Fractal-Agents-Runtime-Monorepo)
- [x] Cleaned `.agent/tmp/misc/` staging files (old CHANGELOG, .devops, .github reference files)
- [x] Fixed root `.gitignore` — added `node_modules/`, `.zed/`, build artifacts, coverage dirs (43MB of vendor code was about to be committed)

**Task-10 — Initial Commit & Branch Setup (completed):**
- [x] Added remote `origin` → `git@github.com:l4b4r4b4b4/fractal-agents-runtime.git`
- [x] `git add -A && git commit` — 176 files, ~50K lines. All 4 pre-commit hooks passed (lint, openapi gen ×2, tsc)
- [x] `git push -u origin main` — all 6 pre-push hooks passed (550 Python tests + 10 TS tests + lint + openapi validate + tsc)
- [x] `git checkout -b development && git push -u origin development` — all hooks passed again
- [x] Applied both rulesets via `gh api` — `main-branch-protection` (ID 12713513) + `development-branch-protection` (ID 12713518)
- [x] CI workflows triggered on push — `CI` passed on both `main` and `development` branches
- [x] Python image build passed on `main`, TS image build failed (`adduser` not found in `bun:1-slim`)

**PR #1 — Dockerfile fix + SBOM (completed):**
- [x] Created feature branch `fix/ts-dockerfile-bun-version`
- [x] Fixed TS Dockerfile: pinned `oven/bun:1.3.8` (matches local dev), replaced `adduser` with manual `/etc/passwd` entry for slim images
- [x] Added `sbom: true` + `provenance: true` to both image workflows — CycloneDX SBOM + SLSA provenance attached to GHCR images automatically
- [x] Created PR #1 → `development`, all 12 CI checks passed (including both image builds)
- [x] Squash-merged PR #1, cleaned up feature branch
- [x] **Full branch protection flow validated:** feature branch → PR → CI gate → squash merge → development

**Bill of Software (BoS) decision:**
- Dependency-level BoS = lockfiles (`uv.lock` for Python, `bun.lock` for TS) — already committed and version-controlled
- Image-level BoS = BuildKit SBOM + provenance attestation attached to GHCR images (`sbom: true`, `provenance: true`)
- No additional SBOM generation hooks needed — lockfiles cover deps, BuildKit covers base images + system packages

**Deferred to Goal 02/03:**
- [ ] Tag `python-v0.0.0` and `ts-v0.0.0` releases (release workflow ready but awaiting runtime maturity)

---

## Source Repo Reference

Old repo: `l4b4r4b4b4/oap-langgraph-tools-agent` (local: `/home/lukes/code/github.com/l4b4r4b4b4/oap-langgraph-tools-agent`)

### File Inventory (what to copy)

**Python source (→ .agent/tmp/python/):**

| Source Path | Target in Monorepo | Notes |
|-------------|-------------------|-------|
| `tools_agent/` | `apps/python/src/react_agent_with_mcp_tools/` | Rename module + all imports |
| `robyn_server/` | `apps/python/src/robyn_server/` | Includes tests/, helm/ |
| `pyproject.toml` | `apps/python/pyproject.toml` | Update package name, paths |
| `uv.lock` | `apps/python/uv.lock` | Regenerate after pyproject changes |
| `langgraph.json` | ~~Dropped~~ | Proprietary LangGraph Platform config — not needed |

**Misc reference files (→ .agent/tmp/misc/):**

| Source Path | Purpose | Destination |
|-------------|---------|-------------|
| `Dockerfile` (root) | LangGraph dev runtime | ~~Dropped~~ (proprietary runtime config) |
| `robyn_server/Dockerfile` | Robyn production runtime | `apps/python/src/robyn_server/Dockerfile` (primary) |
| `docker-compose.yml` | Local dev stack | `apps/python/docker-compose.yml` |
| ~~`Makefile`~~ | Dev shortcuts | Dropped — root `package.json` scripts instead |
| `openapi.json` | Existing OpenAPI spec | `apps/python/openapi-spec.json` |
| `scripts/` | OpenAPI generation etc. | `apps/python/scripts/` |
| `static/` | Static assets | `apps/python/static/` |
| `tests/` (root) | Extra tests | `apps/python/tests/` |
| `docs/` | Documentation | `docs/` (root — monorepo-level) |
| `.github/workflows/` | CI/CD reference | Rewrite for monorepo (don't copy directly) |
| `.devops/` | DevOps config | Review — may merge into `.github/` |
| `.env.example` | Env template | `apps/python/.env.example` |
| `CHANGELOG.md` | History | Reference for new CHANGELOG |

### Import Rename Map

All occurrences in Python source:
- `tools_agent.` → `react_agent_with_mcp_tools.`
- `from tools_agent` → `from react_agent_with_mcp_tools`
- `import tools_agent` → `import react_agent_with_mcp_tools`
- `tools_agent/` in `pyproject.toml` → `react_agent_with_mcp_tools/`
- `langgraph.json` — dropped entirely (proprietary LangGraph Platform config)

---

## Notes

- The old `oap-langgraph-tools-agent` repo stays as-is until this is proven working
- Goal 17 from old repo is the parent context for this migration
- OpenAPI specs are both build artifacts AND source-controlled — belt and suspenders
- Lefthook hooks are developer-side only — CI validates independently
- The TS stub for v0.0.0 is intentionally minimal: just enough to prove the pipeline works
- Old goal directories (01–17) from previous repo kept in `.agent/goals/` for reference
- Project builds ON the LangGraph open-source ecosystem (langgraph, langchain-core, adapters, checkpointers) but offers a free, self-hostable runtime — not locked to LangGraph Platform
- `langgraph.json` and `langgraph-cli` dropped — they're hooks into the proprietary runtime, not the open-source libs
- Reference files from old repo kept in `.agent/tmp/misc/` for CI/CD rewrite (workflows, .devops, CHANGELOG)
- Lefthook npm package ensures hooks work in Zed integrated terminal (not just Nix dev shell)
- Pyright in `standard` mode — `strict` generates thousands of false positives from untyped third-party libs
- `.zed/settings.json` must point at correct venv path — was broken from DocProc template