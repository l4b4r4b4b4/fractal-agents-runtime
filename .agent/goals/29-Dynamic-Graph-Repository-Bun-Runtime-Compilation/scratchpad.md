# Goal 29: Dynamic Graph Repository — Bun Runtime Compilation Architecture

> **Status:** ⚪ Not Started (Research Complete)
> **Priority:** Medium
> **Created:** 2025-07-20
> **Updated:** 2025-07-20
> **Depends on:** [Goal 03 — TS Runtime v0.0.1](../03-TypeScript-Runtime-V0.0.1/scratchpad.md), [Goal 25 — TS Runtime v0.0.2](../25-TS-Runtime-V0.0.2-Auth-Persistence-Store/scratchpad.md)
> **Blocking:** None (future capability — can be pursued independently)

---

## Overview

Bun provides runtime primitives that are **genuinely superior to Python** for building a dynamic graph repository — a system where users can upload, store, and execute custom LangGraph agent definitions at runtime without redeploying the server.

This goal documents the research findings, proposes an architecture, and outlines a phased implementation plan for a dynamic graph repository leveraging Bun's unique capabilities: `Bun.Transpiler`, `Bun.build({ files })` (in-memory virtual module bundling), the Plugin API, and native TypeScript execution.

### Why This Matters

Today, adding a new agent graph to either runtime requires:
1. Writing the graph factory code
2. Registering it in the graph registry
3. Rebuilding the Docker image
4. Redeploying

A dynamic graph repository would allow:
1. **API-driven graph creation** — POST a TypeScript graph definition via API
2. **Instant availability** — Graph is transpiled, validated, and registered in-memory
3. **Database persistence** — Graph source stored in Postgres, loaded on startup
4. **Hot-reload** — Update a graph without restarting the server
5. **Per-user graphs** — Users define custom agents scoped to their tenant

---

## Research Findings

### Bun's Key Runtime Compilation Primitives

#### 1. `Bun.Transpiler` — Purpose-Built Runtime TS→JS Conversion

```typescript
const transpiler = new Bun.Transpiler({ loader: "ts" });

// Transpile TypeScript to JavaScript at runtime — synchronous, fast
const jsCode = transpiler.transformSync(`
  import { createAgent } from "langchain";
  export const graph = async (config, options) => {
    const model = createChatModel(config);
    return createAgent({ model, tools: [], checkpointer: options?.checkpointer });
  };
`);

// Also supports async (runs on worker threadpool):
const jsCodeAsync = await transpiler.transform(tsCode);
```

**Capabilities:**
- `transformSync(code, loader?)` — Synchronous TS/TSX/JSX → JS. Runs in-thread.
- `transform(code, loader?)` — Async version, runs on Bun's worker threadpool. Better for many large files.
- `.scan(code)` — Returns imports and exports metadata. Can validate graph structure BEFORE execution.
- `.scanImports(code)` — Faster import-only scan. Useful for dependency validation.

**What Python has instead:** `exec(code, namespace)` and `compile()` — no type awareness, no import scanning, no syntax validation beyond basic Python parsing. `ast.parse()` gives AST but is cumbersome for validation.

**Key advantage:** `Bun.Transpiler.scan()` lets you statically analyze a graph definition's imports and exports BEFORE executing it. You can verify it exports a `graph` function, check it doesn't import forbidden modules, and validate its dependency graph — all without running any user code.

#### 2. `Bun.build({ files })` — In-Memory Virtual Module Bundling

This is the **killer feature** for a graph repository. `Bun.build()` accepts a `files` map of virtual files that don't exist on disk, and resolves their imports against real packages in `node_modules`:

```typescript
const result = await Bun.build({
  entrypoints: ["/graphs/custom-agent.ts"],
  files: {
    "/graphs/custom-agent.ts": userProvidedGraphCode,
    "/graphs/custom-tools.ts": userProvidedToolDefinitions,
  },
  target: "bun",
  // Keep runtime deps external — they're already loaded in the process
  external: [
    "langchain",
    "@langchain/langgraph",
    "@langchain/core",
    "@langchain/openai",
    "@langchain/anthropic",
  ],
});

if (!result.success) {
  // Build errors (syntax, unresolved imports, etc.)
  for (const log of result.logs) {
    console.error(log.message);
  }
  throw new Error("Graph compilation failed");
}

// result.outputs[0] is a fully bundled, dependency-resolved JS module
const bundledCode = await result.outputs[0].text();
```

