// EngInQuire — Schedule Generator serverless function
// Runs on Vercel. Holds the Gemini API key (never exposed to the browser).
//
// Flow:
//   1. Receive { block, semester, firstName, lastName, email, considerations }
//   2. Look up the student's REAL fixed class times from blocks.json
//   3. Ask Gemini to arrange only the FLEXIBLE blocks around those fixed classes
//   4. Validate Gemini's JSON against a strict schema before returning it
//   5. Log the lead (name + email + block) via Web3Forms
//
// The model never invents class times. Fixed classes come from our data;
// the model only fills the gaps. Code validates before anything is trusted.

const fs = require('fs');
const path = require('path');

// ---- Config -------------------------------------------------------------

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const FLEX_CATEGORIES = [
  'Commute', 'Study', 'Gym', 'Project', 'Lunch', 'Club', 'Free', 'Prep', 'WindDown',
];

// ---- Helpers ------------------------------------------------------------

function loadBlocks() {
  const p = path.join(process.cwd(), 'api', 'blocks.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fmt(t) {
  const h = Math.floor(t);
  const m = t % 1 ? '30' : '00';
  return `${h}:${m}`;
}

// Turn the fixed classes into a compact human-readable string for the prompt
function describeClasses(classes) {
  const byDay = {};
  DAYS.forEach((d) => (byDay[d] = []));
  classes.forEach((c) => {
    byDay[c.day].push(`${c.course} ${fmt(c.start)}-${fmt(c.end)}`);
  });
  return DAYS.map((d) => `${d}: ${byDay[d].length ? byDay[d].join(', ') : 'no classes'}`).join('\n');
}

// Convert a one-way commute in minutes to clean 0.5-hour steps so blocks land on the grid.
// Convert a one-way commute in minutes to clean 0.5-hour steps so blocks land on the grid.
// Rounds UP to the nearest half-hour (a 15-min ride still gets a 0.5h block, a 75-min
// ride gets 1.5h, etc.) — same rule as before, just written to cover any option you add
// later without needing a new branch each time.
function commuteHours(min) {
  const m = Number(min) || 0;
  if (m <= 0) return 0;
  return Math.ceil(m / 30) * 0.5;
}

// Turn the structured answers into plain-English scheduling instructions for the model.
function describePreferences(p) {
  const lines = [];

  const cH = commuteHours(p.commute);
  if (p.housing === 'off' && cH > 0) {
    lines.push(
      `- COMMUTE: The student lives OFF campus with about a ${cH}-hour commute EACH WAY. ` +
      `On every weekday that has at least one class, add a "Commute" block of exactly ${cH}h ` +
      `ending when the FIRST class starts, and another "Commute" block of exactly ${cH}h ` +
      `starting when the LAST class ends. Both commute blocks MUST be the same length. ` +
      `Directly before the morning commute, add a "Prep" block of 0.5h (getting ready) so the ` +
      `student's wake-up time is visible. The earliest block may start as early as 5:00 if needed.`
    );
  } else {
    lines.push(
      `- COMMUTE: The student lives ON campus (walking distance) — do NOT add any "Commute" blocks. ` +
      `Use a short 0.5h "Prep" block in the morning; the first block can start close to the first class.`
    );
  }

  const dayStart = p.dayStart || 'any';
  if (dayStart === '8') {
    lines.push(`- START: Avoid scheduling flexible blocks (Study, Gym, Project, Free) before 8:00 — keep early mornings light unless a class or the commute requires an earlier start.`);
  } else if (dayStart === '9') {
    lines.push(`- START: Avoid scheduling flexible blocks before 9:00 wherever the fixed classes allow it.`);
  } else {
    lines.push(`- START: The day can start as early as the classes (and any commute/prep) require.`);
  }

  const dayEnd = Number(p.dayEnd) || 22;
  const endLabel = dayEnd >= 23 ? '23:00 (11 PM)' : dayEnd <= 21 ? '21:00 (9 PM)' : '22:00 (10 PM)';
  lines.push(`- END: Wind the day down by about ${endLabel}. Place the "WindDown" block ending near then, and schedule no work blocks after it.${dayEnd >= 23 ? ' Later evening Study/Project blocks are fine for this night owl.' : ''}`);

  const gym = Number(p.gym) || 0;
  lines.push(gym > 0
    ? `- GYM: Schedule EXACTLY ${gym} "Gym" block(s) across the week (one per day, on ${gym} different days), each ~1h.`
    : `- GYM: Not a focus — include at most 1 short "Gym" block, or none.`);

  const study = { after: 'Place "Study" review blocks right after lectures whenever possible.',
    evening: 'Batch most "Study" blocks into the evenings.',
    spread: 'Spread "Study" blocks evenly through the day.' };
  lines.push(`- STUDY: ${study[p.study] || study.after}`);

  const social = { minimal: 'Keep "Club"/social time minimal — prioritize academics (0-1 Club blocks).',
    some: 'Include a few "Club" and social "Free" blocks across the week (about 2-3).',
    active: 'Include several "Club" and social "Free" blocks across the week (4+).' };
  lines.push(`- SOCIAL: ${social[p.social] || social.some}`);

  return lines.join('\n');
}

function buildPrompt(classes, body) {
  const classText = describeClasses(classes);
  const prefs = describePreferences(body || {});
  const notes = (body && body.considerations) ? body.considerations : '';
  const endHour = Math.min(23, Math.max(21, Number(body && body.dayEnd) || 22));
  return `You are a study-schedule planner for a first-year engineering student.

The student's FIXED class times (these are locked — never move, remove, or invent classes):
${classText}

The student's structured preferences (follow these precisely):
${prefs}

The student's own extra notes:
"${notes || 'None given.'}"

Your job: fill the student's week (Mon-Fri, 5:00 to ${endHour}:00) with FLEXIBLE blocks arranged AROUND the fixed classes. Never overlap a fixed class, and follow the structured preferences above exactly (commute lengths, start/end times, gym count, study rhythm, social level).

Allowed flexible categories ONLY: ${FLEX_CATEGORIES.join(', ')}.
General guidance:
- "Prep" = a short morning routine before the day starts.
- "Study" = review/problem sets.
- "Lunch" = a midday break around 12:00-13:00.
- "Project", "Free" = building time and genuine rest per the preferences.
- "WindDown" = an evening block to close the day, ending by about ${endHour}:00.
- Keep it realistic: don't fill every minute; leave some "Free".

Return ONLY valid JSON, no prose, no markdown fences. Schema:
{
  "days": {
    "Mon": [ {"start": 6.5, "end": 7, "category": "Prep", "label": "Morning Prep"}, ... ],
    "Tue": [ ... ], "Wed": [ ... ], "Thu": [ ... ], "Fri": [ ... ]
  }
}
Rules for the JSON:
- start/end are numbers in 24h decimal (e.g. 13.5 = 1:30pm), between 5 and ${endHour}.
- Use 0.5-hour increments only (e.g. 6, 6.5, 7 ... never 6.25).
- category MUST be one of: ${FLEX_CATEGORIES.join(', ')}.
- Do NOT include the fixed classes in your output — only the flexible blocks around them.
- Blocks within a day must not overlap each other.`;
}

// Strict validation of Gemini's output. Anything malformed is rejected.
function validatePlan(plan, classes) {
  if (!plan || typeof plan !== 'object' || !plan.days) {
    throw new Error('Plan missing "days"');
  }
  const clean = { days: {} };
  const fixedByDay = {};
  DAYS.forEach((d) => (fixedByDay[d] = classes.filter((c) => c.day === d)));

  for (const day of DAYS) {
    const blocks = Array.isArray(plan.days[day]) ? plan.days[day] : [];
    const kept = [];
    for (const b of blocks) {
      if (typeof b.start !== 'number' || typeof b.end !== 'number') continue;
      if (b.end <= b.start) continue;
      if (b.start < 5 || b.end > 23) continue;
      if (!FLEX_CATEGORIES.includes(b.category)) continue;
      // reject if it overlaps a fixed class
      const clashes = fixedByDay[day].some(
        (c) => b.start < c.end && b.end > c.start
      );
      if (clashes) continue;
      kept.push({
        start: b.start,
        end: b.end,
        category: b.category,
        label: String(b.label || b.category).slice(0, 40),
      });
    }
    // sort and drop internal overlaps (keep earlier)
    kept.sort((a, z) => a.start - z.start);
    const noOverlap = [];
    let lastEnd = -1;
    for (const b of kept) {
      if (b.start >= lastEnd) {
        noOverlap.push(b);
        lastEnd = b.end;
      }
    }
    clean.days[day] = noOverlap;
  }
  return clean;
}

async function callGemini(key, prompt) {
  const res = await fetch(GEMINI_URL(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');
  // responseMimeType json means text should already be clean JSON
  return JSON.parse(text.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
}

async function logLead({ firstName, lastName, email, block, semester }) {
  const key = process.env.WEB3FORMS_KEY;
  if (!key) return; // logging is best-effort; never blocks the generate
  try {
    await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_key: key,
        subject: `New Blueprint lead — Block ${block} (${semester})`,
        from_name: 'EngInQuire Generator',
        name: `${firstName} ${lastName}`,
        email,
        message: `Block ${block}, ${semester}. Generated a schedule.`,
      }),
    });
  } catch (e) {
    // swallow — lead logging must never break the student's result
  }
}

