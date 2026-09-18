# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LeadPilot is Pablo Leone's B2B prospecting automation tool. It scrapes local businesses
from Google Maps, auto-qualifies them, analyzes their website (PageSpeed + rendered HTML +
a Claude vision pass over a screenshot), generates a personalized cold email + LinkedIn
post, and sends/publishes both automatically — then runs a day-7/day-14 follow-up sequence
by email.

It runs **campaigns**: the same pipeline can sell different things to different markets.
`us-webaudit` sells web audits to US local businesses in English; `es-sprint` sells a
fixed-price automation sprint to Spanish SMEs in Spanish, using an analysis that looks for
manual processes rather than slow pages. See "Campaigns" below before changing any copy. A React frontend (`packages/frontend`) is the manual-review/dashboard UI, but the
core value is that the pipeline runs unattended end to end.

There is no local dev/staging environment — `npm run deploy` (or `cdk deploy`) ships
straight to the one production AWS account. There is no test suite.

## Commands

```bash
npm run build          # builds every workspace (tsc) that has a build script
npm run deploy          # cdk deploy, from repo root (delegates to packages/infra)

# packages/infra
npx cdk deploy LeadPilotStack --require-approval never   # deploy the whole stack
npx cdk diff LeadPilotStack                               # preview changes
npx cdk synth LeadPilotStack                               # bundle + validate all Lambdas without deploying

# packages/frontend
npm run dev             # vite dev server
npm run build           # tsc && vite build -> dist/, then sync to S3 + CloudFront invalidation (manual, see below)

# packages/screenshot-service — NOT part of `cdk deploy`, see "Screenshot service" below
npm run build && npm start   # run locally
```

Frontend deploy after `npm run build` (CDK does not do this automatically):
```bash
aws s3 sync packages/frontend/dist/ s3://<FrontendBucketName-from-stack-outputs>/ --delete
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
```

No test suite, no linter, no formatter and no CI exist in this repo — see `TODO.md` item 2.

**`cdk synth` does not typecheck.** Lambda code has no `tsconfig.json` of its own, and both
`cdk synth` and `npm run build` go through esbuild, which strips types without checking
them. A wrong-arity call shipped to production through a clean synth on 2026-09-18. Until
the backlog item lands, run this by hand before deploying anything under
`packages/functions/` — it takes seconds and currently reports zero errors:

```bash
npx tsc --noEmit --skipLibCheck --esModuleInterop --resolveJsonModule --target es2020 \
  --module commonjs --moduleResolution node --strict packages/functions/*/index.ts
```

`cdk synth` is still worth running: it validates that every Lambda actually bundles.

## Architecture

### Monorepo layout
- `packages/infra` — CDK app (`bin/`, `lib/leadpilot-stack.ts`, `lib/constructs/*.ts`).
  One stack, `LeadPilotStack`, split into constructs: `database.ts` (DynamoDB),
  `storage.ts` (S3), `api.ts` (all Lambdas + HTTP API routes), `scraping.ts` (Fargate
  tasks: Maps scraper + screenshot service), `frontend.ts` (S3 + CloudFront).
- `packages/functions/*` — one directory per Lambda, each its own npm workspace
  (`index.ts` + `package.json`). `packages/functions/shared/` is a local module
  (`types.ts`, `send-lead-email.ts`, `pagespeed.ts`, `tracking.ts`, `followup-email.ts`,
  `email-template.ts`, `buffer.ts`) imported via relative path, not published.
- `packages/frontend` — Vite + React + Tailwind. No routing library abstraction beyond
  `react-router-dom`; `/` is the dashboard, `/leads` is the filterable list.
- `packages/screenshot-service` — a small Express-less HTTP server (Playwright) that
  runs as its own Fargate task, NOT built/deployed by CDK's asset bundling. See below.

### The pipeline (the part that matters most)