**What this enables:**
- Virtual files can import OTHER virtual files (multi-file graph definitions)
- Virtual files can import real packages from `node_modules`
- Dependency resolution happens at build time, not execution time
- Build errors surface syntax and import issues before any code runs
- `external` keeps runtime dependencies out of the bundle (they're already loaded)

**What Python has instead:** Nothing comparable. Python's `importlib` can load modules from files, but there's no equivalent of "bundle virtual files with dependency resolution against installed packages." You'd need to write the code to disk, manipulate `sys.path`, and handle imports manually.

#### 3. Plugin API — Custom Module Resolution

Bun's universal plugin system intercepts imports and provides custom loading logic. This could load graph definitions from a database, S3, or API:

```typescript
import { plugin } from "bun";

plugin({
  name: "graph-repository-loader",
  setup(build) {
    // Intercept imports matching *.graph.ts pattern
    build.onLoad({ filter: /\.graph\.ts$/ }, async ({ path }) => {
      const graphId = path.replace(/\.graph\.ts$/, "").split("/").pop();

      // Load graph source from database instead of disk
      const row = await db.query(
        "SELECT source_code FROM graphs WHERE graph_id = $1",
        [graphId]
      );

      if (!row) {
        throw new Error(`Graph '${graphId}' not found in repository`);
      }

      return {
        contents: row.source_code,
        loader: "ts", // Bun transpiles TS natively
      };
    });
  },
});

// Now this works — loads from DB, transpiled by Bun:
const module = await import("./custom-agent.graph.ts");
```

**What Python has instead:** Import hooks via `importlib.abc.MetaPathFinder` / `Loader`. Functional but significantly more boilerplate and no TS transpilation.

#### 4. Workers — Isolated Execution Contexts

User-provided graph code can run in Worker threads for process-level isolation:

```typescript
const worker = new Worker("./graph-sandbox.ts");

worker.postMessage({
  action: "compile",
  graphId: "custom-agent",
  sourceCode: userProvidedCode,
});

worker.onmessage = (event) => {
  if (event.data.success) {
    // Graph compiled successfully in isolated context
    registerGraph(event.data.graphId, event.data.factory);
  }
};
```

**What Python has instead:** `multiprocessing` — heavier, slower to spawn, requires pickling for IPC.

#### 5. Native TypeScript Execution

Bun runs `.ts` files directly — no build step needed at all. Combined with dynamic `import()`:

```typescript
// Write graph code to a temp file (or use Bun.build with virtual files)
await Bun.write("/tmp/graphs/custom.ts", userProvidedCode);

// Import it — Bun transpiles on the fly
const module = await import("/tmp/graphs/custom.ts");
const graphFactory = module.graph; // typed as GraphFactory
```

### Comparison: Bun/TS vs Python for Dynamic Graph Loading

| Dimension | Bun/TS | Python | Winner |
|-----------|--------|--------|--------|
| **Runtime code transformation** | `Bun.Transpiler` — purpose-built, fast, with import scanning | `exec()` / `compile()` — basic, no import analysis | **Bun** |
| **Virtual module bundling** | `Bun.build({ files })` — full dependency resolution for in-memory code | Nothing comparable | **Bun** |
| **Static analysis before execution** | `.scan()` / `.scanImports()` — inspect exports & imports without running | `ast.parse()` — possible but cumbersome | **Bun** |
| **Type safety at load time** | TypeScript types catch errors at transpile time | None — only runtime errors | **Bun** |
| **Execution speed** | JIT-compiled (JavaScriptCore) | Interpreted (CPython) — 5-50× slower | **Bun** |
| **LangGraph ecosystem maturity** | Fewer tools, integrations, examples; some features lag | Mature, larger community, battle-tested | **Python** |
| **MCP tools integration** | Not yet implemented (Goal 26) | Working (remote MCP servers) | **Python** |
| **RAG tool support** | Not yet implemented (Goal 27) | Working (LangConnect) | **Python** |
| **Security of dynamic code** | `eval()` + Workers for isolation | `exec()` — no built-in isolation | **Bun** |
| **Community examples** | Sparse — few production LangGraph JS deployments | Abundant — well-documented patterns | **Python** |
| **Custom module loaders** | Plugin API — clean, universal | Import hooks — verbose but functional | **Bun** |
| **Hot-reload capability** | `import.meta.hot` + module cache invalidation | `importlib.reload()` — fragile | **Bun** |

**Summary:** Bun wins on runtime primitives (6/12). Python wins on ecosystem maturity (4/12). Two are roughly equal. The gap is closing as LangChain invests in the JS SDK.

---

## Proposed Architecture

### System Design

```
┌─────────────────────────────────────────────────────────┐
│                    Graph Repository API                   │
│                                                           │
│  POST /graphs          — Upload graph source (TS/JS)     │
│  GET  /graphs          — List available graphs            │
│  GET  /graphs/:id      — Get graph metadata + source     │
│  PUT  /graphs/:id      — Update graph source             │
│  DELETE /graphs/:id    — Remove graph                    │
│  POST /graphs/:id/test — Dry-run compile + validate      │
└──────────┬──────────────────────────────┬────────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────┐    ┌──────────────────────────────┐
│   Validation Layer   │    │     Compilation Pipeline     │
│                      │    │                              │
│  1. Scan imports     │    │  1. Bun.Transpiler.scan()    │
│  2. Check allowlist  │    │  2. Bun.build({ files })     │
│  3. Verify exports   │    │  3. Import + validate        │
│  4. Size limits      │    │  4. Register in registry     │
└──────────┬───────────┘    └──────────────┬───────────────┘
           │                               │
           ▼                               ▼
┌─────────────────────┐    ┌──────────────────────────────┐
│   Postgres Storage   │    │      Graph Registry          │
│                      │    │                              │
│  graphs table:       │    │  In-memory Map<string,       │
│  - graph_id (PK)     │    │    GraphFactory>              │
│  - source_code (TS)  │    │                              │
│  - compiled_js       │    │  Populated from:             │
│  - metadata (JSON)   │    │  1. Built-in graphs (agent)  │
│  - owner_id          │    │  2. DB on startup            │
│  - created_at        │    │  3. API uploads (hot)        │
│  - updated_at        │    │                              │
│  - version           │    │  Used by:                    │
│  - status (enum)     │    │  - executeRunStream()        │
│  - checksum          │    │  - executeRunSync()          │
└──────────────────────┘    └──────────────────────────────┘
```

### Compilation Pipeline (Detail)

```typescript
// Step 1: Static analysis — validate structure without execution
async function validateGraphSource(sourceCode: string): Promise<ValidationResult> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });

  // Scan exports — must export a `graph` function
  const { exports, imports } = transpiler.scan(sourceCode);
  if (!exports.includes("graph")) {
    return { valid: false, error: "Graph source must export a 'graph' function" };
  }

  // Scan imports — check against allowlist
  const scannedImports = transpiler.scanImports(sourceCode);
  const allowedPackages = new Set([
    "langchain",
    "@langchain/langgraph",
    "@langchain/core",
    "@langchain/openai",
    "@langchain/anthropic",
    "@langchain/google-genai",
  ]);

  for (const imp of scannedImports) {
    if (imp.kind === "import-statement" || imp.kind === "dynamic-import") {
      const isRelative = imp.path.startsWith("./") || imp.path.startsWith("../");
      const isAllowed = allowedPackages.has(imp.path.split("/").slice(0, imp.path.startsWith("@") ? 2 : 1).join("/"));

      if (!isRelative && !isAllowed) {
        return { valid: false, error: `Forbidden import: '${imp.path}'. Only LangChain packages are allowed.` };
      }
    }
  }

  return { valid: true };
}

// Step 2: Compile — bundle with dependency resolution
async function compileGraph(
  graphId: string,
  sourceCode: string,
  additionalFiles?: Record<string, string>,
): Promise<CompilationResult> {
  const files: Record<string, string> = {
    [`/graphs/${graphId}.ts`]: sourceCode,
    ...Object.fromEntries(
      Object.entries(additionalFiles ?? {}).map(
        ([name, code]) => [`/graphs/${name}`, code]
      )
    ),
  };

  const result = await Bun.build({
    entrypoints: [`/graphs/${graphId}.ts`],
    files,
    target: "bun",
    external: [
      "langchain",
      "@langchain/langgraph",
      "@langchain/core",
      "@langchain/openai",
      "@langchain/anthropic",
      "@langchain/google-genai",
    ],
  });

  if (!result.success) {
    const errors = result.logs
      .filter(log => log.level === "error")
      .map(log => log.message);
    return { success: false, errors };
  }

  const compiledJs = await result.outputs[0].text();
  return { success: true, compiledJs };
}

// Step 3: Load — execute compiled code and extract factory
async function loadCompiledGraph(
  graphId: string,
  compiledJs: string,
): Promise<GraphFactory> {
  // Create a data URI module from the compiled JS
  const encoded = Buffer.from(compiledJs).toString("base64");
  const dataUri = `data:text/javascript;base64,${encoded}`;

  const module = await import(dataUri);

  if (typeof module.graph !== "function") {
    throw new Error(`Compiled graph '${graphId}' does not export a 'graph' function`);
  }

  return module.graph as GraphFactory;
}

// Step 4: Register — add to the live graph registry
async function registerDynamicGraph(
  graphId: string,
  sourceCode: string,
): Promise<void> {
  // Validate
  const validation = await validateGraphSource(sourceCode);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.error}`);
  }

  // Compile
  const compilation = await compileGraph(graphId, sourceCode);
  if (!compilation.success) {
    throw new Error(`Compilation failed: ${compilation.errors.join(", ")}`);
  }

  // Load
  const factory = await loadCompiledGraph(graphId, compilation.compiledJs);

  // Register in live registry
  registerGraph(graphId, factory);

  // Persist to database
  await db.query(
    `INSERT INTO graphs (graph_id, source_code, compiled_js, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (graph_id) DO UPDATE
     SET source_code = $2, compiled_js = $3, updated_at = NOW()`,
    [graphId, sourceCode, compilation.compiledJs]
  );
}
```

### Security Model

Dynamic code execution is inherently dangerous. The security model has multiple layers:

| Layer | Mechanism | What It Catches |
|-------|-----------|-----------------|
| **1. Import allowlist** | `Bun.Transpiler.scanImports()` | Blocks `fs`, `child_process`, `net`, `http`, arbitrary npm packages |
| **2. Export validation** | `Bun.Transpiler.scan()` | Requires `graph` export conforming to `GraphFactory` type |
| **3. Size limits** | Pre-check source code length | Prevents DoS via massive code uploads |
| **4. Build isolation** | `Bun.build()` with `external` deps | Only allows LangChain packages; no arbitrary dependency installation |
| **5. Execution isolation** | Worker threads (future) | Sandbox execution context with limited globals |
| **6. Tenant scoping** | `owner_id` on graphs table | Users can only load/modify their own graphs |
| **7. Rate limiting** | API-level rate limits | Prevents compilation DoS |

**Known risks and honest limitations:**
- `eval()` / `new Function()` / `import()` of dynamic code can always escape sandboxes given sufficient creativity
- Workers provide isolation but share the process — a crash in a Worker can still affect the main process
- The import allowlist is a heuristic, not a guarantee — determined attackers could find ways around it
- For truly untrusted code, a separate process or container per execution would be needed (significant complexity)
- **Recommendation:** Start with trusted-user-only access (admin/developer role). Expand to tenant-scoped access only after thorough security review.

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS graphs (
  graph_id      TEXT PRIMARY KEY,
  source_code   TEXT NOT NULL,           -- Original TypeScript source
  compiled_js   TEXT,                     -- Bundled JavaScript (cached)
  metadata      JSONB DEFAULT '{}'::JSONB,-- Description, author, tags, etc.
  owner_id      UUID,                     -- Tenant scoping (from auth)
  status        TEXT DEFAULT 'active',    -- active | disabled | error
  version       INTEGER DEFAULT 1,
  checksum      TEXT,                     -- SHA-256 of source_code
  error_message TEXT,                     -- Last compilation error (if status='error')
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_graphs_owner ON graphs(owner_id);
CREATE INDEX idx_graphs_status ON graphs(status) WHERE status = 'active';
```

