/**
 * film-media-worker/scripts/checkLinks.js
 *
 * Weekly sweep: fetches every approved film's streamUrl from the light
 * backend, does a HEAD request against each, and reports the results
 * back in a single batch. Runs entirely without touching MongoDB — same
 * pattern as ingest.js and qdrantReindex.js: fetch via /api/service,
 * do the work, report back via /api/service.
 *
 * Env vars (all provided by the workflow):
 *   BACKEND_CALLBACK_URL, SERVICE_API_SECRET, JOB_RUN_ID (optional —
 *   empty on the scheduled/cron run, set on an admin-triggered run)
 */

const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: "heavy-backend",
    initialScope: { tags: { service: "heavy-backend", script: "check-links" } },
  });
}

const BACKEND_CALLBACK_URL = process.env.BACKEND_CALLBACK_URL;
const SERVICE_API_SECRET = process.env.SERVICE_API_SECRET;
const JOB_RUN_ID = process.env.JOB_RUN_ID || undefined;

const HEAD_TIMEOUT_MS = 15000;
// Stay well clear of hammering many different hosts (archive.org, R2,
// B2, Storj) back-to-back — this is a courtesy pause, not a rate-limit
// dodge for any single host.
const REQUEST_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backendUrl(path) {
  if (!BACKEND_CALLBACK_URL) throw new Error("Missing BACKEND_CALLBACK_URL");
  return `${BACKEND_CALLBACK_URL.replace(/\/$/, "")}${path}`;
}

function backendHeaders() {
  if (!SERVICE_API_SECRET) throw new Error("Missing SERVICE_API_SECRET");
  return { "Content-Type": "application/json", "X-Service-Secret": SERVICE_API_SECRET };
}

async function fetchFilmsToCheck() {
  const res = await fetch(backendUrl("/api/service/films/for-link-check"), {
    headers: backendHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch films for link check (HTTP ${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * A single HEAD request with a timeout. Never throws — resolves to a
 * result object either way, since one unreachable film shouldn't stop
 * the whole sweep.
 */
async function checkOne(film) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);

  try {
    const res = await fetch(film.streamUrl, { method: "HEAD", signal: controller.signal });
    if (res.ok) {
      return { filmId: film.filmId, isHealthy: true };
    }
    return { filmId: film.filmId, isHealthy: false, lastError: `HTTP ${res.status}` };
  } catch (err) {
    return { filmId: film.filmId, isHealthy: false, lastError: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function reportResults(results) {
  const res = await fetch(backendUrl("/api/service/films/link-health-batch"), {
    method: "POST",
    headers: backendHeaders(),
    body: JSON.stringify({ results }),
  });
  if (!res.ok) {
    throw new Error(`Failed to report link health batch (HTTP ${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function reportJobComplete(status, result, error) {
  if (!JOB_RUN_ID) return; // scheduled/cron runs have no JobRun to report against
  await fetch(backendUrl(`/api/service/jobs/${JOB_RUN_ID}/complete`), {
    method: "POST",
    headers: backendHeaders(),
    body: JSON.stringify({ status, result, error }),
  }).catch((err) => console.error("Additionally failed to report job completion:", err.message));
}

async function run() {
  const films = await fetchFilmsToCheck();
  console.log(`Checking ${films.length} approved film(s)...`);

  const results = [];
  let healthy = 0;
  let unhealthy = 0;

  for (const film of films) {
    const result = await checkOne(film);
    results.push(result);
    if (result.isHealthy) {
      healthy += 1;
    } else {
      unhealthy += 1;
      console.warn(`Unhealthy: ${film.filmId} — ${result.lastError}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Reporting ${results.length} result(s) back to the backend...`);
  await reportResults(results);

  console.log("--- Link health summary ---");
  console.log({ total: films.length, healthy, unhealthy });

  await reportJobComplete("completed", { total: films.length, healthy, unhealthy });
}

run().catch(async (err) => {
  console.error("Link check run failed:", err.message);
  Sentry.captureException(err);
  await reportJobComplete("failed", null, err.message);
  // Sentry sends events over the network asynchronously — without this,
  // the process could exit before the event actually gets delivered.
  await Sentry.flush(2000).catch(() => {});
  process.exit(1);
});