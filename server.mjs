#!/usr/bin/env node
/**
 * server.mjs — serves the viewer pages AND drives the Marble API.
 *
 * Usage:
 *   node server.mjs          (reads WLT_API_KEY from .env)
 *   → http://localhost:5173
 *
 * Endpoints:
 *   GET /api/create?prompt=...    start generating a world → { job_id }
 *   GET /api/job?id=...           poll a job → { status, elapsed, world? }
 *   GET /api/worlds               gallery of every world generated so far
 *   GET /api/prefetch?prompt=...  start the "next world" slot (mission chaining)
 *   GET /api/status               next-world slot state
 *   GET /api/take                 consume the next world when ready
 *   (everything else)             static files from ./viewer
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = join(HERE, "viewer");
const WORLDS_FILE = join(VIEWER, "worlds.json");
const PORT = 5173;
const BASE = "https://api.worldlabs.ai/marble/v1";

// Load .env
try {
  for (const line of readFileSync(join(HERE, ".env"), "utf8").split("\n")) {
    const [k, ...rest] = line.split("=");
    if (k && rest.length && !process.env[k.trim()]) process.env[k.trim()] = rest.join("=").trim();
  }
} catch {}

const API_KEY = process.env.WLT_API_KEY;
if (!API_KEY) {
  console.error("✗ Set WLT_API_KEY in .env");
  process.exit(1);
}
// key: per-request user key (BYO credits, session-scoped in the browser)
// falls back to the server's .env key
async function api(path, options = {}, key) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "WLT-Api-Key": key || API_KEY, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

function toWorldShape(w) {
  const spz = w.assets?.splats?.spz_urls ?? {};
  return {
    prompt: w.display_name || w.world_prompt?.text_prompt?.slice(0, 80) || "untitled world",
    world_id: w.world_id,
    splat_url: spz.full_res ?? Object.values(spz)[0] ?? null,
    splat_url_game: spz["500k"] ?? spz["150k"] ?? spz["100k"] ?? null,
    collider_mesh_url: w.assets?.mesh?.collider_mesh_url ?? null,
    thumbnail_url: w.assets?.thumbnail_url ?? null,
    // the API's own metric calibration — the real world scale, no guessing
    scale: w.assets?.splats?.semantics_metadata?.metric_scale_factor ?? null,
    created_at: w.created_at ?? new Date().toISOString(),
  };
}

// --- Core generation --------------------------------------------------------
async function generateWorld(prompt, quality = "mini", key) {
  const op = await api("/worlds:generate", {
    method: "POST",
    body: JSON.stringify({
      display_name: prompt.slice(0, 60),
      model: quality === "plus" ? "Marble 0.1-plus" : "Marble 0.1-mini",
      world_prompt: { type: "text", text_prompt: prompt },
      permission: { public: false },
    }),
  }, key);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    let result;
    try {
      result = await api(`/operations/${op.operation_id}`, {}, key);
    } catch (e) {
      // transient network blip mid-poll — don't abort a long generation
      console.warn(`  poll retry: ${e.message}`);
      continue;
    }
    if (result.done) {
      if (result.error) throw new Error(JSON.stringify(result.error));
      return { ...toWorldShape(result.response), prompt };
    }
    if (Date.now() - started > 20 * 60_000) throw new Error("Timed out after 20 min");
  }
}

// --- World gallery (persisted so share-links survive restarts) --------------
let worlds = [];
try { worlds = JSON.parse(readFileSync(WORLDS_FILE, "utf8")); } catch {}
function saveWorlds() { writeFileSync(WORLDS_FILE, JSON.stringify(worlds, null, 2)); }

// --- Public generation jobs (the "prompt the ad" flow) ----------------------
const jobs = new Map();
let jobSeq = 0;

function startJob(prompt, quality, key) {
  const id = `j${++jobSeq}-${Date.now().toString(36)}`;
  const job = { status: "generating", prompt, startedAt: Date.now(), world: null, error: null };
  jobs.set(id, job);
  console.log(`▸ [${id}] generating (${quality}${key ? ", user key" : ""}): "${prompt}"`);
  generateWorld(prompt, quality, key)
    .then((world) => {
      job.status = "ready";
      job.world = world;
      worlds.unshift(world);
      saveWorlds();
      console.log(`✓ [${id}] ready (${((Date.now() - job.startedAt) / 60000).toFixed(1)} min)`);
    })
    .catch((e) => {
      job.status = "error";
      job.error = e.message;
      console.error(`✗ [${id}] failed: ${e.message}`);
    });
  return id;
}

// --- HTTP --------------------------------------------------------------------
const MIME = {
  ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/create") {
    const prompt = url.searchParams.get("prompt")?.trim();
    if (!prompt) return send(400, { error: "missing prompt" });
    const quality = url.searchParams.get("quality") === "plus" ? "plus" : "mini";
    return send(200, { job_id: startJob(prompt, quality, req.headers["x-wlt-key"]) });
  }
  if (url.pathname === "/api/my-worlds") {
    const key = req.headers["x-wlt-key"];
    if (!key) return send(400, { error: "missing API key" });
    api("/worlds:list", { method: "POST", body: JSON.stringify({ page_size: 50 }) }, key)
      .then((data) => send(200, (data.worlds ?? []).map(toWorldShape).filter((w) => w.splat_url)))
      .catch((e) => send(502, { error: e.message }));
    return;
  }
  if (url.pathname === "/api/job") {
    const job = jobs.get(url.searchParams.get("id"));
    if (!job) return send(404, { error: "unknown job" });
    return send(200, {
      status: job.status,
      elapsed: Date.now() - job.startedAt,
      world: job.status === "ready" ? job.world : null,
      error: job.error,
    });
  }
  if (url.pathname === "/api/worlds") return send(200, worlds);

  // Static files from viewer/ — the game IS the site
  const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(VIEWER, safe === "/" ? "war.html" : safe);
  if (!file.startsWith(VIEWER) || !existsSync(file)) return send(404, { error: "not found" });
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`▸ Walk Into the Ad — http://localhost:${PORT}/ad.html`));
