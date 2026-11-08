// MyMusic front-end. Talks only to our own /api/* Netlify Function,
// which holds the SunoAPI key server-side.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORE_KEY = "mymusic.library.v1";
const PW_KEY = "mymusic.password";
const POLL_MS = 8000;
const MAX_POLL_MS = 20 * 60 * 1000;

const STYLE_PRESETS = ["Pop", "Hip-hop", "R&B", "Lo-fi", "Rock", "EDM", "Country", "Jazz", "Acoustic", "Cinematic", "Reggaeton", "Afrobeats", "Synthwave", "Indie folk"];
const VARIETY_LABELS = ["Off", "Normal", "High", "Extra", "Max"];
const STATUS_TEXT = {
  PENDING: "Queued…",
  TEXT_SUCCESS: "Writing lyrics done — composing music…",
  FIRST_SUCCESS: "First version ready — finishing the second…",
  SUCCESS: "Done",
  CREATE_TASK_FAILED: "Couldn't start the generation.",
  GENERATE_AUDIO_FAILED: "Audio generation failed.",
  CALLBACK_EXCEPTION: "Generation finished with an error.",
  SENSITIVE_WORD_ERROR: "Blocked: the prompt or lyrics contain restricted words.",
};

// ---------------------------------------------------------------- state
const state = {
  mode: "simple",
  vocal: "",
  library: loadLibrary(),
  pollers: new Map(),
  current: null, // { taskId, trackId }
};

