// Netlify Function: server-side proxy to SunoAPI.org.
// The API key never reaches the browser — it is read from the
// SUNO_API_KEY environment variable configured in Netlify.
//
// Routes (all under /api/*):
//   POST /api/generate        -> POST /api/v1/generate
//   GET  /api/status?taskId=  -> GET  /api/v1/generate/record-info
//   POST /api/lyrics          -> POST /api/v1/lyrics
//   GET  /api/lyrics-status?taskId= -> GET /api/v1/lyrics/record-info
//   GET  /api/credits         -> GET  /api/v1/generate/credit
//   POST /api/callback        <- SunoAPI webhook (acknowledged; the UI polls instead)

const API_BASE = (process.env.SUNO_API_BASE || "https://api.sunoapi.org").replace(/\/+$/, "");
const MODELS = ["V6", "V6_WILD", "V6_MINI"];

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (status, error) => json(status, { ok: false, error });

const ERROR_TEXT = {
  400: "Invalid parameters.",
  401: "SunoAPI rejected the API key. Check SUNO_API_KEY in your Netlify environment variables.",
  404: "Invalid request method or path.",
  405: "Rate limit exceeded. Try again in a moment.",
  413: "Prompt or style is too long.",
  429: "Out of SunoAPI credits. Top up at sunoapi.org.",
  430: "Too many requests. Please slow down and try again.",
  455: "SunoAPI is under maintenance. Try again later.",
  500: "SunoAPI server error. Try again later.",
};

async function suno(path, { method = "GET", body } = {}) {
  const key = process.env.SUNO_API_KEY;
  if (!key) {
    return { ok: false, status: 500, error: "Server is missing SUNO_API_KEY. Add it in Netlify → Site configuration → Environment variables." };
  }
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 502, error: "Could not reach SunoAPI." };
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON */
  }
  const code = payload?.code ?? res.status;
  if (!res.ok || code !== 200) {
    const msg = payload?.msg && payload.msg !== "success" ? payload.msg : ERROR_TEXT[code] || `SunoAPI error (${code}).`;
    return { ok: false, status: code >= 400 && code < 600 ? code : 502, error: msg };
  }
  return { ok: true, data: payload.data };
}

function callbackUrl(req) {
  const site = process.env.URL || new URL(req.url).origin;
  return `${site.replace(/\/+$/, "")}/api/callback`;
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

function buildGenerateBody(input, req) {
  const customMode = !!input.customMode;
  const instrumental = !!input.instrumental;
  const model = MODELS.includes(input.model) ? input.model : "V6";
  const body = { customMode, instrumental, model, callBackUrl: callbackUrl(req) };

  const style = str(input.style, 1000);
  const lyrics = instrumental ? "" : str(input.lyrics, 5000);

  if (!customMode) {
    const prompt = str(input.prompt, 3000);
    if (!prompt && !style && !lyrics) return { error: "Describe the song you want." };
    if (prompt) body.prompt = prompt;
    // Simple mode requires at least one of style/lyrics/attachments.
    // Fall back to using the description as the style when none is given.
    body.style = style || prompt.slice(0, 1000);
    if (lyrics) body.lyrics = lyrics;
    return { body };
  }

  const title = str(input.title, 80);
  const negativeTags = str(input.negativeTags, 1000);
  if (!style && !lyrics && !negativeTags) return { error: "Add a style or lyrics." };
  if (title) body.title = title;
  if (style) body.style = style;
  if (lyrics) body.lyrics = lyrics;
  if (negativeTags) body.negativeTags = negativeTags;
  if (!instrumental && (input.vocalGender === "m" || input.vocalGender === "f")) body.vocalGender = input.vocalGender;

  const duration = num(input.duration, 10, 360);
  if (duration !== undefined) body.duration = Math.round(duration);
  for (const k of ["styleWeight", "weirdnessConstraint"]) {
    const v = num(input[k], 0, 1);
    if (v !== undefined) body[k] = Math.round(v * 100) / 100;
  }
  if (!instrumental) {
    const v = num(input.audioWeight, 0, 1);
    if (v !== undefined) body.audioWeight = Math.round(v * 100) / 100;
  }
  const variety = num(input.variety, 0, 4);
  if (variety !== undefined) body.variety = Math.round(variety);
  return { body };
}

// SunoAPI examples use snake_case, live responses commonly use camelCase — accept both.
const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k]) return o[k];
  return "";
};

