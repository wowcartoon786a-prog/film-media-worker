# film-media-worker

The "heavy backend" — a standalone repo whose only job is running work
that either burns real CPU (FFmpeg) or takes long enough that it
shouldn't run inside the light backend's live request-handling process
(ingestion, search reindexing). It never touches MongoDB — the light
backend (a separate repo) is the only thing that ever reads or writes the
database. This repo only ever talks to external APIs (Archive.org, TMDb,
Nomic, Qdrant, R2) and calls back to the light backend's service API with
results.

Currently targets GitHub Actions for testing/light use. See the note at
the bottom about moving to dedicated infrastructure (e.g. Oracle Cloud)
for real production traffic.

## The three jobs

| Workflow | Triggered by | What it does | Touches Mongo? |
|---|---|---|---|
| `process-upload.yml` | Admin uploads a film | Downloads master from R2, runs FFmpeg (thumbnail + 30s preview), uploads results back to R2 | No |
| `ingest.yml` | Admin clicks "Run Ingestion", or a daily schedule | Searches Archive.org, enriches via TMDb, hands the finished batch to the light backend | No |
| `qdrant-reindex.yml` | Admin clicks "Reindex Search" | Fetches approved films from the light backend, embeds via Nomic, upserts to Qdrant directly | No |

All three follow the same shape: light backend triggers a workflow with
just enough input to identify the job (a film ID, or a `job_run_id`), the
workflow does its work using its own external API credentials, and it
calls back to the light backend's `/api/service/*` endpoints — never the
database directly — to report results.

## One-time setup

### 1. Push this repo to GitHub

If you haven't already: create `your-username/film-media-worker` on
GitHub and push this folder's contents (`.github/workflows/`, `scripts/`).

### 2. Add repository secrets

**Settings → Secrets and variables → Actions → Secrets tab**:

| Secret | Used by | Value |
|---|---|---|
| `R2_ACCOUNT_ID` | process-upload | Same as light backend's `.env` |
| `R2_ACCESS_KEY_ID` | process-upload | Same as light backend's `.env` |
| `R2_SECRET_ACCESS_KEY` | process-upload | Same as light backend's `.env` |
| `R2_BUCKET` | process-upload | Same as light backend's `.env` |
| `TMDB_API_KEY` | ingest | From themoviedb.org |
| `NOMIC_API_KEY` | qdrant-reindex | From atlas.nomic.ai |
| `QDRANT_URL` | qdrant-reindex | Your Qdrant Cloud cluster URL |
| `QDRANT_API_KEY` | qdrant-reindex | Your Qdrant Cloud API key |
| `BACKEND_CALLBACK_URL` | all three | A publicly reachable URL for the light backend — see note below |
| `SERVICE_API_SECRET` | all three | Any long random string — must exactly match `SERVICE_API_SECRET` in the light backend's `.env` |

### 3. Add repository variables (optional, non-sensitive config)

**Settings → Secrets and variables → Actions → Variables tab**:

| Variable | Default if unset | Purpose |
|---|---|---|
| `INGEST_COLLECTION` | `prelinger` | Which Archive.org collection to pull from |
| `INGEST_ROWS` | `20` | Max items per ingestion run |
| `QDRANT_COLLECTION` | `films` | Qdrant collection name |

### 4. BACKEND_CALLBACK_URL — the part that trips people up locally

GitHub's runners live on GitHub's cloud — they cannot reach
http://localhost:5000 on your machine. For local testing, expose your
local light backend with a tunnel first:

```bash
cloudflared tunnel --url http://localhost:5000
```

This prints a temporary https://xxxxx.trycloudflare.com URL. Set
BACKEND_CALLBACK_URL to that (no trailing slash). It changes every time
you restart the tunnel — update the secret again each time, or set up a
named Cloudflare tunnel for a stable URL. Once the light backend is
deployed somewhere with a real public URL, use that instead and skip the
tunnel entirely.

### 5. Give the light backend permission to trigger this repo

Generate a fine-grained Personal Access Token scoped to just this repo:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
2. Repository access: Only select repositories → this repo
3. Permissions: Actions → Read and write
4. Copy the token into the light backend's .env as GITHUB_PAT

### 6. MongoDB Atlas network access (needed by the light backend, not this repo)

Not a setting in this repo, but worth knowing: since the light backend
still connects to MongoDB directly (this repo never does), make sure
Atlas's Network Access allows whatever IP the light backend actually
runs from.

## Testing manually (no light backend involved)

Actions tab → pick a workflow → Run workflow → fill in the required
input(s) → Run. Watch the logs.

Note: ingest.yml and qdrant-reindex.yml require a real job_run_id that
exists in the light backend's database to report status against — for a
pure manual test with no light backend running, process-upload.yml is
the easiest to test standalone since you can inspect its R2 output
directly regardless of whether the callback succeeds.

## A note on GitHub's Terms of Service

This is fine for testing and light personal use, exactly as set up here.
GitHub's Terms for Additional Products and Features restrict using
Actions as the actual processing backend for a live commercial product —
if this app gets real users and regular traffic, move this workload to
infrastructure meant for it. The architecture here (stateless jobs,
external API calls, callback on completion) is deliberately portable —
moving to a different host later means writing a new outer harness (a
long-running polling loop instead of one-shot workflow_dispatch runs),
not rewriting the actual FFmpeg/ingestion/embedding logic itself.