---

## Phased Implementation Plan

### Phase 1: File-Based Dynamic Loading (Low Risk)

**Effort:** Small — extends existing graph registry
**Dependencies:** None (works with v0.0.1 in-memory runtime)

- Add `GRAPH_DIR` env var pointing to a directory of `.ts` graph files
- On startup, scan directory and `import()` each file
- Register discovered graphs alongside built-in `"agent"` graph
- No API, no compilation — just file-based discovery
- **Already supported by Bun** — native TS import, no transpiler needed

```typescript
// On startup:
const graphDir = process.env.GRAPH_DIR;
if (graphDir) {
  for (const file of fs.readdirSync(graphDir)) {
    if (file.endsWith(".ts") || file.endsWith(".js")) {
      const graphId = file.replace(/\.(ts|js)$/, "");
      const module = await import(path.join(graphDir, file));
      if (typeof module.graph === "function") {
        registerGraph(graphId, module.graph);
      }
    }
  }
}
```

### Phase 2: API-Driven Upload + Compilation (Medium Risk)

**Effort:** Medium
**Dependencies:** Goal 25 (Postgres persistence, auth)

- Add `/graphs` CRUD endpoints
- Implement validation → compilation → loading pipeline
- Store source + compiled JS in Postgres
- Load persisted graphs on startup
- Hot-register via API without restart
- Import allowlist security layer

