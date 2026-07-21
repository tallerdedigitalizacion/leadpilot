# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LeadPilot is Pablo Leone's B2B prospecting automation tool. It scrapes local businesses
from Google Maps, auto-qualifies them, analyzes their website (PageSpeed + a Claude
vision pass over a screenshot), generates a personalized cold email + LinkedIn post, and
sends/publishes both automatically — then runs a day-7/day-14 follow-up sequence by
email. A React frontend (`packages/frontend`) is the manual-review/dashboard UI, but the
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

No test suite exists in this repo. Lambda code has no `tsconfig.json` of its own — CDK's
`NodejsFunction` bundles each Lambda with esbuild at deploy time, which is the only type
checking that actually runs on them (no standalone `tsc` step). Run `cdk synth` to catch
bundling/type errors across every Lambda before deploying if you've touched several at
once.

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
scrape-jobs/scrape-worker → ingest-leads (auto-QUALIFIED)
  → run-analysis → analysis-worker (PageSpeed + screenshot + Claude vision → webAnalysis)
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

### Two scraper providers, one dispatcher

`scrape-worker/index.ts` is a thin dispatcher reading `job.provider` (`'gosom'` or
`'serpapi'`) and calling `gosom-provider.ts` or `serpapi-provider.ts`, both normalized to
the same `ScrapedLead` shape (`scrape-worker/types.ts`). `auto-scrape-scheduler` is the
daily cron (city × sector matrix) that reads `/leadpilot/scrape-provider` (SSM) fresh
every run to decide which provider to use — this is the single toggle for switching the
whole automated pipeline between providers without a redeploy. Manual scrapes from the
frontend (`ScrapeLeads.tsx`) let the user pick per-request.

Neither provider gives a clean "this business pays for Google Ads" signal for free — see
`TODO.md` item 1 for the full story (gosom has no such concept at all; SerpApi's
`local_ads` requires cross-referencing against `local_results` by fuzzy name match, and
often doesn't overlap). Whichever provider you're reading code for, don't assume
`sponsored` is reliable — it's a best-effort tag, not ground truth.

### Screenshot service — deploy this by hand

`analysis-worker` calls `packages/screenshot-service` over HTTP: it launches a fresh
Fargate task per lead (`RunTaskCommand`), polls for a public IP, POSTs `{url, leadId}` to
it, and stops the task when done. The image is pulled from ECR (`leadpilot-screenshot`,
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
  `url-index` for dedup), `leadpilot-send-counters` (PK `date`, daily send/LinkedIn
  counts), `leadpilot-scrape-jobs` (PK `jobId`).
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
