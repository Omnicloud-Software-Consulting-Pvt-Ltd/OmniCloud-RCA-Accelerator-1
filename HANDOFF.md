# RCA Accelerator — Deployment Handoff / Working Notes

> **Purpose of this file:** continuity note so a Claude Code session opened in *this*
> folder can pick up the in-progress work without re-discovering everything. Started in
> the sibling `OmniCloud-Website-2026` workspace on **2026-06-06**, moved here at the
> user's request. Safe to delete once the work is done (it's a working note, not product docs).

## The goal (what the user asked for)
Take this app — a standalone web app the team built as an **accelerator on Agentforce /
Salesforce Revenue Cloud** — **live**:
1. **Deploy to Vercel** (same playbook as the `OmniCloud-Elevator-Pitch` repo →
   `revenue.omnicloudconsulting.com`), on a **subdomain** (proposed: `rca.omnicloudconsulting.com`).
2. **Test it end-to-end.**
3. Produce **robust documentation** to use as a **pitch deck / demo script for the Salesforce team**.

## What this app is (verified by reading the code)
"**Omnicloud AI Platform**" — Next.js 16.2.6 (App Router) · React 19.2.4 · Tailwind v4 ·
framer-motion · lucide-react · next-themes. Geist fonts. Dark/light theme. **Omnion** mascot
branding. It logs into a Salesforce org via OAuth, then uses **Claude (`claude-sonnet-4-6`)**
to accelerate Revenue Cloud (RCA) setup.

Two "agents" selectable from `/dashboard`:
- **Metadata Omnion** (`/metadata`) → `RCProductWorkspace`: AI-generate a full **Product2 +
  attributes** payload from a natural-language product description, review (Visual/JSON), deploy.
- **Data Omnion** (`/data`) → `RCAOrchestrationPlatform` (7 tabs) wrapping:
  - `BundleOrchestrationWorkspace` — NL → structured **bundle** (products, nested bundles,
    dependency rules AUTO_ADD/REQUIRES/EXCLUDES/DEPENDS_ON), 9-batch deploy w/ SSE progress.
  - `RCAAttributeStudio` — NL product desc → **RCA attributes** with semantic filtering
    (drops price/ERP/WMS/audit fields), 9-batch deploy.

Route map: `/` → redirect `/login` → SF OAuth popup → `/auth/callback` → `/dashboard` →
`/metadata` or `/data`. 14 API routes (all serverless ƒ). 3 call Anthropic
(`/api/bundles/parse`, `/api/sf/attributes/parse`, `/api/sf/products/generate-payload`,
all `claude-sonnet-4-6`); the rest hit the Salesforce Data/Tooling API.

## Status checklist
- [x] Repo cloned (sibling of the website repo), `npm install` done
- [x] `npm run build` passes (exit 0) — all routes compile
- [x] Codebase fully mapped (see "What this app is" + env vars below)
- [ ] **Obtain secrets from user** (blocking e2e + deploy) — see below
- [ ] Local smoke test with a `.env.local`
- [ ] Create/locate Vercel project + set env vars + attach subdomain
- [ ] Configure Salesforce Connected App redirect URI for the subdomain
- [ ] End-to-end test on the deployed subdomain
- [ ] Write the pitch/demo documentation for the Salesforce team

## Required environment variables (NOT committed — `.gitignore` excludes `.env*`)
| Var | Required? | Used in | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | `api/bundles/parse:5`, `api/sf/attributes/parse:347`, `api/sf/products/generate-payload:374` | Claude calls; `sk-ant-...` |
| `SALESFORCE_CLIENT_ID` | **Yes** | `api/auth/salesforce/url:12,40`, `.../token:43` | Connected App consumer key `3MVG...` |
| `SALESFORCE_CLIENT_SECRET` | **Yes** | `api/auth/salesforce/token:44` | Connected App consumer secret |
| `NEXTAUTH_SECRET` | **Yes (prod)** | `.../url:25`, `.../token:13` | HMAC signs OAuth `state`. Dev fallback `"omnicloud-dev-secret"` — MUST set a real random value in prod |
| `NEXTAUTH_URL` | **Yes (prod)** | `.../url:5`, `.../token:4` | **Critical.** Base URL used to build `redirect_uri`. If unset it auto-detects from `x-forwarded-host`/`-proto`; set it explicitly to the subdomain to be safe → `https://rca.omnicloudconsulting.com` |

## Salesforce Connected App config the user must set
- **Callback / Redirect URI** must be exactly: `{NEXTAUTH_URL}/api/auth/callback/salesforce`
  (e.g. `https://rca.omnicloudconsulting.com/api/auth/callback/salesforce`). Also add the
  Vercel preview/localhost variants if testing those.
- **OAuth scopes:** `api refresh_token openid profile email`.
- Grant type: authorization_code. Supports sandbox (`test.salesforce.com`) and production
  (`login.salesforce.com`) — chosen via an environment toggle on the login screen.
- Session is stored **client-side in `localStorage`** (`omnicloud_sf_session`), not a server cookie.

## Deploy specifics
- `vercel.json` sets `app/api/bundles/execute` `maxDuration: 300` (5 min) for the streaming
  9-batch deploy. Keep — needs a plan that allows 300s functions.
- SF API version pinned `v60.0` (`lib/salesforce/client.ts:1`). Claude model pinned
  `claude-sonnet-4-6` in the 3 AI routes.
- Default branch is **`master`** (note: website repo uses `main`).
- Vercel team/project for the org (from website MCP context): team `team_XJoE8YotbNq6I0SZ6VBtUMAD`.
  The accelerator likely needs its **own** Vercel project. Confirm with user / Vercel MCP.

## Blocking questions for the user (need answers to proceed)
1. **Subdomain name** — `rca.omnicloudconsulting.com`? something else?
2. **`ANTHROPIC_API_KEY`** — provide one (set directly in Vercel env, don't paste in chat ideally).
3. **Salesforce Connected App** — does one already exist (CLIENT_ID/SECRET), or create new?
   Which org for the demo (prod or a sandbox with Revenue Cloud enabled)?
4. **Vercel** — new project, or already created? (User created the elevator-pitch project manually.)

## Pointers
- Sibling marketing site: `../OmniCloud-Website-2026` (Next 16, deploys to Vercel on push to `main`).
- This repo's own AI rules: `AGENTS.md` warns Next.js here has breaking changes vs. training data —
  read `node_modules/next/dist/docs/` before writing Next-specific code.