### Phase 3: Multi-File Graphs + Worker Isolation (Higher Risk)

**Effort:** Large
**Dependencies:** Phase 2

- Support multi-file graph uploads (tarball or JSON manifest)
- `Bun.build({ files })` for multi-file virtual bundling
- Worker-based execution isolation
- Graph versioning with rollback
- Graph dependency management (one graph importing another)

### Phase 4: Plugin-Based DB Loader (Advanced)

**Effort:** Medium
**Dependencies:** Phase 2

- Bun Plugin that intercepts `import("graphs://custom-agent")` and loads from DB
- Transparent to graph code — standard import syntax
- Enables graphs that import other graphs naturally
- Cache compiled JS in-process with invalidation on update

---

## Tasks

| Task ID | Description | Status | Phase | Depends On |
|---------|-------------|--------|-------|------------|
| Task-01 | Research: Bun runtime compilation capabilities | 🟢 Complete | 0 | — |
| Task-02 | Research: Security model for dynamic code execution | 🟢 Complete | 0 | — |
| Task-03 | Research: Comparison with Python dynamic loading | 🟢 Complete | 0 | — |
| Task-04 | Implement `GRAPH_DIR` file-based discovery | ⚪ Not Started | 1 | — |
| Task-05 | Add graph validation layer (scan imports/exports) | ⚪ Not Started | 2 | Task-04 |
| Task-06 | Implement `Bun.build({ files })` compilation pipeline | ⚪ Not Started | 2 | Task-05 |
| Task-07 | Add `/graphs` CRUD API endpoints | ⚪ Not Started | 2 | Task-06, Goal 25 |
| Task-08 | Postgres schema + startup loading | ⚪ Not Started | 2 | Task-07 |
| Task-09 | Multi-file graph uploads | ⚪ Not Started | 3 | Task-08 |
| Task-10 | Worker-based execution isolation | ⚪ Not Started | 3 | Task-08 |
| Task-11 | Bun Plugin for DB-backed module loader | ⚪ Not Started | 4 | Task-08 |

