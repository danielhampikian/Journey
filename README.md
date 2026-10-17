# Journey
Helps create and track progress towards goals over time and provides motivational conversation and stats through an intuitive web app with TTS and STT capabilities for audio conversations as well as typed chat. 

## Features

- **Morning check-in** – talk (or type) with an OpenAI-powered coach to set concrete goals for the day that ladder up to your weekly, monthly, yearly and life goals.
- **Evening check-in** – review the morning's goals: what you got done, what you only partly did or missed, your wins and your struggles.
- **Voice conversations** – your speech is recorded in the browser and transcribed with OpenAI Whisper; the coach's replies are spoken back with OpenAI text-to-speech (falling back to the browser's built-in speech synthesis).
- **History** – every conversation is saved with its date, start/end time, AI summary, goals, outcomes, wins, struggles and full text transcript.
- **Progress dashboard** – check-in streaks, goal completion rates (7-day and all-time), week-over-week trend, a 14-day completion chart, recurring struggles and a motivational message.
- **Coach suggestions** – on demand, the AI analyses your goals, stats and recent check-ins and suggests how to improve both goal *setting* and goal *accomplishing*.
- **Goal hierarchy** – define life, yearly, monthly and weekly goals. When a level is missing or hasn't been reviewed for a while (life: 180 days, yearly: 90, monthly: 30, weekly: 7) the app shows a banner and the coach occasionally prompts you to define or refine it during a check-in. Goals you refine out loud in a conversation are saved automatically.

## Getting started

Requires Node.js 20+ (uses the built-in `fetch`, `FormData` and `node:test`).

```bash
npm install
cp .env.example .env   # then add your OPENAI_API_KEY
npm start              # http://127.0.0.1:3000
```

Microphone access requires a secure context, so open the app via `localhost`/`127.0.0.1` (or serve it over HTTPS).

Data is stored in `data/journey.json` (git-ignored). The app has no user accounts and is intended for personal use; it binds to `127.0.0.1` by default – put it behind authentication before exposing it on a network with `HOST=0.0.0.0`.

## Development

```bash
npm test
```

### Project layout

| Path | Purpose |
| --- | --- |
| `server/index.js` | Entry point: loads `.env`, wires the store and OpenAI client, starts the server |
| `server/app.js` | Express REST API (`/api/conversations`, `/api/goals`, `/api/stats`, `/api/insights`, `/api/transcribe`, `/api/speech`) |
| `server/ai.js` | OpenAI REST client and the coaching prompts |
| `server/stats.js` | Completion, streak, trend and struggle statistics |
| `server/goals.js` | Goal-hierarchy review rules |
| `server/store.js` | JSON-file persistence |
| `public/` | Single-page frontend (vanilla JS, SVG charts) |
| `test/` | `node:test` unit and API tests (OpenAI is mocked) |