function loadLibrary() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveLibrary() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.library.slice(0, 200)));
  } catch {
    /* storage full or blocked — library just won't persist */
  }
}
function getPassword() {
  try { return localStorage.getItem(PW_KEY) || ""; } catch { return ""; }
}
function setPassword(v) {
  try { localStorage.setItem(PW_KEY, v); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- api
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  const pw = getPassword();
  if (pw) headers["x-app-password"] = pw;
  let res;
  try {
    res = await fetch(`/api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("Network error — check your connection.", 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || data.ok === false) {
    if (res.status === 401 && /password/i.test(data.error || "")) askPassword();
    throw new ApiError(data.error || `Request failed (${res.status}).`, res.status);
  }
  return data;
}

// ---------------------------------------------------------------- ui helpers
let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  if (busy) {
    btn.dataset.html = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span><span>${label}</span>`;
  } else if (btn.dataset.html) {
    btn.innerHTML = btn.dataset.html;
  }
}

function showFormError(msg) {
  const el = $("#form-error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ---------------------------------------------------------------- form
function setMode(mode) {
  state.mode = mode;
  $$(".tab").forEach((t) => {
    const on = t.dataset.mode === mode;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  $$(".mode-simple").forEach((el) => (el.hidden = mode !== "simple"));
  $$(".mode-custom").forEach((el) => (el.hidden = mode !== "custom"));
  $(".mode-simple-inline").hidden = mode !== "simple";
  showFormError("");
  syncInstrumental();
}

function syncInstrumental() {
  const instrumental = $("#instrumental").checked;
  const lyricsField = $("#lyrics").closest(".field");
  lyricsField.hidden = instrumental;
  $$(".vocal-field").forEach((el) => (el.hidden = instrumental));
}

function renderChips() {
  const wrap = $("#style-chips");
  wrap.replaceChildren(
    ...STYLE_PRESETS.map((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = name;
      b.addEventListener("click", () => toggleStyle(name));
      return b;
    }),
  );
  syncChips();
}

function styleParts() {
  return $("#style").value.split(",").map((s) => s.trim()).filter(Boolean);
}
function toggleStyle(name) {
  const parts = styleParts();
  const i = parts.findIndex((p) => p.toLowerCase() === name.toLowerCase());
  if (i >= 0) parts.splice(i, 1);
  else parts.push(name);
  $("#style").value = parts.join(", ");
  syncChips();
}
function syncChips() {
  const parts = styleParts().map((p) => p.toLowerCase());
  $$("#style-chips .chip").forEach((c) => c.classList.toggle("on", parts.includes(c.textContent.toLowerCase())));
}

function bindCounters() {
  $$(".counter").forEach((c) => {
    const input = document.getElementById(c.dataset.for);
    const update = () => (c.textContent = `${input.value.length} / ${input.maxLength}`);
    input.addEventListener("input", update);
    update();
  });
}

function bindSliders() {
  const dur = $("#duration");
  const durOut = $("#duration-out");
  const upd = () => (durOut.textContent = fmtTime(Number(dur.value)));
  dur.addEventListener("input", upd);
  upd();
  for (const id of ["styleWeight", "weirdnessConstraint", "audioWeight", "variety"]) {
    const input = document.getElementById(id);
    const out = $(`output[data-for="${id}"]`);
    const u = () => (out.textContent = id === "variety" ? VARIETY_LABELS[input.value] : Number(input.value).toFixed(2));
    input.addEventListener("input", u);
    u();
  }
}

function collectRequest() {
  const instrumental = $("#instrumental").checked;
  const req = {
    customMode: state.mode === "custom",
    instrumental,
    model: $("#model").value,
    style: $("#style").value.trim(),
  };
  if (state.mode === "simple") {
    req.prompt = $("#prompt").value.trim();
    if (!req.prompt && !req.style) return { error: "Describe the song you want." };
  } else {
    req.title = $("#title").value.trim();
    req.lyrics = instrumental ? "" : $("#lyrics").value.trim();
    req.negativeTags = $("#negativeTags").value.trim();
    if (!req.style && !req.lyrics) return { error: instrumental ? "Add a style for your instrumental." : "Add a style, lyrics, or both." };
    if (!instrumental && state.vocal) req.vocalGender = state.vocal;
    req.duration = Number($("#duration").value);
    req.styleWeight = Number($("#styleWeight").value);
    req.weirdnessConstraint = Number($("#weirdnessConstraint").value);
    if (!instrumental) req.audioWeight = Number($("#audioWeight").value);
    req.variety = Number($("#variety").value);
  }
  return { req };
}

async function onGenerate(e) {
  e.preventDefault();
  showFormError("");
  const { req, error } = collectRequest();
  if (error) return showFormError(error);

  const btn = $("#generate-btn");
  setBusy(btn, true, "Starting…");
  try {
    const { taskId } = await api("generate", { method: "POST", body: req });
    if (!taskId) throw new ApiError("No task id returned.", 500);
    const entry = { taskId, createdAt: Date.now(), request: req, status: "PENDING", tracks: [], error: null };
    state.library.unshift(entry);
    saveLibrary();
    renderLibrary();
    startPolling(taskId);
    toast("Song is cooking — it'll show up on the right.");
    refreshCredits();
  } catch (err) {
    showFormError(err.message);
  } finally {
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------- AI lyrics
async function onAiLyrics() {
  const topicInput = $("#lyrics-topic");
  const topic = topicInput.value.trim() || $("#title").value.trim() || $("#style").value.trim();
  if (!topic) {
    topicInput.focus();
    return toast("Tell me what the lyrics should be about.", true);
  }
  const btn = $("#lyrics-go");
  setBusy(btn, true, "Writing…");
  const box = $("#lyrics-options");
  box.hidden = true;
  try {
    const { taskId } = await api("lyrics", { method: "POST", body: { prompt: topic } });
    const started = Date.now();
    while (Date.now() - started < 3 * 60 * 1000) {
      await sleep(4000);
      const r = await api(`lyrics-status?taskId=${encodeURIComponent(taskId)}`);
      if (r.failed) throw new ApiError(r.error || "Lyrics generation failed.", 500);
      if (r.done || r.lyrics?.length) {
        if (!r.lyrics.length) throw new ApiError("No lyrics came back. Try a different topic.", 500);
        showLyricOptions(r.lyrics);
        return;
      }
    }
    throw new ApiError("Lyrics took too long. Try again.", 504);
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
  }
}

function showLyricOptions(options) {
  const box = $("#lyrics-options");
  const pick = (o) => {
    $("#lyrics").value = o.text;
    $("#lyrics").dispatchEvent(new Event("input"));
    if (o.title && !$("#title").value.trim()) $("#title").value = o.title.slice(0, 80);
    box.hidden = true;
    $("#ai-lyrics").hidden = true;
  };
  if (options.length === 1) return pick(options[0]);
  box.replaceChildren(
    ...options.map((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lyrics-option";
      const t = document.createElement("strong");
      t.textContent = o.title || `Option ${i + 1}`;
      b.append(t, document.createTextNode(o.text.replace(/\s+/g, " ").slice(0, 110) + "…"));
      b.addEventListener("click", () => pick(o));
      return b;
    }),
  );
  box.hidden = false;
  toast("Pick a set of lyrics.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- polling
function startPolling(taskId) {
  if (state.pollers.has(taskId)) return;
  const poller = { delay: POLL_MS, timer: null };
  state.pollers.set(taskId, poller);
  const tick = async () => {
    const entry = state.library.find((e) => e.taskId === taskId);
    if (!entry) return stopPolling(taskId);
    try {
      const r = await api(`status?taskId=${encodeURIComponent(taskId)}`);
      poller.delay = POLL_MS;
      entry.status = r.status;
      if (r.tracks?.length) entry.tracks = mergeTracks(entry.tracks, r.tracks);
      if (r.failed) entry.error = r.error || STATUS_TEXT[r.status] || "Generation failed.";
      saveLibrary();
      renderTask(entry);
      if (r.done) {
        toast(`"${entry.tracks[0]?.title || "Your song"}" is ready!`);
        refreshCredits();
        return stopPolling(taskId);
      }
      if (r.failed) return stopPolling(taskId);
    } catch (err) {
      if ([405, 429, 430, 455, 0, 502].includes(err.status) || err.status >= 500) {
        poller.delay = Math.min(poller.delay * 1.6, 30000); // back off and keep trying
      } else {
        entry.error = err.message;
        saveLibrary();
        renderTask(entry);
        return stopPolling(taskId);
      }
    }
    if (Date.now() - entry.createdAt > MAX_POLL_MS) {
      entry.error = "Still not finished after 20 minutes.";
      entry.timedOut = true;
      saveLibrary();
      renderTask(entry);
      return stopPolling(taskId);
    }
    poller.timer = setTimeout(tick, poller.delay);
  };
  poller.timer = setTimeout(tick, 2500);
}

function stopPolling(taskId) {
  const p = state.pollers.get(taskId);
  if (p) clearTimeout(p.timer);
  state.pollers.delete(taskId);
  const entry = state.library.find((e) => e.taskId === taskId);
  if (entry) renderTask(entry);
}

function mergeTracks(oldTracks, newTracks) {
  return newTracks.map((t) => {
    const prev = oldTracks.find((o) => o.id && o.id === t.id) || {};
    const merged = { ...prev };
    for (const [k, v] of Object.entries(t)) if (v) merged[k] = v;
    return merged;
  });
}

function isFinal(entry) {
  return entry.status === "SUCCESS" || !!entry.error;
}

// ---------------------------------------------------------------- library rendering
function renderLibrary() {
  const lib = $("#library");
  const nodes = state.library.map((entry) => buildTask(entry));
  lib.replaceChildren(...nodes);
  $("#empty").hidden = state.library.length > 0;
  $("#library-count").textContent = state.library.length ? `${state.library.length} generation${state.library.length > 1 ? "s" : ""}` : "";
}

function renderTask(entry) {
  const old = document.querySelector(`.task[data-task="${CSS.escape(entry.taskId)}"]`);
  const fresh = buildTask(entry);
  if (old) old.replaceWith(fresh);
  else renderLibrary();
}

function describeRequest(req) {
  if (!req) return "Untitled";
  if (req.customMode) return req.title || req.style || (req.lyrics || "").split("\n").find((l) => l && !l.startsWith("[")) || "Custom song";
  return req.prompt || req.style || "Song";
}

function buildTask(entry) {
  const node = $("#task-tpl").content.firstElementChild.cloneNode(true);
  node.dataset.task = entry.taskId;
  const req = entry.request || {};
  $(".task-prompt", node).textContent = describeRequest(req);
  const meta = [timeAgo(entry.createdAt), req.customMode ? "Custom" : "Simple", (req.model || "V6").replace("_", " "), req.instrumental ? "Instrumental" : null].filter(Boolean);
  $(".task-meta", node).textContent = meta.join(" · ");
  $(".task-remove", node).addEventListener("click", () => removeTask(entry.taskId));

  const statusEl = $(".task-status", node);
  if (entry.error) {
    const line = document.createElement("div");
    line.className = "status-line error";
    line.textContent = entry.error;
    if (entry.timedOut || entry.status !== "SUCCESS") {
      const retry = document.createElement("button");
      retry.className = "chip-btn retry";
      retry.textContent = "Check again";
      retry.addEventListener("click", () => {
        entry.error = null;
        entry.timedOut = false;
        entry.createdAt = Date.now();
        saveLibrary();
        renderTask(entry);
        startPolling(entry.taskId);
      });
      line.append(retry);
    }
    statusEl.append(line);
  } else if (entry.status !== "SUCCESS") {
    const line = document.createElement("div");
    line.className = "status-line";
    line.textContent = STATUS_TEXT[entry.status] || "Working…";
    const bar = document.createElement("div");
    bar.className = "progress";
    bar.innerHTML = "<i></i>";
    statusEl.append(line, bar);
  }

  const tracksEl = $(".task-tracks", node);
  (entry.tracks || []).forEach((t) => tracksEl.append(buildTrack(entry, t)));
  return node;
}

function buildTrack(entry, t) {
  const node = $("#track-tpl").content.firstElementChild.cloneNode(true);
  node.dataset.track = t.id;
  const playable = t.audioUrl || t.streamUrl;
  const img = $("img", node);
  if (t.imageUrl) img.src = t.imageUrl;
  img.onerror = () => img.removeAttribute("src");
  $(".track-title", node).textContent = t.title || "Untitled";
  $(".track-tags", node).textContent = t.tags || "";
  $(".badge", node).textContent = t.duration ? fmtTime(t.duration) : t.audioUrl ? "" : "streaming";

  const art = $(".art", node);
  art.disabled = !playable;
  art.addEventListener("click", () => togglePlay(entry, t));

  const lyricsBtn = $(".lyrics-btn", node);
  if (!t.lyrics || entry.request?.instrumental) lyricsBtn.remove();
  else lyricsBtn.addEventListener("click", () => showLyrics(t));

  $(".reuse-btn", node).addEventListener("click", () => reuse(entry, t));

  const dl = $(".dl-btn", node);
  if (t.audioUrl) {
    dl.href = t.audioUrl;
    dl.setAttribute("download", `${(t.title || "song").replace(/[^\w\- ]+/g, "").trim() || "song"}.mp3`);
  } else {
    dl.classList.add("disabled");
    dl.removeAttribute("href");
  }

  if (state.current?.trackId === t.id) {
    node.classList.add("playing");
    if (!audio.paused) art.classList.add("is-playing");
  }
  return node;
}

function removeTask(taskId) {
  stopPolling(taskId);
  state.library = state.library.filter((e) => e.taskId !== taskId);
  saveLibrary();
  renderLibrary();
}

function showLyrics(t) {
  $("#lyrics-dialog-title").textContent = t.title || "Lyrics";
  $("#lyrics-dialog-body").textContent = t.lyrics;
  $("#lyrics-dialog").showModal();
}

function reuse(entry, t) {
  const req = entry.request || {};
  setMode(req.customMode ? "custom" : "simple");
  $("#instrumental").checked = !!req.instrumental;
  $("#model").value = req.model || "V6";
  $("#style").value = req.style || t.tags || "";
  if (req.customMode) {
    $("#title").value = req.title || t.title || "";
    $("#lyrics").value = req.lyrics || t.lyrics || "";
    $("#negativeTags").value = req.negativeTags || "";
    if (req.duration) $("#duration").value = req.duration;
    state.vocal = req.vocalGender || "";
    $$("#vocal button").forEach((b) => b.classList.toggle("active", b.dataset.v === state.vocal));
  } else {
    $("#prompt").value = req.prompt || "";
  }
  $$("input, textarea").forEach((el) => el.dispatchEvent(new Event("input")));
  syncChips();
  syncInstrumental();
  $(".create").scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Settings loaded — tweak and generate again.");
}

// ---------------------------------------------------------------- player
const audio = $("#audio");

function togglePlay(entry, t) {
  const src = t.audioUrl || t.streamUrl;
  if (!src) return;
  if (state.current?.trackId === t.id) {
    if (audio.paused) audio.play().catch(() => toast("Couldn't play this track.", true));
    else audio.pause();
    return;
  }
  state.current = { taskId: entry.taskId, trackId: t.id };
  audio.src = src;
  audio.play().catch(() => toast("Couldn't play this track.", true));
  $("#player").hidden = false;
  document.body.classList.add("has-player");
  $("#player-title").textContent = t.title || "Untitled";
  $("#player-tags").textContent = t.tags || "";
  const art = $("#player-art");
  if (t.imageUrl) art.src = t.imageUrl;
  else art.removeAttribute("src");
  syncPlayingUi();
}

function syncPlayingUi() {
  const playing = !audio.paused;
  $("#player-toggle").classList.toggle("is-playing", playing);
  $("#player-toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
  $$(".track-card").forEach((c) => {
    const on = c.dataset.track === state.current?.trackId;
    c.classList.toggle("playing", on);
    $(".art", c).classList.toggle("is-playing", on && playing);
  });
}

function bindPlayer() {
  const seek = $("#player-seek");
  let seeking = false;
  audio.addEventListener("play", syncPlayingUi);
  audio.addEventListener("pause", syncPlayingUi);
  audio.addEventListener("ended", syncPlayingUi);
  audio.addEventListener("loadedmetadata", () => ($("#player-dur").textContent = fmtTime(audio.duration)));
  audio.addEventListener("timeupdate", () => {
    $("#player-cur").textContent = fmtTime(audio.currentTime);
    if (Number.isFinite(audio.duration)) {
      $("#player-dur").textContent = fmtTime(audio.duration);
      if (!seeking) seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    }
  });
  audio.addEventListener("error", () => audio.src && toast("This audio couldn't be loaded (files expire after 14 days).", true));
  seek.addEventListener("input", () => (seeking = true));
  seek.addEventListener("change", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    seeking = false;
  });
  $("#player-toggle").addEventListener("click", () => {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && audio.src && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      audio.paused ? audio.play().catch(() => {}) : audio.pause();
    }
  });
}

// ---------------------------------------------------------------- credits & password
async function refreshCredits() {
  try {
    const { credits } = await api("credits");
    $("#credits-value").textContent = Number(credits).toLocaleString();
    $("#credits").hidden = false;
  } catch {
    /* hide silently */
  }
}

let pwOpen = false;
function askPassword() {
  if (pwOpen) return;
  pwOpen = true;
  const dlg = $("#pw-dialog");
  $("#pw-input").value = "";
  dlg.showModal();
}

// ---------------------------------------------------------------- init
async function init() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  $("#instrumental").addEventListener("change", syncInstrumental);
  $("#style").addEventListener("input", syncChips);
  $("#create-form").addEventListener("submit", onGenerate);
  $("#ai-lyrics-btn").addEventListener("click", () => {
    const box = $("#ai-lyrics");
    box.hidden = !box.hidden;
    if (!box.hidden) $("#lyrics-topic").focus();
  });
  $("#lyrics-go").addEventListener("click", onAiLyrics);
  $("#lyrics-topic").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onAiLyrics(); }
  });
  $$("#vocal button").forEach((b) =>
    b.addEventListener("click", () => {
      state.vocal = b.dataset.v;
      $$("#vocal button").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  $("#lyrics-close").addEventListener("click", () => $("#lyrics-dialog").close());
  $("#lyrics-dialog").addEventListener("click", (e) => e.target === e.currentTarget && e.currentTarget.close());
  $("#pw-form").addEventListener("submit", () => {
    setPassword($("#pw-input").value);
    pwOpen = false;
    refreshCredits();
    state.library.filter((e) => !isFinal(e)).forEach((e) => startPolling(e.taskId));
  });
  $("#pw-dialog").addEventListener("cancel", () => (pwOpen = false));

  renderChips();
  bindCounters();
  bindSliders();
  bindPlayer();
  setMode("simple");
  renderLibrary();
  setInterval(() => $$(".task").length && renderLibrary(), 60000); // refresh "x min ago"

  try {
    const cfg = await api("config");
    if (cfg.passwordRequired && !getPassword()) return askPassword();
  } catch {
    /* ignore */
  }
  refreshCredits();
  state.library.filter((e) => !isFinal(e)).forEach((e) => startPolling(e.taskId));
}

init();