---

## Success Criteria

- [ ] User can upload a TypeScript graph definition via API
- [ ] Graph is validated (imports allowlisted, exports correct) before compilation
- [ ] Graph is compiled via `Bun.build({ files })` with dependency resolution
- [ ] Compiled graph is loaded and registered in the live graph registry
- [ ] Graph persists in Postgres and is loaded on server restart
- [ ] Graph can be updated via API without server restart
- [ ] Built-in graphs (`"agent"`) continue to work unchanged
- [ ] Compilation errors return clear, actionable error messages
- [ ] Security: forbidden imports are blocked at scan time
- [ ] Phase 1 (file-based) works standalone without Postgres

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Security escape via dynamic code execution | Critical | Medium | Import allowlist + Worker isolation + trusted-user-only access initially |
| LangGraph JS ecosystem gaps block graph definitions | High | Medium | Maintain Python runtime as primary; TS graphs are opt-in |
| `Bun.build({ files })` API changes in future Bun versions | Medium | Low | Pin Bun version; virtual files API is stable since 1.2+ |
| Memory leaks from hot-reloading compiled modules | Medium | Medium | Track loaded modules, implement garbage collection on graph deletion |
| Data URI imports may not work for all module patterns | Medium | Low | Fall back to temp file + dynamic import if data URI fails |
| Performance overhead of compilation on upload | Low | Low | Cache compiled JS; recompile only on source change (checksum) |

