/**
 * film-media-worker/scripts/ingest.js
 *
 * Runs entirely without touching MongoDB — the light backend is the only
 * thing that ever writes to the database. This script's job is just:
 * search Archive.org, ask the light backend which candidates are already
 * known (so TMDb calls aren't wasted on duplicates), enrich the new ones
 * via TMDb, then hand the finished batch to the light backend to insert.
 *
 * Env vars (all provided by the workflow):
 *   TMDB_API_KEY, INGEST_COLLECTION, INGEST_ROWS,
 *   BACKEND_CALLBACK_URL, SERVICE_API_SECRET, JOB_RUN_ID (optional —
 *   empty on the scheduled/cron run, set on an admin-triggered run)
 */

const crypto = require("crypto");
const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: "heavy-backend",
    initialScope: { tags: { service: "heavy-backend", script: "ingest" } },
  });
}

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const ARCHIVE_COLLECTION = process.env.INGEST_COLLECTION || "prelinger";
const ARCHIVE_ROWS = Number(process.env.INGEST_ROWS || 20);
const BACKEND_CALLBACK_URL = process.env.BACKEND_CALLBACK_URL;
const SERVICE_API_SECRET = process.env.SERVICE_API_SECRET;
const JOB_RUN_ID = process.env.JOB_RUN_ID || undefined;

const FETCH_TIMEOUT_MS = 15000;
const TMDB_REQUEST_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function fetchJson(url, options = {}, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${label || url} responded with HTTP ${res.status}: ${body}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function backendUrl(path) {
  if (!BACKEND_CALLBACK_URL) throw new Error("Missing BACKEND_CALLBACK_URL");
  return `${BACKEND_CALLBACK_URL.replace(/\/$/, "")}${path}`;
}

function backendHeaders() {
  if (!SERVICE_API_SECRET) throw new Error("Missing SERVICE_API_SECRET");
  return {
    "Content-Type": "application/json",
    "X-Service-Secret": SERVICE_API_SECRET,
  };
}

// --- Archive.org ---

async function searchArchiveOrg() {
  const params = new URLSearchParams();
  params.set("q", `collection:${ARCHIVE_COLLECTION} AND mediatype:movies`);
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "year");
  params.append("fl[]", "description");
  params.set("rows", String(ARCHIVE_ROWS));
  params.set("page", "1");
  params.set("output", "json");

  const url = `https://archive.org/advancedsearch.php?${params.toString()}`;
  const data = await fetchJson(url, {}, "Archive.org advancedsearch");

  const docs = data?.response?.docs || [];
  return docs
    .filter((doc) => doc.identifier && doc.title)
    .map((doc) => ({
      identifier: doc.identifier,
      title: doc.title,
      year: Array.isArray(doc.year) ? Number(doc.year[0]) : Number(doc.year) || undefined,
      description: Array.isArray(doc.description) ? doc.description[0] : doc.description,
    }));
}

async function getBestStreamUrl(identifier) {
  const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
  const data = await fetchJson(url, {}, `Archive.org metadata for ${identifier}`);

  const files = Array.isArray(data.files) ? data.files : [];
  const mp4Files = files.filter(
    (f) => typeof f.name === "string" && f.name.toLowerCase().endsWith(".mp4")
  );
  if (mp4Files.length === 0) return null;

  mp4Files.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  return `https://archive.org/download/${identifier}/${mp4Files[0].name}`;
}

// --- TMDb ---

let tmdbGenreMap = null;

async function getTmdbGenreMap() {
  if (!TMDB_API_KEY) return new Map();
  if (tmdbGenreMap) return tmdbGenreMap;
  try {
    const url = `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-US`;
    const data = await fetchJson(url, {}, "TMDb genre list");
    tmdbGenreMap = new Map((data.genres || []).map((g) => [g.id, g.name]));
  } catch (err) {
    console.warn("Could not load TMDb genre list:", err.message);
    tmdbGenreMap = new Map();
  }
  return tmdbGenreMap;
}

