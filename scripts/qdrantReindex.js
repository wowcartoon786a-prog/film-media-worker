/**
 * film-media-worker/scripts/qdrantReindex.js
 *
 * Fetches the list of approved films from the light backend's service API
 * (read-only — no MongoDB access from here), embeds each one via Nomic,
 * and upserts directly into Qdrant. Qdrant isn't the source of truth for
 * film data (MongoDB, owned exclusively by the light backend, is) — it's
 * a derived search index, so it's fine for this script to write to it
 * directly rather than routing through the light backend.
 */

const { QdrantClient } = require("@qdrant/js-client-rest");
const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: "heavy-backend",
    initialScope: { tags: { service: "heavy-backend", script: "qdrant-reindex" } },
  });
}

const NOMIC_API_KEY = process.env.NOMIC_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "films";
const BACKEND_CALLBACK_URL = process.env.BACKEND_CALLBACK_URL;
const SERVICE_API_SECRET = process.env.SERVICE_API_SECRET;
const JOB_RUN_ID = process.env.JOB_RUN_ID;

const EMBEDDING_MODEL = "nomic-embed-text-v1.5";
const EMBEDDING_DIMENSIONS = 768;
const REQUEST_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backendUrl(path) {
  return `${BACKEND_CALLBACK_URL.replace(/\/$/, "")}${path}`;
}

function backendHeaders() {
  return { "Content-Type": "application/json", "X-Service-Secret": SERVICE_API_SECRET };
}

function objectIdToUuid(objectId) {
  const hex = String(objectId).padStart(24, "0").slice(0, 24);
  const padded = hex + "00000000";
  return [padded.slice(0, 8), padded.slice(8, 12), padded.slice(12, 16), padded.slice(16, 20), padded.slice(20, 32)].join("-");
}

function buildEmbeddingText(film) {
  const parts = [
    film.title,
    film.description,
    ...(Array.isArray(film.tags) ? film.tags : []),
    ...(Array.isArray(film.category) ? film.category : []),
  ].filter(Boolean);
  return parts.join(". ");
}

async function getEmbedding(text) {
  const res = await fetch("https://api-atlas.nomic.ai/v1/embedding/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${NOMIC_API_KEY}` },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      texts: [text],
      task_type: "search_document",
      dimensionality: EMBEDDING_DIMENSIONS,
    }),
  });
  if (!res.ok) {
    throw new Error(`Nomic embeddings request failed (HTTP ${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const vector = data?.embeddings?.[0];
  if (!Array.isArray(vector)) throw new Error("Nomic response did not contain an embedding vector");
  return vector;
}

async function fetchApprovedFilms() {
  const res = await fetch(backendUrl("/api/service/films/for-embedding"), {
    headers: backendHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch films for embedding (HTTP ${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function reportComplete(status, result, error) {
  await fetch(backendUrl(`/api/service/jobs/${JOB_RUN_ID}/complete`), {
    method: "POST",
    headers: backendHeaders(),
    body: JSON.stringify({ status, result, error }),
  });
}

async function run() {
  if (!NOMIC_API_KEY) throw new Error("Missing NOMIC_API_KEY");
  if (!QDRANT_URL) throw new Error("Missing QDRANT_URL");
  if (!BACKEND_CALLBACK_URL || !SERVICE_API_SECRET || !JOB_RUN_ID) {
    throw new Error("Missing BACKEND_CALLBACK_URL / SERVICE_API_SECRET / JOB_RUN_ID");
  }

  const qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

  const { collections } = await qdrant.getCollections();
  if (!collections.some((c) => c.name === QDRANT_COLLECTION)) {
    await qdrant.createCollection(QDRANT_COLLECTION, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
    });
  }

  const films = await fetchApprovedFilms();
  console.log(`Found ${films.length} approved film(s) to index.`);

  let indexed = 0;
  let failed = 0;

  for (const film of films) {
    try {
      const text = buildEmbeddingText(film);
      const vector = await getEmbedding(text);
      await qdrant.upsert(QDRANT_COLLECTION, {
        points: [
          {
            id: objectIdToUuid(film._id),
            vector,
            payload: { filmId: String(film._id), title: film.title, year: film.year },
          },
        ],
      });
      indexed += 1;
      console.log(`Indexed: ${film.title}`);
    } catch (err) {
      failed += 1;
      console.error(`Failed to index "${film.title}":`, err.message);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Done. Indexed ${indexed}, failed ${failed}.`);
  await reportComplete("completed", { indexed, failed, total: films.length });
}

run().catch(async (err) => {
  console.error("Reindex run failed:", err.message);
  Sentry.captureException(err);
  try {
    await reportComplete("failed", null, err.message);
  } catch (reportErr) {
    console.error("Additionally failed to report failure:", reportErr.message);
    Sentry.captureException(reportErr);
  }
  // Sentry sends events over the network asynchronously — without this,
  // the process could exit before the events actually get delivered.
  await Sentry.flush(2000).catch(() => {});
  process.exit(1);
});