---

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-07-20 | Create separate goal for dynamic graph repository | This capability goes beyond Python feature parity — it's a differentiator for the TS runtime |
| 2025-07-20 | Phased approach starting with file-based loading | Lowest risk, immediate value, doesn't require Postgres or auth |
| 2025-07-20 | Import allowlist as primary security mechanism | `Bun.Transpiler.scanImports()` is the only reliable way to analyze code without executing it; more practical than full sandboxing |
| 2025-07-20 | `Bun.build({ files })` over `Bun.Transpiler` + `eval()` for compilation | Build API handles dependency resolution and multi-file bundling; Transpiler alone only does TS→JS without resolving imports |
| 2025-07-20 | Start with trusted-user access only | Full sandboxing of arbitrary user code is a hard security problem; deferring to later phase |

### Open Questions

- [ ] Does `import()` of data URIs work reliably in Bun for modules with side effects? Need to test with LangGraph-specific patterns.
- [ ] Can `Bun.build({ files })` resolve imports from the current process's `node_modules` when building virtual files? (Likely yes based on docs, needs verification.)
- [ ] What happens when a dynamically loaded graph throws during `invoke()`? Does it crash the Worker, or is the error contained?
- [ ] How does Bun handle module cache invalidation for data URI imports? If we re-import the same URI with different content, do we get the new version?
- [ ] Should graph definitions be versioned with semver, or simple auto-incrementing integers?
- [ ] Could the Bun Plugin approach (Phase 4) replace Phases 2-3 entirely? It might be simpler.
- [ ] Is there a maximum code size for `Bun.build({ files })` virtual files?

---

## References

- [Bun Transpiler API](https://bun.com/docs/runtime/transpiler) — `Bun.Transpiler`, `.transformSync()`, `.scan()`, `.scanImports()`
- [Bun Bundler API — Virtual Files](https://bun.com/docs/bundler/index) — `Bun.build({ files })` in-memory bundling
- [Bun Plugin API](https://bun.com/docs/runtime/plugins) — Universal plugin system, `build.onLoad()`
- [Bun Workers](https://bun.com/docs/runtime/workers) — Worker threads for isolation
- [Bun Hot Reloading](https://bun.com/docs/bundler/hot-reloading) — `import.meta.hot.data` for stateful hot replacement
- [Bun Macros](https://bun.com/docs/bundler/macros) — Build-time code execution (related pattern)
- [Current graph registry](../../apps/ts/src/graphs/registry.ts) — Existing `registerGraph()` / `resolveGraphFactory()` API
- [Current graph factory](../../apps/ts/src/graphs/react-agent/agent.ts) — Example of a `GraphFactory` implementation
- [LangChain JS createAgent](https://js.langchain.com/docs/modules/agents/) — Agent creation API
- [Python dynamic loading comparison](https://docs.python.org/3/library/importlib.html) — `importlib` for reference