// ---- Handler ------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body =
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { block, semester, firstName, lastName, email, considerations } = body;

    // ---- validate input ----
    const blocks = loadBlocks();
    if (!blocks[String(block)]) {
      res.status(400).json({ error: 'Pick a valid block.' });
      return;
    }
    if (!['fall', 'winter'].includes(semester)) {
      res.status(400).json({ error: 'Pick fall or winter.' });
      return;
    }
    if (!firstName || !lastName || !email || !/.+@.+\..+/.test(email)) {
      res.status(400).json({ error: 'Enter your name and a valid email.' });
      return;
    }

    const classes = blocks[String(block)][semester];

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server not configured (missing key).' });
      return;
    }

    // ---- generate ----
    let plan;
    try {
      const raw = await callGemini(apiKey, buildPrompt(classes, body));
      plan = validatePlan(raw, classes);
    } catch (e) {
      // One retry, then give up gracefully
      try {
        const raw = await callGemini(apiKey, buildPrompt(classes, body));
        plan = validatePlan(raw, classes);
      } catch (e2) {
        res.status(502).json({ error: 'The planner had trouble. Try again in a moment.' });
        return;
      }
    }

    // ---- log lead (best effort, non-blocking on failure) ----
    await logLead({ firstName, lastName, email, block, semester });

    res.status(200).json({
      block: String(block),
      semester,
      firstName,
      classes, // the fixed classes, so the client can render them too
      plan, // the validated flexible blocks
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
