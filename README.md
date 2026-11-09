<div align="center">

<img src="https://raw.githubusercontent.com/corgelabs/corge/main/assets/corgelabs-logo.svg" alt="Corge — The All-in-One AI & SaaS Backend" width="680" />

### The All-in-One AI & SaaS Backend Built for Agentic Coding.

Stop stitching 10 SDKs together. **Auth, DB, Storage, Payments, Emails, Multimodal AI, Hybrid RAG, and Durable Workflows**—all in one `core` singleton your AI agent masters in one read.

[![npm version](https://img.shields.io/npm/v/@corgelabs/corge?color=f59e0b&label=%40corgelabs%2Fcorge)](https://www.npmjs.com/package/@corgelabs/corge)
[![Node.js 24+](https://img.shields.io/badge/NodeJS-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![GCP Cloud Functions](https://img.shields.io/badge/GCP-Cloud_Functions-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/functions)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b.svg)](https://opensource.org/licenses/MIT)

[Why Corge?](#-1-package-replaces-10) · [Agentic Setup](#-agentic-setup-5-seconds) · [30s Quickstart](#-30-second-quickstart) · [CLI](#-built-in-corge-cli) · [Specification](./docs/SPEC.md)

</div>

---

## 🔥 1 Package Replaces 10

AI coding agents hallucinate when juggling 10 different SDKs and 10,000 lines of glue code. **Corge collapses the entire SaaS & AI stack into one declarative API (`core.define.*`)**:

- **Zero Context-Window Bloat**: Only `1` runtime dependency in `package.json` and `1` self-contained spec (`node_modules/@corgelabs/corge/docs/SPEC.md`).
- **Production-Hardened Out of the Box**: Multi-tenant RBAC, content-addressed storage, Stripe/Dodo webhooks, SendGrid/Resend bounce suppression, and adaptive `200`/`202` durable workflows with Saga rollback.
- **`<1s` Typecheck + `F12` Into Raw Source**: Ships pre-compiled `.d.ts` sourcemaps wired straight to `src/**/*.ts` plus a zero-config `corge deploy` CLI.

| What You Need | The Old Way (10+ SDKs & Glue) | With `@corgelabs/corge` |
| :--- | :--- | :--- |
| **API & Guards** | Hono/Express + custom auth, CORS, rate limits | `core.createApp()` + `core.define.routes()` |
| **Durable Workflows** | Temporal / Inngest / BullMQ + Redis workers | `mode: 'workflow'` + `step()` with Saga rollback |
| **AI, RAG & MCP** | Vercel AI + OCR + vector DB + custom MCP | `core.ai`, `core.chat`, `core.attachments` + `mcp: true` |
| **Database & RBAC** | Raw Firestore + manual converters & ACLs | `core.db` + `core.define.collections()` |
| **File Storage** | Raw GCS + manual MIME & ownership checks | `core.files` (`{userId}_{sha256}` $O(1)$ ACLs + magic bytes) |
| **Auth & OIDC** | Custom JWTs, Google/Apple OAuth, revocation | `core.auth` (Cookies, OIDC, 3s revocation watermark) |
| **Payments & Quotas** | Stripe / Dodo SDKs + webhooks + token meters | `core.payments` (Plans, Webhooks, AI Token Quotas) |
| **Emails** | SendGrid / Resend + bounce suppression tables | `core.emails` (Zod templates, attachments, auto-suppression) |
| **Dev & Cloud Deploy** | Custom bundlers, Secret Manager & CI scripts | `npx corge dev` · `corge deploy` · `corge test` |

---

## 🤖 Agentic Setup (5 Seconds)

Drop this into your repo's `AGENTS.md`, `CLAUDE.md`, or `.gemini/GEMINI.md` so Codex, Claude Code, Antigravity, or other harness one-shots production features on the first prompt:

```markdown
## Backend Rules (@corgelabs/corge)
- Read `node_modules/@corgelabs/corge/docs/SPEC.md` before writing backend code.
- Use `core` and `useCore` from `@corgelabs/corge` for all routes, DB, AI, auth, files, payments, and emails.
- Keep `src/` 100% declarative (`core.define.*`) and wrap multi-step mutations in `step()` with `rollback`.
```

---

## 🚀 30-Second Quickstart

```bash
npm i @corgelabs/corge && npx corge init
```

```ts
// src/index.ts
import { core } from '@corgelabs/corge'
import { z } from 'zod'

const collections = core.define.collections({
  invoice: core.define.collection({
    schema: z.strictObject({
      id: core.schemas.entryId,
      userId: core.schemas.entryId,
      vendor: z.string(),
      totalCents: z.number().int().nonnegative()
    }),
    rbac: { user: ['create', 'read', 'list'], admin: ['create', 'read', 'update', 'delete', 'list'] }
  })
})

const routes = core.define.routes({
  'extract-invoice': core.define.route({
    mode: 'workflow',
    method: 'POST',
    path: '/invoices/extract',
    description: 'Extracts structured invoice fields from a PDF and saves a ledger entry',
    mcp: true,
    input: z.strictObject({ fileRef: core.schemas.fileRef }),
    handler: async ({ input, step }) => {
      const extracted = await step('vision-extract', () =>
        core.ai.vision({
          fileRef: input.fileRef,
          prompt: 'Extract vendor name and total amount in cents.',
          schema: z.object({ vendor: z.string(), totalCents: z.number().int() })
        })
      )
      return step('save-invoice', {
        fn: () => core.db.create('invoice', { userId: core.userId, ...extracted.output }),
        rollback: (inv) => core.db.delete('invoice', inv.id)
      })
    }
  })
})

export const { app, devApp, functions } = core.createApp({ collections, routes })
```

```bash
npx corge dev          # Hot-reload local server + automatic GCP Secret Manager injection
npx corge check        # <1s strict TypeScript check
npx corge deploy prod  # Bundle + merge rules/indexes + deploy to GCP Cloud Functions v2
```

---

## 🛠️ Built-In `corge` CLI

| Command | Description |
| :--- | :--- |
| **`npx corge init`** | Scaffolds a clean project (`tsconfig.json`, `src/index.ts`, `src/config/`, `src/routes/`, `src/services/`). |
| **`npx corge dev`** | Loads `.env` + GCP Secret Manager secrets and starts a hot-reloading Hono server on `PORT` (`8080`). |
| **`npx corge build`** | Bundles `src/index.ts` + `@corgelabs/corge` into `dist/index.cjs` (`node24`, CJS, sourcemaps). |
| **`npx corge deploy <prod\|dev>`** | Verifies branch guard (`main`/`dev`), builds, merges Firestore/Storage rules & indexes, and deploys. |
| **`npx corge test`** | Runs the E2E contract & integration test suite (`node --test`) with GCP Secret Manager injection. |
| **`npx corge check`** | Runs `tsc --noEmit` in `<1s`. |
| **`npx corge link [path]`** | Symlinks a local checkout of `corgelabs/corge` for live multi-repo editing (`corge unlink` restores npm). |
| **`npx corge env -- <cmd>`** | Runs any command with `.env` + GCP Secret Manager secrets injected into `process.env`. |

---

## 📄 License

MIT © [Corge Labs](https://github.com/corgelabs)
