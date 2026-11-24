# Msamiati — Swahili flashcards MVP

Flashcards for new Swahili learners, with an FSRS spaced-repetition model and a
"paste a song or text → translate → add words" layer.

- **Front end + API:** Next.js on Vercel (Hobby, free)
- **Logins + data:** Supabase (free tier), with row-level security so each tester sees only their own data
- **Translation:** Google Gemini API free tier (server-side only)
- **Audio:** the device's built-in Swahili voice (free)

## Files
- `lib/fsrs.js` — the learner model (FSRS-4.5 with default weights)
- `lib/deck.js` — 146 starter cards in 10 topics
- `app/page.js` — the app (login, Study, Add words, Progress)
- `app/api/translate/route.js` — calls Gemini; checks the Supabase login; 30 translations per tester per day
- `supabase/schema.sql` — tables, security policies, and a `tester_activity` view for you

## Environment variables (Vercel → Project → Settings → Environment Variables)
| Name | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon / publishable key |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key |
| `GEMINI_MODEL` (optional) | defaults to `gemini-flash-latest` |

## Data for analysis
- `review_log` has every rating with the model's predicted recall at that moment, so you can check calibration (e.g. log-loss, reliability curves) in R or Python.
- `select * from tester_activity;` in the SQL editor shows reviews per tester per day.
