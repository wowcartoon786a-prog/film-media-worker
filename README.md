# film-media-worker

A deliberately tiny, standalone repo with exactly one job: run FFmpeg (via
GitHub-hosted Actions runners) to generate a thumbnail and 30-second
preview clip for a film uploaded to the main app, without needing FFmpeg
installed anywhere yourself.

Kept separate from the main/frontend/backend repos so those stay free of
CI-heavy tooling — this repo does nothing but run one workflow.

## What it does

1. Triggered via `workflow_dispatch` (manually from the Actions tab, or
   programmatically by the main backend's `services/githubActions.js`)
   with two inputs: `film_id` and `master_key`.
2. Downloads the master video from your R2 bucket.
3. Runs `ffmpeg`/`ffprobe` (preinstalled on `ubuntu-latest` runners) to
   generate a thumbnail and a 30s/480p preview clip.
4. Uploads both back to the same R2 bucket, next to the master file.
5. Calls back to your backend's `POST /api/media-callback/:film_id` with
   the result, so it can update the film's `posterUrl`/`previewUrl` and
   flip it to published.

## One-time setup

### 1. Create this repo on GitHub

Push this folder (just the `.github/workflows/process-upload.yml` file) to
a new repo, e.g. `your-username/film-media-worker`.

### 2. Add repository secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` | Same as the backend's `.env` |
| `R2_ACCESS_KEY_ID` | Same as the backend's `.env` |
| `R2_SECRET_ACCESS_KEY` | Same as the backend's `.env` |
| `R2_BUCKET` | Same as the backend's `.env` |
| `BACKEND_CALLBACK_URL` | A **publicly reachable** URL for your backend — see note below |
| `MEDIA_CALLBACK_SECRET` | Any long random string — must exactly match `MEDIA_CALLBACK_SECRET` in the backend's `.env` |

### 3. `BACKEND_CALLBACK_URL` — the part that trips people up locally

GitHub's runners live on GitHub's cloud — they cannot reach
`http://localhost:5000` on your machine. For local testing, expose your
local backend with a tunnel first:

```bash
# using Cloudflare's own tunnel tool, since you already have a Cloudflare account
cloudflared tunnel --url http://localhost:5000
```

This prints a temporary `https://xxxxx.trycloudflare.com` URL. Set
`BACKEND_CALLBACK_URL` to that (no trailing slash). **It changes every time
you restart the tunnel** — update the secret again each time, or set up a
[named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)
for a stable URL. Once you deploy the backend somewhere with a real public
URL, use that instead and skip the tunnel entirely.

### 4. Give the main backend permission to trigger this repo

Generate a fine-grained Personal Access Token scoped to just this repo:

1. GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token**
2. Repository access: **Only select repositories** → this repo
3. Permissions: **Actions → Read and write**
4. Copy the token into the main backend's `.env` as `GITHUB_PAT`

## Testing manually (no backend involved)

Actions tab → **Process Upload** → **Run workflow** → fill in a real
`film_id` and `master_key` from your database/bucket → Run. Watch the logs.
This is a good way to confirm ffmpeg + R2 credentials work before wiring
up the full automatic flow from the backend.

## A note on GitHub's Terms of Service

This is fine for testing and light personal use, exactly as set up here.
GitHub's Terms for Additional Products and Features restrict using
Actions as the actual processing backend for a live commercial product —
if this app gets real users uploading videos regularly, move this
workload to something designed for it (e.g. Coconut.co, which this repo's
approach is deliberately modeled after — same "point it at a URL, get a
webhook back" shape, just on infrastructure meant for this).
