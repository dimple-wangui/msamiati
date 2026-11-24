import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_CHARS = 3000;
const DAILY_LIMIT = 30;

const PROMPT = `You are a Swahili tutor for complete beginners whose first language is English.
The learner pasted the Swahili text below (it may be song lyrics, a message, or an article, and may mix in English or Sheng).

Return JSON only, with this shape:
{
  "lines": [{"sw": "original line", "en": "natural English translation"}],
  "words": [{
    "sw": "dictionary form (verbs as the ku- infinitive, e.g. kupenda; nouns as 'singular / plural' when the plural differs)",
    "en": "short English meaning",
    "seen_as": "the exact form that appeared in the text",
    "note": "one short beginner-friendly grammar note, e.g. how seen_as breaks down (ni-na-ku-penda = I-present-you-love) or the noun class; null if nothing useful",
    "example_sw": "the line from the text where it appeared",
    "example_en": "English translation of that line",
    "is_sheng": false
  }]
}

Rules:
- Translate every non-empty line, keeping the original line breaks.
- List each distinct useful word once (skip English words, names and pure filler like "eeh", "oh").
- Prefer the most useful 40 words if there are more.
- Be accurate. If a word is Sheng or slang, set is_sheng to true and give the standard Swahili equivalent in the note.

Text:
"""
{TEXT}
"""`;

async function getUser(token) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

async function importsToday(token, userId) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const since = new Date(Date.now() - 86400000).toISOString();
  const res = await fetch(
    `${url}/rest/v1/imports?select=id&user_id=eq.${userId}&created_at=gte.${since}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Prefer: "count=exact",
        Range: "0-0",
      },
    }
  );
  const range = res.headers.get("content-range") || "*/0";
  return Number(range.split("/")[1] || 0);
}

async function callGemini(model, text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: PROMPT.replace("{TEXT}", text) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    }
  );
  return res;
}

export async function POST(req) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Translation isn't set up yet (missing GEMINI_API_KEY)." }, { status: 503 });
  }
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const user = token ? await getUser(token) : null;
  if (!user?.id) return NextResponse.json({ error: "Please log in again." }, { status: 401 });

  const { text } = await req.json().catch(() => ({}));
  const clean = (text || "").trim();
  if (!clean) return NextResponse.json({ error: "Paste some Swahili text first." }, { status: 400 });
  if (clean.length > MAX_CHARS) {
    return NextResponse.json({ error: `That's too long. Paste up to ${MAX_CHARS} characters at a time.` }, { status: 400 });
  }
  if ((await importsToday(token, user.id)) >= DAILY_LIMIT) {
    return NextResponse.json({ error: "You've reached today's translation limit. Try again tomorrow." }, { status: 429 });
  }

  const models = [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-flash-lite-latest"];
  let lastError = "Translation failed.";
  for (const model of models) {
    const res = await callGemini(model, clean);
    if (res.status === 429) {
      lastError = "The free translation quota is busy. Wait a minute and try again.";
      continue;
    }
    if (!res.ok) {
      lastError = `Translation service error (${res.status}).`;
      continue;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    try {
      const parsed = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
      const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
      const words = (Array.isArray(parsed.words) ? parsed.words : [])
        .filter((w) => w && w.sw && w.en)
        .slice(0, 60);
      return NextResponse.json({ lines, words, model });
    } catch {
      lastError = "The translation came back in an unexpected format. Try again.";
    }
  }
  return NextResponse.json({ error: lastError }, { status: 502 });
}