async function searchTmdb(title, year, genreMap) {
  if (!TMDB_API_KEY) return null;
  try {
    const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
    if (year) params.set("year", String(year));
    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const data = await fetchJson(url, {}, `TMDb search for "${title}"`);
    const match = (data.results || [])[0];
    if (!match) return null;
    return {
      posterUrl: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : undefined,
      overview: match.overview || undefined,
      genres: (match.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean),
    };
  } catch (err) {
    console.warn(`TMDb lookup failed for "${title}":`, err.message);
    return null;
  }
}

// --- Light backend service API ---

async function checkExisting(identifiers, hashes) {
  const data = await fetchJson(
    backendUrl("/api/service/films/check-existing"),
    {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({ identifiers, hashes }),
    },
    "check-existing"
  );
  return {
    existingIdentifiers: new Set(data.existingIdentifiers || []),
    existingHashes: new Set(data.existingHashes || []),
  };
}

async function submitBatch(films) {
  return fetchJson(
    backendUrl("/api/service/films/ingest-batch"),
    {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({ films, jobRunId: JOB_RUN_ID }),
    },
    "ingest-batch"
  );
}

// --- Main ---

async function run() {
  const candidates = await searchArchiveOrg();
  console.log(`Archive.org returned ${candidates.length} candidate item(s).`);

  const withHashes = candidates.map((c) => ({ ...c, fileHash: sha256(c.identifier) }));

  const { existingIdentifiers, existingHashes } = await checkExisting(
    withHashes.map((c) => c.identifier),
    withHashes.map((c) => c.fileHash)
  );

  const newCandidates = withHashes.filter(
    (c) => !existingIdentifiers.has(c.identifier) && !existingHashes.has(c.fileHash)
  );
  const skippedCount = withHashes.length - newCandidates.length;
  console.log(`${skippedCount} already known, ${newCandidates.length} new.`);

  const genreMap = await getTmdbGenreMap();
  const films = [];
  const errors = [];

  for (const candidate of newCandidates) {
    try {
      const streamUrl = await getBestStreamUrl(candidate.identifier);
      if (!streamUrl) {
        errors.push(`${candidate.identifier}: no .mp4 file found in Archive.org metadata`);
        continue;
      }

      const tmdbInfo = await searchTmdb(candidate.title, candidate.year, genreMap);
      await sleep(TMDB_REQUEST_DELAY_MS);

      films.push({
        title: candidate.title,
        year: candidate.year,
        description: tmdbInfo?.overview || candidate.description || undefined,
        posterUrl: tmdbInfo?.posterUrl || `https://archive.org/services/img/${candidate.identifier}`,
        category: tmdbInfo?.genres?.length ? tmdbInfo.genres : ["Uncategorized"],
        streamUrl,
        downloadUrl: streamUrl,
        license: { source: "archive.org", type: "public-domain", attributionRequired: false },
        source: "archive.org",
        archiveIdentifier: candidate.identifier,
        fileHash: candidate.fileHash,
        region: "US",
      });
    } catch (err) {
      errors.push(`${candidate.identifier}: ${err.message}`);
      console.error(`Error processing ${candidate.identifier}:`, err.message);
    }
  }

  console.log(`Submitting ${films.length} film(s) to the light backend...`);
  const result = await submitBatch(films);

  console.log("--- Ingestion summary ---");
  console.log({
    itemsFound: candidates.length,
    itemsSkippedAsDuplicate: skippedCount,
    itemsInserted: result.inserted,
    itemsErrored: errors.length + (result.errored || 0),
  });

  if (errors.length > 0) {
    console.log("Errors:", errors);
  }
}

run().catch(async (err) => {
  console.error("Ingestion run failed:", err.message);
  Sentry.captureException(err);
  // Sentry sends events over the network asynchronously — without this,
  // the process could exit before the event actually gets delivered.
  await Sentry.flush(2000).catch(() => {});
  process.exit(1);
});