State lives entirely in one DynamoDB item per lead (`leadpilot-leads`, PK `leadId`),
driven forward by `status` (type `LeadStatus` in `shared/types.ts` /
`frontend/types/lead.ts` — keep both in sync manually, they're not shared code).
`update-lead-status`'s `VALID_TRANSITIONS` map is the source of truth for which
transitions are legal; most of the pipeline below happens automatically without ever
going through that Lambda, by other Lambdas writing `status` directly.

```
auto-scrape-scheduler (daily cron, one job per ACTIVE campaign)
  → scrape-jobs/scrape-worker → ingest-leads (auto-QUALIFIED, stamps campaignId)
  → run-analysis → analysis-worker (PageSpeed + screenshot + rendered HTML →
                    deterministic friction detection + Claude vision → webAnalysis)
    → generate-report (report HTML to S3, cold email + LinkedIn post via Claude,
                        auto-send via SES, auto-publish via Buffer) → ANALYZED/SENT
      → track-click (email link click → ENGAGED) / calcom-webhook (booking → BOOKED)
      → followup-sequencer (daily cron: SENT→FOLLOWUP_1 day 7, →FOLLOWUP_2 day 14,
                             →ARCHIVED day 28 if still no response; also sweeps ANALYZED
                             leads whose auto-send never went out, e.g. daily cap hit)
```

Every Lambda that changes `status` also appends a `TimelineEvent` to `lead.timeline`
(free-form `event: string`, not constrained to `LeadStatus`) — this is the only audit
trail; there's no separate event table. When debugging "why didn't X happen to this
lead", read the full timeline before anything else.

`get-stats` does a full table scan grouping by `status` — cheap because volume is low,
but don't build anything against this table that would care about scan cost.

### Campaigns — read this before changing any copy

A campaign is the bundle of *who we write to and what we sell them*: ICP (cities ×
verticals), language and search locale, sender identity, booking URL and send caps. Two
exist in `shared/campaigns.ts`: `us-webaudit` (web audits, US, English, active) and
`es-sprint` (the Sprint de Automatización, Spain, Spanish, **inactive**). Every lead,
scrape job and scraped lead carries `campaignId`; absent means `us-webaudit`, which is what
every lead predating this has.

The split is deliberate and matters when you go to change something:

- **Config lives in code** (`shared/campaigns.ts`). The ICP changes rarely and belongs in
  git history — a cron that silently starts writing to a different sector is not something
  you want to discover by diffing a DynamoDB row. Changing it needs a redeploy.
- **Copy lives in DynamoDB** (`leadpilot-prompts`), under keys `${campaignId}/${promptId}`,
  six per campaign: `vision-analysis`, `report-html`, `cold-email`, `linkedin-post`,
  `followup-email`, `engaged-followup-email`. Editing the message needs no deploy — just
  edit the `ACTIVE` item. `shared/prompt-store.ts` caches for 5 minutes.

Two traps:

1. **Seed before you deploy.** `getActivePrompt` throws when a campaign's prompt is
   missing — there is deliberately no fallback to the default campaign, because inheriting
   silently would mean sending a Spanish prospect another offer's English copy. If you add
   a campaign or rename a prompt, run `scripts/seed-prompts.ts` (idempotent, `--campaign=`
   to scope it, `--force` to overwrite) *first*.
2. **`renderPrompt` only substitutes the placeholders a template contains**, and logs an
   error + substitutes `''` for one it cannot resolve. Passing extra variables is free,
   which is how `es-sprint` gets `frictionSignals`/`pageText` without `us-webaudit` caring.
   The flip side: a typo in a `{{placeholder}}` fails silently at runtime. There is no
   check for this — cross-check by hand against the `renderPrompt` call site.

The unprefixed prompt keys from before this change are still in the table, orphaned, as a
rollback net (`TODO.md`). Edit the prefixed ones; nothing reads the others.

### Friction analysis — what the vision pass actually looks for

`us-webaudit` asks Claude about performance and visual quality. `es-sprint` asks it to find
*a business process being done by hand* — the thing its offer removes. Same code path, and
the difference lives entirely in the prompt.

`shared/friction.ts` does a deterministic pass over the rendered HTML first (booking tools,
chat widgets, `wa.me` links, `mailto:`-only forms, `tel:` links) and hands the result to the
prompt as established fact, the same way cookie detection already worked. Whether a widget
is on the page is verifiable; leaving it to the model invites hallucinating one. The
`es-sprint` prompt is told these signals outrank its visual impression — which is what lets
it say things like "the PIDE CITA button is decorative".

Finding a booking tool is a **negative** signal for this offer: that business already
automated what we were going to sell.

The HTML comes from the screenshot-service, post-JS, because booking and chat widgets are
script-injected. If it is missing, `detectFriction` returns zero signals and says so rather
than reading as "no friction" — so a stale ECR image degrades instead of lying.

`WebAnalysis.frictionSignals` and `.processHypothesis` are optional and only `es-sprint`
produces them.

### Three scraper providers, one dispatcher

`scrape-worker/index.ts` is a thin dispatcher reading `job.provider` and calling
`gosom-provider.ts`, `serpapi-provider.ts` (Maps local pack) or `serpapi-web-provider.ts`
(plain web SERP ads, for verticals with no physical location), all normalized to the same
`ScrapedLead` shape (`scrape-worker/types.ts`). The worker stamps `campaignId` on every
lead in one place, so the providers don't each have to.

`auto-scrape-scheduler` is the daily cron. It picks a random city and vertical from each
**active campaign's** own ICP and fires one job per campaign — so activating a second
campaign doubles SerpApi usage, which matters on the free plan. The provider comes from the
campaign if it pins one, otherwise from `/leadpilot/scrape-provider` (SSM), read fresh every
run — that parameter is still the no-redeploy toggle for campaigns that don't pin.
Both SerpApi providers take `gl`/`hl`/`google_domain` from the campaign's locale, and
`toSerpApiLocation` takes an optional country for cities outside the US.

Manual scrapes from the
frontend (`ScrapeLeads.tsx`) let the user pick per-request.

Neither provider gives a clean "this business pays for Google Ads" signal for free — see
`TODO.md` item 1 for the full story (gosom has no such concept at all; SerpApi's
`local_ads` requires cross-referencing against `local_results` by fuzzy name match, and
often doesn't overlap). Whichever provider you're reading code for, don't assume
`sponsored` is reliable — it's a best-effort tag, not ground truth.

### Screenshot service — deploy this by hand

`analysis-worker` calls `packages/screenshot-service` over HTTP: it launches a fresh
Fargate task per lead (`RunTaskCommand`), polls for a public IP, POSTs `{url, leadId}` to
it, and stops the task when done. It returns the S3 key, the cookie-banner detection and
the **rendered HTML** (capped at 600KB), which is what feeds friction detection. The image is pulled from ECR (`leadpilot-screenshot`,
tag `latest`) — **CDK does not build or push this image**. If you change
`packages/screenshot-service/index.ts`, you must rebuild and push it yourself, and you
must target the correct architecture:

```bash
docker buildx build --platform linux/arm64 \
  -t <account>.dkr.ecr.us-east-1.amazonaws.com/leadpilot-screenshot:latest \
  --push packages/screenshot-service
```

The Fargate task definition (`scraping.ts`, `ScreenshotTaskDef`) is pinned to
`ecs.CpuArchitecture.ARM64` — a plain `docker build --platform linux/amd64` (or letting
buildx default to your host arch) will silently produce a working-looking image that
Fargate then can't pull at all (`CannotPullContainerError`, manifest platform mismatch).
Verify before moving on: `docker manifest inspect <image>` and confirm
`"architecture": "arm64"`. This bit us for real — see `TODO.md`/git history around
2026-07-21 if you need the full debugging trail.

### Infra quirks worth knowing before you go looking for a bug elsewhere

- **SES lives in `eu-west-1`,** not `us-east-1` where the rest of the stack runs. The
  `generate-report`/`followup-sequencer` Lambdas set `SESClient({ region:
  process.env.SES_REGION })` explicitly — if you're checking SES sending status/quota
  via the CLI, you will get a misleadingly-empty picture from `us-east-1`.
- **The real daily send-cap parameter is `/leadpilot/daily-send-cap`** (wired to
  `SHARED_DAILY_CAP_PARAM`). A parameter named `/leadpilot/followup-daily-cap` also
  exists in SSM and is *not* read by any code — leftover cruft, safe to ignore/delete.
- `sendLeadEmail` (`shared/send-lead-email.ts`) silently no-ops with zero timeline event
  when a lead has no email address at all (`reason: 'no-recipients'`) — such leads sit in
  `ANALYZED` forever with a fully-generated report and no visible error. If sends have
  "stopped" for a batch of leads, check `email`/`emails` on them before assuming a system
  outage.
- A `generate-report` failure (e.g. Anthropic API credit exhaustion) throws before ever
  writing to DynamoDB — the lead stays in `ANALYZED` with no partial report and no
  timeline event either. `followup-sequencer`'s daily sweep only retries leads that
  already have `reportHtmlS3Key`/`emailSubject`/`emailBody`; a lead that never got that
  far needs `POST /leads/{id}/report` (or the "Reintentar" UI) re-triggered by hand once
  the underlying cause is fixed.
- gosom (the self-hosted scraper) is currently blocked by an issue in Microsoft's own
  Playwright driver CDN, unrelated to this codebase — full history and current status in
  `TODO.md`. Don't assume switching the `gosom/google-maps-scraper` Docker image tag
  alone fixes it; check the TODO first.

## Where things live (reference)

- DynamoDB: `leadpilot-leads` (PK `leadId`, GSIs `status-createdAt-index` and
  `url-index` for dedup), `leadpilot-send-counters` (PK `date`; `sentCount` and
  `linkedinPostCount` globally, plus `sentCount#<campaignId>` per campaign),
  `leadpilot-scrape-jobs` (PK `jobId`), `leadpilot-prompts` (PK `promptId` =
  `campaignId/promptId`, SK `version` — numeric versions plus an `ACTIVE` pointer item),
  `leadpilot-llm-logs` (PK `leadId`, SK `logId`, GSI `promptId-at-index` — one row per
  Claude call with model, prompt version, tokens, cost and latency).
- S3: one reports bucket (screenshots + generated report HTML), one frontend bucket
  behind CloudFront.
- SSM params (all under `/leadpilot/`): `anthropic-api-key`, `pagespeed-api-key`,
  `serpapi-key`, `scrape-provider`, `daily-send-cap`, `linkedin-daily-cap`,
  `tracking-secret`, `calcom-webhook-secret`, `buffer-api-key`, `screenshot-task-token`.
- API routes: see `packages/infra/lib/constructs/api.ts` — REST-ish HTTP API, one Lambda
  per route, `x-api-key` header auth (not IAM/Cognito).

## Backlog

`TODO.md` at the repo root is the maintained backlog and running log of known issues,
temporary decisions, and things intentionally left half-done. Read it before starting
work — it's kept up to date across sessions and has more detail than this file on
anything currently in flux (e.g. the sponsored-lead filtering problem, the gosom outage).
