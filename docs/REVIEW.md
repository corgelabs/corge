# Corge SDK (`@corgelabs/corge`) — Code Review Prompt

Run a full code review of the standalone **Corge SDK & CLI repository** at current workspace directory. Cover architecture, distributed systems, serverless security, performance, resilience, portability, packaging, and DX.

> [!IMPORTANT]
> **SCOPE & READ-ONLY RULES**
> - **Scope**: Review **only** the `corgelabs/corge` repo:
>   - `src/index.ts`, `src/config.ts`
>   - The 11 runtime domains: `src/{ai,attachments,auth,chat,db,emails,files,payments,router,tasks,utils}/**`
>   - The CLI: `bin/corge.ts` and `src/cli/**`
>   - Base templates: `infra/{firestore.base.rules,storage.base.rules,firestore.base.indexes.json}`
>   - Tests: `tests/e2e.test.ts`
>   - Manifests and CI: `package.json`, `tsconfig*.json`, `.github/workflows/publish.yml`
>   - Docs: `README.md`, `docs/SPEC.md`
>
>   Consumer apps are **out of scope**. Only check that the SDK has zero coupling to them: no consumer business logic, no machine-local paths, no hardcoded GCP project or service-account IDs, and no consumer path aliases.
> - **Read-only**: **DO NOT change, refactor, or fix any source, CLI, infra, config, test, or existing doc file.** Do not commit, push, publish, or deploy. Do not run `npm test` or `corge test`: they bundle a consumer app and call live GCP.
> - **Output**: Your **only** file write is the report at **`docs/code-reviews/<YYYY-MM-DD_HH-MM>.md`**. Use the current local date and time in the filename (e.g. `docs/code-reviews/2026-11-15_03-45.md`).

---

## Step 1: Read the Source-of-Truth Files

1. `docs/SPEC.md`. It covers:
   - the architecture and the 4-tier visibility model
   - the flat domain map
   - the `CoreClient` surface map (§3.1)
   - the `corge.internals.*` map (§3.2)
   - `CORGE_ROUTE_DEFAULTS` (§3.3)
   - the in-memory registries and caches (§3.4)
   - the per-function contracts
2. `README.md`: the public promise of the SDK and the consumer quick-start.
3. `src/index.ts` and `src/config.ts`:
   - `Corge` class composition, the `corge` singleton, `useCorge()`, `runWithCorge`
   - `AsyncLocalStorage` state
   - `corge.internals`, `corge.types`, `corge.schemas`, `corge.define`
   - `CORGE_CONFIG`, `defineConfig()`, `AppBindings`, `DbRole`, `DbAction`
4. `package.json`, `tsconfig.base.json`, `tsconfig.build.json`, `tsconfig.json`, `.github/workflows/publish.yml`:
   - npm `exports`, `files`, `bin`, `engines`
   - `.d.ts` output with `declarationMap`
   - the esbuild ESM bundle for Node 24
   - the release pipeline
5. `bin/corge.ts`, `src/cli/*`, `infra/*`:
   - the CLI lifecycle (`dev`, `build`, `deploy`, `test`, `check`, `init`, `link`, `unlink`, `env`)
   - the base Firestore and Storage rules and indexes that `corge deploy` merges into consumer projects

---

## Step 2: Run Non-Destructive Automated Checks

Run these from the repo root. Paste their exact output into the report.

