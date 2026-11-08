# MyMusic

An AI music generator web app powered by [SunoAPI.org](https://docs.sunoapi.org/). Users describe a song (or write their own lyrics), and the app generates two full song variations with cover art that they can play and download.

## Features

- **Simple mode**: describe a song in plain words, and optionally pick a style.
- **Custom mode**: set the title, lyrics, style, voice (male/female), length (10s–6min), excluded styles, and advanced sliders (style strength, weirdness, audio weight, variety).
- **AI lyrics**: "Write lyrics for me" generates lyric options from a topic.
- Instrumental toggle and a choice of models (V6, V6 Wild, V6 Mini).
- A song library that's saved in the browser. It shows live progress while songs generate, has a built-in player, and lets users view lyrics, download MP3s, and reuse settings.
- A remaining-credits indicator.
- An optional password gate so strangers can't spend your credits.

## How it works

```
browser (public/)  ──►  /api/*  (netlify/functions/api.mjs)  ──►  api.sunoapi.org
```

The front end is plain HTML/CSS/JS with no build step. All SunoAPI calls go through a single Netlify Function, which keeps the API key on the server. The key is never sent to the browser or committed to the repo. Generation status is checked by polling. SunoAPI requires a `callBackUrl`, so the function points it at `/api/callback`, which just acknowledges the request.

## Deploy on Netlify

1. In Netlify, choose **Add new site → Import from Git** and pick this repo (branch `main`). The build settings come from `netlify.toml`: publish dir is `public`, functions dir is `netlify/functions`, and there's no build command.
2. Go to **Site configuration → Environment variables** and add:
   - `SUNO_API_KEY`: your SunoAPI.org key (**required**)
   - `APP_PASSWORD`: optional. If you set it, visitors must enter this password before they can generate.
3. Redeploy so the function picks up the variables.

## Local development

```bash
cp .env.example .env   # then put your key in .env
npm run dev            # http://localhost:8888
```

You don't need any dependencies. You only need Node 18 or newer. You can also run `netlify dev` if you have the Netlify CLI installed.

## Notes

- Generated audio is hosted by SunoAPI for **14 days**, so download the tracks you want to keep.
- Each generation uses SunoAPI credits. If you're out of credits, the app shows a clear error message.