function normalizeTrack(t) {
  return {
    id: pick(t, "id"),
    title: pick(t, "title"),
    tags: pick(t, "tags"),
    lyrics: pick(t, "prompt"),
    duration: Number(pick(t, "duration")) || 0,
    audioUrl: pick(t, "audioUrl", "audio_url", "sourceAudioUrl", "source_audio_url"),
    streamUrl: pick(t, "streamAudioUrl", "stream_audio_url", "sourceStreamAudioUrl", "source_stream_audio_url"),
    imageUrl: pick(t, "imageUrl", "image_url", "sourceImageUrl", "source_image_url"),
    model: pick(t, "modelName", "model_name"),
    createdAt: pick(t, "createTime", "create_time"),
  };
}

const FAILED = ["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "CALLBACK_EXCEPTION", "SENSITIVE_WORD_ERROR", "FAILED"];

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function checkPassword(req) {
  const required = process.env.APP_PASSWORD;
  if (!required) return true;
  return req.headers.get("x-app-password") === required;
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const method = req.method.toUpperCase();

  // SunoAPI posts results here; we only need to acknowledge them.
  if (route === "callback") return json(200, { ok: true });

  if (route === "config" && method === "GET") {
    return json(200, { ok: true, passwordRequired: !!process.env.APP_PASSWORD, models: MODELS });
  }

  if (!checkPassword(req)) return fail(401, "Wrong or missing app password.");

  if (route === "credits" && method === "GET") {
    const r = await suno("/api/v1/generate/credit");
    return r.ok ? json(200, { ok: true, credits: r.data }) : fail(r.status, r.error);
  }

  if (route === "generate" && method === "POST") {
    const input = await readBody(req);
    if (!input) return fail(400, "Invalid JSON body.");
    const { body, error } = buildGenerateBody(input, req);
    if (error) return fail(400, error);
    const r = await suno("/api/v1/generate", { method: "POST", body });
    if (!r.ok) return fail(r.status, r.error);
    return json(200, { ok: true, taskId: r.data?.taskId });
  }

  if (route === "status" && method === "GET") {
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return fail(400, "taskId is required.");
    const r = await suno(`/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`);
    if (!r.ok) return fail(r.status, r.error);
    const d = r.data || {};
    const raw = d.response?.sunoData || d.response?.data || [];
    const status = d.status || "PENDING";
    return json(200, {
      ok: true,
      taskId,
      status,
      done: status === "SUCCESS",
      failed: FAILED.includes(status),
      error: d.errorMessage || null,
      tracks: Array.isArray(raw) ? raw.map(normalizeTrack) : [],
    });
  }

  if (route === "lyrics" && method === "POST") {
    const input = await readBody(req);
    const prompt = str(input?.prompt, 200);
    if (!prompt) return fail(400, "Describe what the lyrics should be about.");
    const r = await suno("/api/v1/lyrics", { method: "POST", body: { prompt, callBackUrl: callbackUrl(req) } });
    return r.ok ? json(200, { ok: true, taskId: r.data?.taskId }) : fail(r.status, r.error);
  }

  if (route === "lyrics-status" && method === "GET") {
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return fail(400, "taskId is required.");
    const r = await suno(`/api/v1/lyrics/record-info?taskId=${encodeURIComponent(taskId)}`);
    if (!r.ok) return fail(r.status, r.error);
    const d = r.data || {};
    const status = d.status || "PENDING";
    const items = (d.response?.data || []).map((x) => ({ title: x.title || "", text: x.text || "" })).filter((x) => x.text);
    return json(200, {
      ok: true,
      status,
      done: status === "SUCCESS",
      failed: FAILED.includes(status) || /FAILED|ERROR/.test(status),
      error: d.errorMessage || null,
      lyrics: items,
    });
  }

  return fail(404, "Not found.");
};

export const config = { path: "/api/*" };