```bash
# 0. Baseline: commit, branch, version, clean tree
git rev-parse HEAD && git branch --show-current && node -p "require('./package.json').version" && git status --porcelain

# 1. File tree + flat-domain check (expected: no nested dirs inside src/<domain>/)
find src bin infra tests -type f | sort && find src -mindepth 2 -type d

# 2. Cross-domain encapsulation: outside a domain, imports must target '../<domain>' (its index.ts), never deep files
grep -rnE "from ['\"](\.\./[a-z-]+/|@corge/|@corgelabs/corge/)" src/ bin/ || true

# 3. Standalone portability: no consumer aliases, machine-local paths, or hardcoded GCP projects/service accounts
grep -rnE "from ['\"]@(config|routes|services|utils|app-entry)" src/ bin/ || true
grep -rnE "/Users/|/home/[a-z]+/|[0-9]{10,}-compute@|@[a-z0-9-]+\.iam\.gserviceaccount\.com|projects/[a-z][a-z0-9-]{4,}/" src/ bin/ infra/ || true

# 4. Runtime (non-type) imports of the root barrel from inside domains (circular ESM init / TDZ risk)
grep -rnE "^import \{[^}]*\} from ['\"]\.\./index['\"]" src/ | grep -v "import type" || true

# 5. CLI code leaking into the runtime bundle (cold-start risk: esbuild, child_process, fs spawners)
grep -nE "from ['\"]\./cli" src/index.ts; grep -nE "^import" src/cli/*.ts | grep -E "esbuild|child_process|node:fs"

# 6. 500 LOC hard cap: all .ts files sorted by LOC (> 500 = P1, 451–500 = P2 watchlist)
find src bin tests -name '*.ts' -exec wc -l {} + | sort -nr

# 7. Strict type check + production SDK/CLI build + npm tarball contents (dry run, writes nothing)
npm run check && npm run build && npm pack --dry-run
```

---

## Step 3: Audit Across 8 Pillars

### Pillar 1: SDK Philosophy, Flat Domain Barrels & 4-Tier Visibility

The **runtime domains** are `ai`, `attachments`, `auth`, `chat`, `db`, `emails`, `files`, `payments`, `router`, `tasks`, `utils`. `src/index.ts`, `src/config.ts`, and `src/cli/**` are **non-domain modules**: the CLI is tooling, not a domain, and does not need a barrel.

**Flat domain layout.** Each domain is one flat directory with no subfolders, and every file is `<= 500 LOC`:
- **`index.ts` (required)**: the domain's only public boundary. It re-exports `<Domain>Service`, the `define*` builders, public schemas and types, and the built-in route maps. All cross-domain imports go through `'../<domain>'` only.
- **`schema.ts` (required)**: Zod schemas, static types, `define*` builders, and static registries/defaults only. **No runtime helper functions.**
- **`service.ts` (required)**: the `<Domain>Service` facade, holding `readonly #corge: Corge`.
- **`routes.ts` (optional)**: built-in HTTP, workflow, SSE, OpenAI, MCP, and webhook routes.
- **`utils.ts` (optional)**: pure, stateless helpers that never need `this.#corge`, such as:
  - parsers and formatters
  - scoring
  - HMAC and encoding
  - URL and MIME validators
  - provider wire helpers
- **Flat sibling sub-engines**, for example:
  - `auth/{session,oidc,recovery}.ts`
  - `chat/{context,stream}.ts`
  - `tasks/{steps,worker,watcher}.ts`
  - `payments/billing.ts`
  - `router/guard.ts`

  Each holds `readonly #corge: Corge`, is composed in `service.ts`, and is **never** exported from `<domain>/index.ts`.

Also confirm there are:
- no circular factory callbacks
- no legacy wrappers
- no deprecated aliases (`Core`/`core`/`useCore` leftovers from the v2.0.0 rename)

**4-tier visibility:**
1. **Public: `corge.<domain>.*` and `corge.define.*`.** Arrow methods with **explicit return types** (prevents TS7022 circular inference).
2. **Internal: `corge.internals.*`.** Groups: `resilience`, `context`, `registry`, `workflows`, `auth`, `emails`, `payments`. These are kept off public surfaces with `Omit<*Service, 'internals'>`.
3. **Domain barrel exports.** Consumed only by `src/index.ts` and other cross-domain barrels.
4. **Domain-private.** `#private` members and sibling files, invisible outside `src/<domain>/`.

**Ambient context:**
- Services and sub-engines read `this.#corge.env`, `.userId`, `.role`, `.caller`, `.step` directly. No manual `(env, userId, role, step)` parameter threading.
- Cross-domain calls go only through `this.#corge.<sibling>.*` or `this.#corge.internals.*`, so scoped `useCorge()` instances stay fully isolated.
- **No module-load-time `corge.*` side effects.** Use check #4 to judge the risk of domain files importing the `corge` / `Corge` *values* from `'../index'` instead of `import type`: ESM init order, TDZ, and tree-shaking.

### Pillar 2: Distributed Systems Correctness & Anti-Patterns

