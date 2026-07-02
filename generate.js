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

function buildPrompt(classes, considerations) {
  const classText = describeClasses(classes);
  return `You are a study-schedule planner for a first-year engineering student.

The student's FIXED class times (these are locked — never move, remove, or invent classes):
${classText}

The student's preferences, in their own words:
"${considerations || 'No specific preferences given.'}"

Your job: fill the student's week (Mon-Fri, 7:00 to 22:00) with FLEXIBLE blocks arranged AROUND the fixed classes. Never overlap a fixed class. Honor the preferences (e.g. if they dislike mornings, keep early slots light; if they want gym 4x, schedule 4 gym blocks).

Allowed flexible categories ONLY: ${FLEX_CATEGORIES.join(', ')}.
Guidance:
- "Prep" = a short morning routine before the day starts.
- "Commute" ~1h before the first class and after the last class each weekday that has classes.
- "Study" = review/problem sets; place some right after lectures when possible.
- "Lunch" = a midday break around 12:00-13:00.
- "Gym", "Project", "Club", "Free" per their preferences.
- "WindDown" = an evening block to close the day.
- Keep it realistic: don't fill every minute; leave some Free.

Return ONLY valid JSON, no prose, no markdown fences. Schema:
{
  "days": {
    "Mon": [ {"start": 7, "end": 8, "category": "Prep", "label": "Morning Prep"}, ... ],
    "Tue": [ ... ], "Wed": [ ... ], "Thu": [ ... ], "Fri": [ ... ]
  }
}
Rules for the JSON:
- start/end are numbers in 24h decimal (e.g. 13.5 = 1:30pm), between 7 and 22.
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
      if (b.start < 7 || b.end > 22) continue;
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
      const raw = await callGemini(apiKey, buildPrompt(classes, considerations));
      plan = validatePlan(raw, classes);
    } catch (e) {
      // One retry, then give up gracefully
      try {
        const raw = await callGemini(apiKey, buildPrompt(classes, considerations));
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
