# EngInQuire Schedule Generator — Setup Guide

This is your Tier 3 build: a standalone web app that takes a student's block +
email + free-text preferences and generates a personalized weekly schedule using
Google Gemini (free tier). It gives you a URL you can drop straight into Linktree.

---

## What's in this folder

```
enginquire-generator/
├── public/
│   └── index.html        ← the page students see (form + rendered schedule)
├── api/
│   ├── generate.js       ← serverless function (holds the Gemini key, calls AI)
│   └── blocks.json       ← all 10 blocks × 2 semesters (your verified data)
├── vercel.json           ← Vercel routing config
├── package.json          ← declares Node 18+
└── SETUP.md              ← this file
```

Delete `preview.html`, `rendertest.html`, and any `*.png` before deploying —
they're just local test files.

---

## One-time setup (about 15 minutes)

### 1. Get a free Gemini API key

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with a Google account.
3. Click **Create API key**. Copy it (starts with `AIza...`).
4. Do NOT enable billing — the free tier stays free only while billing is off.
   Build on `gemini-2.5-flash` (already set in the code); it's free-tier eligible.

> Privacy note: Google's free tier may use inputs to improve their models. That's
> fine here (first name + block + "I'm not a morning person" is low-stakes), but
> never pipe anything sensitive through it.

### 2. (Optional) Get a Web3Forms key for lead capture

This is how student name + email + block lands in enginquire7@gmail.com.

1. Go to **https://web3forms.com**
2. Enter enginquire7@gmail.com, get an **Access Key** emailed to you.
3. Paste it into the `WEB3FORMS_KEY` constant near the top of the `<script>` block in
   `public/index.html`. Web3Forms' free plan blocks server-to-server calls, so this key
   lives in the client-side JS and the browser submits leads directly — that's expected,
   the key only allows submissions into your inbox. (If you skip this, generation still
   works — you just won't collect leads.)

### 3. Put the folder on GitHub

1. Create a new repo on GitHub (e.g. `enginquire-generator`), keep it public or private.
2. Upload this whole folder to it (drag-and-drop in the GitHub web UI works, or use git).

### 4. Deploy on Vercel

1. Go to **https://vercel.com** and sign up (free) — sign in **with GitHub**.
2. Click **Add New… → Project**, pick your `enginquire-generator` repo, click **Import**.
3. Before deploying, expand **Environment Variables** and add:

   | Name              | Value                          |
   |-------------------|--------------------------------|
   | `GEMINI_API_KEY`  | your `AIza...` key from step 1 |

4. Click **Deploy**. Wait ~1 minute.
5. Vercel gives you a URL like `https://enginquire-generator.vercel.app`.

That URL is your product. Test it, then put it in Linktree as item 3:
**"Free Schedule Generator."**

---

## Updating class data later

If a timetable changes, edit `api/blocks.json` (same format you verified), commit
to GitHub, and Vercel redeploys automatically. No other changes needed.

---

## How it works (the important design bit)

The student's **real class times are fixed** — they come straight from
`blocks.json` and are never sent to the AI as something it can change. Gemini's
only job is to arrange the **flexible** blocks (study, gym, commute, lunch,
projects, rest) in the gaps, guided by the student's free-text note.

Before anything renders, `generate.js` **validates** the AI's output: it drops any
block that overlaps a real class, uses an unknown category, has a bad time, or
runs past the day. So even if the model misbehaves, the student never sees a
broken or class-clashing schedule. That validation is the safety net that makes
an AI feature trustworthy.

---

## Costs

- **Vercel**: free tier is plenty for this.
- **Gemini**: free tier — `gemini-2.5-flash` at ~10 requests/min, 250/day. Since
  each student is one request, you'd need 250 generations in a day to hit the cap.
- **Web3Forms**: free tier covers 250 submissions/month.

Total: **$0** at your scale.