**Epoch fencing.** Workflows keep monotonic `epoch`, `activeRunId`, and `lastHeartbeatAt` on every checkpoint, heartbeat, signal, and terminal transition. They throw `StaleWorkerEpochError` as soon as they are superseded.

**Idempotency.** HTTP, workflow, email, and payment mutations use deterministic dedupe keys and `runTransaction`:
- `_idempotency`
- `_tasks`
- `email_log` and `payment_transaction` IDs from provider event IDs

Check these especially closely:
- billing quota checks
- bonus credit and token consumption
- usage metering
- webhook state reconciliation

None may double-apply when the provider retries.

**Singleflight.** Request coalescing prevents stampedes. `'global'` scope callbacks run in a neutral admin `AsyncLocalStorage` context, so caller identity and env never bleed between callers.

**Sagas.** Reverse-order compensations run on failure or cancel. Check:
- `allWithRollback`
- `FilesService.upload` and `FilesService.hardDelete`
- multi-step billing and subscription provisioning
- auth provisioning

**Firestore map hygiene.** Rollbacks of `_tasks` use `mergeFields`, not `{ merge: true }`, when clearing the `steps` and `compensations` keys.

**Retry classification.** Poison pills skip retries: `NonRetryableError`, `ZodError`, and 4xx `HTTPException`. Transient errors use bounded exponential backoff with jitter.

**Anti-patterns to flag:**
- N+1 calls to Firestore, GCS, or providers
- unbounded `Promise.all` fan-out that bypasses `runChunked`
- sticky in-memory state with no Firestore sync or watermark
- event-loop-blocking synchronous CPU or I/O on hot paths
- swallowed errors
- un-awaited promises
- missing `AbortSignal` propagation

### Pillar 3: Serverless Security, RBAC, Webhooks, Cryptography & Data Hygiene

**Defense-in-depth RBAC (zero IDOR).** Authorization must be enforced in two places:
- **Transport guards** (`router/guard.ts`):
  - `auth: 'public' | 'user' | 'strict' | 'admin'`
  - `guard: { checkFileRef, checkCollectionField, checkUserId, requireEmailVerified, custom }`
- **Data and service layer**:
  - the `DbService` role × ownership matrix (`any` vs `own`, `#isEntryOwner`)
  - `FilesService.#assertAccess`
  - ownership checks for task, chat, `email_log`, `payment_customer`, and `payment_usage`

**MCP and agents.** MCP exposure is opt-in (`mcp: false` by default). Agent `toolPresets` and `activeTools` respect the caller's permissions.

**Secrets and webhooks:**
- Every comparison of secrets, `SDK_API_KEY`, or webhook signatures uses `crypto.timingSafeEqual` on fixed-length digests, so there is no length-oracle timing leak. That covers:
  - `Stripe-Signature`
  - Dodo Payments and Resend Svix `webhook-signature`
  - SendGrid HMAC
- `webhookToleranceSeconds` enforces a replay window.
- Sandbox and production secrets are strictly separated (`isDev`).
- HMAC verification exists in exactly one canonical helper.

**Tokens:**
- OTPs, magic links, and recovery tokens come from a CSPRNG (`crypto.randomInt` / `randomBytes`).
- They are stored only as SHA-256 hashes in `auth_tokens`.
- TTL and attempt caps are enforced inside transactions.
- Public endpoints (`forgotPassword`, `initiateAccountRecovery`) are enumeration-safe.

**OIDC (`auth/oidc.ts`):**
- RS256 JWK signature verification
- `iss`, `aud`, and `exp` enforcement
- verified-email requirement before account linking
- a bounded JWK cache

**Revocation.** `_system/auth_revocations` watermarks evict in-memory token caches across instances within a bounded interval.

**Input/output hardening:**
- **Content-addressed `FileRef`** (`<userId>_<sha256_24>`): O(1) `canAccessFile`, byte limits, and magic-byte MIME validation, including when email attachments are resolved.
- **`corge.db.update`** strips `id`, `createdAt`, `updatedAt`, `deleted`, `userId`, and the custom `userRelation.userField` before partial Zod validation.
- **Client IP** comes from the second-to-last `X-Forwarded-For` entry (`.at(-2)`), which is spoof-resistant behind GCP LB / Cloud Run.
- **Outbound fetches** (Jina, attachments, webhooks, provider callbacks) go through `isSafePublicUrl`:
  - HTTPS only
  - blocks localhost, RFC1918, link-local, and cloud-metadata IPs, and internal TLDs
- **Redirect URLs** for checkout, billing portal, OIDC, and magic links are allow-listed to prevent open redirects.

**Infra base rules and indexes:**
- `infra/*.base.rules` deny all direct client access to server-only collections:
  - `user_auth_meta`, `auth_tokens`
  - `email_log`, `email_suppression`
  - `payment_customer`, `payment_usage`, `payment_transaction`
  - `_tasks`, `_idempotency`, `_system`
- The rules enforce least privilege and tenant isolation, and stay safe when merged with consumer rules.
- `firestore.base.indexes.json` covers every composite query the SDK issues.

**GDPR.** `corge.auth.eraseUser` cascades durably across:
- `file` (GCS and Firestore)
- `chat` and its `messages` subcollections
- `_tasks` and the `_tasks/${taskId}/` claim-check blobs
- email and payment user records
- custom user collections
- `auth_tokens` and `user_auth_meta`
- Firebase Auth

**CLI security** (`src/cli/**`, `bin/corge.ts`):
- `child_process` use has no shell injection: args arrays, no interpolated `shell: true`.
- `corge env` never logs or persists secrets.
- `init`, `link`, and `unlink` never write outside the consumer project.

### Pillar 4: Performance & Scalability

**O(1) hot paths, with hard max-key eviction so warm instances cannot OOM:**
- `acquireHttpLimit`
- the `RateLimiter` token buckets for `mistral`, `jev`, `ai`, `workflows`, `firestore`, `storage`, `emails`, `payments`
- the LRU caches (`tokenCache`, JWK, circuit breaker)

**Batching:**
- `getAll` preloading in `AttachmentsService.process`
- parallel ownership checks
- `runChunked` bounded concurrency
- batched deletes drained in `<= 500`-doc chunks with no truncation

**Pagination.** `corge.db.list` and `listPage` use deterministic total ordering (`FieldPath.documentId()` as tie-breaker). The missing-index fallback keeps the `deleted == false` and ownership filters.

**Claim-check offloading.** `#maybeOffloadStepValue` and `#maybeHydrateStepValue` kick in above 200 KiB per value or 150 KiB cumulative, so `_tasks/{taskId}` never nears Firestore's 1 MiB limit.

**Cloud Tasks.** Collision-free round-robin sharding over `0..defaultShardsCount-1`.

**Metering.** `autoTrackAiTokens` and `enforceAiQuota` / `trackAiUsage` add minimal latency. They never drop or double-count usage across retries, streams, or aborted turns.

**Cold starts:**
- Lazy init of all heavy clients:
  - Firestore and Bucket
  - Vertex, Mistral, Jev
  - Stripe and Dodo
  - Resend and SendGrid
- No heavy work at module load in `dist/index.js`.
- `src/index.ts` must not pull CLI-only dependencies (`esbuild`, `child_process` spawners) into Cloud Functions. Use check #5 to verify the `./cli/env` re-export.

### Pillar 5: Resilience & Fault Tolerance

**Upstreams.** All external calls run inside distributed 3-state circuit breakers (`_system/breaker_*`), with sliding-window rate limiters and explicit `AbortSignal` timeouts. This covers:
- AI: `vertex`, `mistral`, `jev`, `jina`
- identity: `identitytoolkit`, OIDC
- email: `resend`, `sendgrid`
- payments: `stripe`, `dodo`

**Graceful fallbacks:**
- Mistral OCR → Vertex Vision
- vector recall → lexical or sliding window
- Resend ↔ SendGrid failover
- hard-bounce and spam suppression via `email_suppression`

**Budget yielding.** Workflows checkpoint and yield (`continueAsNew` / `TaskYieldSignal`) at 75% of the Cloud Functions timeout.

**Watcher hygiene:**
- `watchTask` multiplexes `onSnapshot`, fallback polling, and hedging.
- It detaches to `202 Accepted` on `Prefer: respond-async`, `?wait=false`, or `maxWaitMs`.
- Every listener and timer is cleaned up in `finally` (`getActiveWatcherCount() === 0`).
- The dev email outbox is bounded.

**CLI crash safety.** `corge deploy` (`src/cli/deployer.ts`) must back up and restore the consumer's files across errors, `SIGINT`, and `SIGTERM` with no partial corruption or race. The files are:
- `package.json`, `firebase.json`
- `firestore.rules`, `storage.rules`, `firestore.indexes.json`

`dev-server` must shut down cleanly.

### Pillar 6: Type Safety, Portability & SPEC Sync

**Type safety:**
- `strict`, `noUncheckedIndexedAccess`, and `import type` everywhere.
- No `any` and no blind `as` casts. Audit the `any` defaults in the `corge.types` generics.
- `.d.ts` files and `declarationMap` resolve cleanly to `src/**`.
- The `declare module '@corgelabs/corge' { interface Register }` augmentation works end to end.

**Portability.** Use check #3 to flag anything that breaks third-party projects:
- machine-local paths
- hardcoded GCP project or compute service-account IDs
- consumer path aliases

For `tests/e2e.test.ts`, check that the consumer-provided aliases (`@config/*`, `@app-entry`) are documented and kept apart from the runtime code.

**SPEC drift.** Diff the code against `docs/SPEC.md`, one key at a time:
- the **actual keys of `corge.internals`** in `src/index.ts` vs the §3.2 table (every `context.*` and `registry.*` entry)
- the **actual route count of `CORGE_ROUTE_DEFAULTS`** vs §3.3 and every other place a count is stated
- the **built-in collection count** vs §3.2 / §3.4
- the `CoreClient` surface vs §3.1
- method signatures
- leftovers caught by check #7

Also check `README.md` for the same kinds of drift.

### Pillar 7: Packaging, CLI & Release Pipeline

**npm contract:**
- `exports` (`.`, `./tsconfig.base.json`, `./spec`), `main` / `types`, and the `bin` entry
- the `.d.ts` output matches the esbuild bundle
- `--packages=external` behaves correctly
- the `files` allowlist: should `src` and `tests` ship?
- tarball size and contents, from `npm pack --dry-run`

**Dependency hygiene:**
- Classify each dependency correctly as runtime, build-time, or peer (e.g. `esbuild`, `firebase-functions`, `typescript`).
- No unused dependencies.
- Use sensible ranges.

**Release workflow (`publish.yml`):**
- semver bump logic
- the race when pushing tags
- whether the `[skip ci]` guard can loop
- npm provenance (`id-token: write` together with `--provenance`)
- build and type-check gates before the version bump

**CLI DX.** For `dev`, `build`, `deploy`, `test`, `check`, `init`, `link`, `unlink`, and `env`, check:
- consistent errors and exit codes
- help text that matches actual behavior
- idempotent `init` and `link`
- `deploy` merges base and consumer rules and indexes deterministically

### Pillar 8: DX, Simplification, DRY & "Less Code Is Better"

**500 LOC hard cap.** Applies to every `.ts` file in `src/**` and `bin/**`:
- Any file over 500 LOC is a **P1** finding.
- Aim for `200–450 LOC`, so one `read_file` / `edit_file` call can cover a file.
- Use check #6 to list every file at 451–500 LOC as a **P2 watchlist** item. For each, give a pre-emptive plan in this order:
  1. compress with in-code DRY and simplification
  2. extract stateless helpers into `<domain>/utils.ts`
  3. split into flat sibling sub-engines composed by `service.ts`

**Method ceiling.** Aim for under 40–50 LOC per method, with a hard ceiling of `75 LOC`. For every method over the ceiling, show how to break it into sub-engine methods, `utils.ts` functions, or `#private` helpers.

**Less code.** Flag:
- pass-through wrappers and ceremony
- needless indirection
- verbose branching
- vertical formatting bloat, e.g. the verbose `import('./...')` re-declarations in the `corge.types` namespace in `src/index.ts`
- intermediate variables that idiomatic TS can remove (`const` arrows, early returns, conditional spreading, destructuring, `??`)
- dead code, unused exports, unreachable branches
- vestigial config keys
- back-compat shims (zero back-compat policy)

**Radical DRY:**
- The `rest`, `workflow`, agent-tool, OpenAI (`/v1/chat/completions`), and MCP (`/api/mcp`) execution paths share no duplicated logic.
- Collapse these repeated patterns into parameterized provider and flow primitives:
  - Stripe vs Dodo REST and webhook ceremony in `payments`
  - Resend vs SendGrid dispatch and webhook verification in `emails`
  - OTP, recovery, and verification flows in `auth`
  - fenced updates and claim-check hydration in `tasks`
  - stream, context, and tool wiring in `chat`
- Each of these has exactly one canonical home:
  - `toHttpError`
  - `resolveUserRole`
  - HMAC timing-safe verification
  - RAG context injection
  - GCS V4 signing
  - retry/backoff
- Schemas are defined once in Zod and inferred everywhere:
  - `z.infer`
  - `SelectModel<N>`, `InsertData<N>`, `UpdateData<N>`
  - `corge.schemas.*`, `corge.types.*`

**Consumer DX:**
- One-call ergonomics and sensible defaults for `corge.<domain>.*`, `corge.define.*`, `defineConfig`, `useCorge()`, and the CLI.
- Self-documenting names, with JSDoc only on public contracts and invariants.
- Formatting: no semicolons, single quotes, no trailing commas, 2-space indent, ~120 cols.

---

## Step 4: Write `docs/code-reviews/<YYYY-MM-DD_HH-MM>.md`

Every file or symbol you reference must be a clickable link.

1. **Header**:
   - date
   - commit SHA and branch
   - `package.json` version
   - total LOC audited (`src`, `bin`, `tests`)
   - scope summary
2. **Executive summary and 10-dimension scorecard** (`0.0–10.0` each):
   1. Flat Domain Topology (barrels, flat siblings, 500 LOC cap)
   2. 4-Tier Visibility & Encapsulation (`#corge` / `#private`, TDZ-safe imports)
   3. Consumer DX & Declarative Ergonomics (SDK API + CLI)
   4. Code Cleanness, Simplification, DRY & "Less Code Is Better"
   5. Distributed Systems Correctness (fencing, sagas, idempotency, singleflight, metering)
   6. Security, RBAC, Webhooks, Cryptography & Tenant Isolation (incl. CLI and infra rules)
   7. Performance & Algorithmic Efficiency (O(1) paths, batching, claim-check)
   8. Scalability & High-Load Throughput (sharding, cold starts, quotas)
   9. Resilience, Fault Tolerance & Crash Safety (breakers, fallbacks, zero leaks, deploy restore)
   10. Portability, Type Safety, SPEC Sync & npm Packaging/Release Readiness

   Close the section with the **Overall Readiness Score (`X.XX / 10`)** and the counts of `P0`, `P1`, `P2`, and `P3` findings.
3. **Automated check outputs**: the exact results of the Step 2 commands.
4. **Pillar-by-pillar analysis (1–8)**: verified strengths with `file://` links, plus observations.
5. **500 LOC and simplification blueprint**:
   - **5.1 Module LOC health matrix**: for each domain and non-domain module, give:
     - current files and LOC
     - headroom to 500
     - barrel and import compliance
     - target compression or flat-sibling splits, with every resulting file `<= 500`
   - **5.2 Method-level simplification and DRY table**: for each item, give:
     - file, method, and lines (`file://` link with current LOC)
     - the bloat, duplication, or ceremony pattern
     - the simplified or DRY blueprint
     - estimated LOC saved (`-X LOC`)
6. **Prioritized findings (`P0` → `P3`)**: for each finding, give:
   - ID and severity (`[P0-1]` …)
   - file and line range as a `file://` link
   - pillar or category
   - root cause and impact
   - **proposed fix** as an exact diff or snippet (do **not** apply it)
7. **SPEC and docs drift matrix**: a table of every discrepancy between `src/**`, `bin/**`, `infra/**` and `docs/SPEC.md` / `README.md`. Include:
   - `corge.internals` key gaps
   - route and collection count mismatches
   - broken anchors
   - `Core` / `core.*` leftovers
   - signature mismatches
