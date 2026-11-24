"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";
import { STARTER_DECK, TOPICS } from "../lib/deck";
import { review, previewLabel, currentRecall } from "../lib/fsrs";

const NEW_PER_DAY = 15;

// ---------- speech (free, uses the device's own Swahili voice if it has one) ----------
function useSwahiliVoice() {
  const [voice, setVoice] = useState(null);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const pick = () => {
      const v = window.speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith("sw"));
      setVoice(v || null);
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);
  const speak = useCallback(
    (text) => {
      if (!voice) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/\//g, ",").replace(/\.\.\./g, ""));
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 0.85;
      window.speechSynthesis.speak(u);
    },
    [voice]
  );
  return { hasVoice: Boolean(voice), speak };
}

// ---------- root ----------
export default function Home() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!isConfigured) {
    return (
      <main className="wrap">
        <div className="logo">Msamiati</div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h2>Almost ready</h2>
          <p className="muted">The app is deployed but not connected to its database yet. Add the Supabase keys in Vercel and redeploy.</p>
        </div>
      </main>
    );
  }
  if (session === undefined) return <main className="wrap muted">Loading…</main>;
  if (!session) return <Login />;
  return <App session={session} />;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError("That email and password didn't work. Check them and try again.");
  };
  return (
    <main className="wrap" style={{ paddingTop: 48 }}>
      <div className="logo" style={{ fontSize: 28 }}>Msamiati</div>
      <p className="muted">Swahili flashcards that learn how you remember.</p>
      <form className="panel" onSubmit={submit}>
        <label className="small muted">Email</label>
        <input className="field" type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }} />
        <label className="small muted">Password</label>
        <input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} />
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy} style={{ width: "100%" }}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="small muted" style={{ marginBottom: 0 }}>This is a private test. Ask Dimple for a login.</p>
      </form>
    </main>
  );
}

// ---------- main app ----------
function App({ session }) {
  const userId = session.user.id;
  const [tab, setTab] = useState("study");
  const [userCards, setUserCards] = useState([]);
  const [states, setStates] = useState({});
  const [newToday, setNewToday] = useState(0);
  const [reviewsToday, setReviewsToday] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [c, s, n, r] = await Promise.all([
      supabase.from("user_cards").select("*").order("created_at", { ascending: true }),
      supabase.from("card_states").select("*"),
      supabase.from("review_log").select("id", { count: "exact", head: true }).eq("was_new", true).gte("reviewed_at", start.toISOString()),
      supabase.from("review_log").select("id", { count: "exact", head: true }).gte("reviewed_at", start.toISOString()),
    ]);
    if (c.error || s.error) {
      setLoadError("Couldn't load your cards. Check your connection and refresh.");
    } else {
      setUserCards(c.data);
      setStates(Object.fromEntries(s.data.map((x) => [x.card_key, x])));
      setNewToday(n.count || 0);
      setReviewsToday(r.count || 0);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const allCards = useMemo(() => {
    const mine = userCards.map((c) => ({
      key: `u:${c.id}`, id: c.id, sw: c.sw, en: c.en, note: c.note,
      example_sw: c.example_sw, example_en: c.example_en, topic: c.topic, mine: true,
    }));
    return [...mine, ...STARTER_DECK];
  }, [userCards]);

  const onReviewed = (card, newState, log) => {
    setStates((prev) => ({ ...prev, [card.key]: { ...newState, card_key: card.key } }));
    setReviewsToday((x) => x + 1);
    if (log.was_new) setNewToday((x) => x + 1);
  };

  return (
    <main className="wrap">
      <header className="top">
        <div className="logo">Msamiati</div>
        <button className="btn link small" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      {loading ? (
        <p className="muted">Loading your cards…</p>
      ) : loadError ? (
        <div className="panel"><div className="error">{loadError}</div><button className="btn" onClick={load}>Try again</button></div>
      ) : tab === "study" ? (
        <Study cards={allCards} states={states} newToday={newToday} userId={userId} onReviewed={onReviewed} goAdd={() => setTab("add")} />
      ) : tab === "add" ? (
        <AddWords session={session} userCards={userCards} onAdded={load} />
      ) : (
        <Progress cards={allCards} states={states} reviewsToday={reviewsToday} userCards={userCards} onChanged={load} />
      )}
      <nav className="tabs">
        <button className={tab === "study" ? "on" : ""} onClick={() => setTab("study")}>Study</button>
        <button className={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>Add words</button>
        <button className={tab === "progress" ? "on" : ""} onClick={() => setTab("progress")}>Progress</button>
      </nav>
    </main>
  );
}

// ---------- study ----------
function buildQueue(cards, states, newToday) {
  const now = Date.now();
  const due = cards
    .filter((c) => states[c.key] && new Date(states[c.key].due).getTime() <= now)
    .sort((a, b) => (currentRecall(states[a.key]) ?? 0) - (currentRecall(states[b.key]) ?? 0));
  const fresh = cards.filter((c) => !states[c.key]).slice(0, Math.max(0, NEW_PER_DAY - newToday));
  return [...due.map((c) => c.key), ...fresh.map((c) => c.key)];
}

function Study({ cards, states, newToday, userId, onReviewed, goAdd }) {
  const byKey = useMemo(() => Object.fromEntries(cards.map((c) => [c.key, c])), [cards]);
  const [queue, setQueue] = useState(() => buildQueue(cards, states, newToday));
  const [flipped, setFlipped] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { hasVoice, speak } = useSwahiliVoice();

  const card = queue.length ? byKey[queue[0]] : null;
  const state = card ? states[card.key] : null;
  const recall = state ? currentRecall(state) : null;

  const rate = async (grade) => {
    if (!card || saving) return;
    setSaving(true);
    setError("");
    const { state: next, log } = review(state, grade);
    const [a, b] = await Promise.all([
      supabase.from("card_states").upsert({ user_id: userId, card_key: card.key, ...next }),
      supabase.from("review_log").insert({ user_id: userId, card_key: card.key, topic: card.topic, ...log }),
    ]);
    setSaving(false);
    if (a.error || b.error) return setError("Couldn't save that review. Check your connection and tap again.");
    onReviewed(card, next, log);
    setFlipped(false);
    setQueue((q) => (grade === 1 ? [...q.slice(1), q[0]] : q.slice(1)));
  };

  if (!card) {
    const nextDue = Object.values(states).map((s) => new Date(s.due).getTime()).filter((t) => t > Date.now()).sort((a, b) => a - b)[0];
    return (
      <div className="panel done">
        <h2>Umemaliza! You're done for now.</h2>
        <p className="muted">
          {nextDue ? `Your next review is ${new Date(nextDue).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : "Come back tomorrow for new cards."}
        </p>
        <button className="btn primary" onClick={goAdd}>Add words from a song or text</button>
      </div>
    );
  }

  return (
    <>
      <div className="row small muted" style={{ marginBottom: 8 }}>
        <span>{queue.length} left in this session</span>
        <span className="chip">{card.topic}</span>
      </div>
      <div className="panel flash" onClick={() => !flipped && setFlipped(true)} style={{ cursor: flipped ? "default" : "pointer" }}>
        {!state && <div className="small muted">New card</div>}
        <div className="sw" lang="sw">{card.sw}</div>
        {hasVoice && (
          <button className="speak" onClick={(e) => { e.stopPropagation(); speak(card.sw); }} aria-label="Hear it">▶ Hear it</button>
        )}
        {!flipped ? (
          <p className="muted small" style={{ marginTop: 20 }}>Think of the meaning, then tap to check.</p>
        ) : (
          <>
            <div className="en">{card.en}</div>
            {card.note && <div className="note">{card.note}</div>}
            {card.example_sw && (
              <div className="ex"><div lang="sw">{card.example_sw}</div>{card.example_en && <div className="muted small">{card.example_en}</div>}</div>
            )}
            {recall !== null && <div className="recall">The model estimated a {Math.round(recall * 100)}% chance you'd remember this.</div>}
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {flipped ? (
        <div className="ratings">
          {[["Again", 1], ["Hard", 2], ["Good", 3], ["Easy", 4]].map(([label, g]) => (
            <button key={g} className={`r${g}`} disabled={saving} onClick={() => rate(g)}>
              <b>{label}</b><span>{previewLabel(state, g)}</span>
            </button>
          ))}
        </div>
      ) : (
        <button className="btn primary" style={{ width: "100%" }} onClick={() => setFlipped(true)}>Show answer</button>
      )}
      {!hasVoice && <p className="small muted" style={{ textAlign: "center" }}>Audio needs a Swahili voice on this device (Chrome on Android usually has one).</p>}
    </>
  );
}

// ---------- add words from pasted text ----------
function AddWords({ session, userCards, onAdded }) {
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("");
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState({});
  const [importId, setImportId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(0);

  const known = useMemo(() => {
    const set = new Set(userCards.map((c) => c.sw.toLowerCase().trim()));
    STARTER_DECK.forEach((c) => set.add(c.sw.toLowerCase().trim()));
    return set;
  }, [userCards]);

  const translate = async () => {
    setError("");
    setAdded(0);
    if (!text.trim()) return setError("Paste some Swahili text first.");
    setBusy(true);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Translation failed.");
      const words = data.words.map((w) => ({ ...w, isKnown: known.has(String(w.sw).toLowerCase().trim()) }));
      setResult({ ...data, words });
      setPicked(Object.fromEntries(words.map((w, i) => [i, !w.isKnown])));
      const title = topic.trim() || text.trim().split("\n")[0].slice(0, 40);
      const ins = await supabase.from("imports").insert({ user_id: session.user.id, title, source_text: text.trim(), translation: data }).select("id").single();
      setImportId(ins.data?.id || null);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  const save = async () => {
    setError("");
    const chosen = result.words.filter((w, i) => picked[i] && !w.isKnown);
    if (!chosen.length) return setError("Tick at least one new word to add.");
    setBusy(true);
    const t = topic.trim() || "My words";
    const rows = chosen.map((w) => ({
      user_id: session.user.id,
      sw: String(w.sw).trim(),
      en: String(w.en).trim(),
      note: [w.seen_as && w.seen_as !== w.sw ? `Seen as: ${w.seen_as}.` : "", w.note || ""].filter(Boolean).join(" ") || null,
      example_sw: w.example_sw || null,
      example_en: w.example_en || null,
      topic: t,
      import_id: importId,
    }));
    let count = 0;
    const { error } = await supabase.from("user_cards").insert(rows);
    if (!error) count = rows.length;
    else {
      for (const r of rows) {
        const one = await supabase.from("user_cards").insert(r);
        if (!one.error) count++;
      }
    }
    setBusy(false);
    setAdded(count);
    setResult(null);
    setText("");
    await onAdded();
  };

  return (
    <>
      <div className="panel">
        <h2>Add words from a song or text</h2>
        <p className="small muted">Paste Swahili lyrics, a message or a paragraph. You'll get a translation and can add the new words to your flashcards.</p>
        <label className="small muted">Name this set (optional)</label>
        <input className="field" placeholder="e.g. Sauti Sol song" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <label className="small muted">Swahili text</label>
        <textarea className="field" lang="sw" value={text} maxLength={3000} placeholder="Paste here…" onChange={(e) => { setText(e.target.value); setError(""); }} />
        <div className="row">
          <span className="small muted">{text.length} / 3000</span>
          <button className="btn primary" onClick={translate} disabled={busy}>{busy && !result ? "Translating…" : "Translate"}</button>
        </div>
        {error && <div className="error">{error}</div>}
        {added > 0 && <p style={{ color: "var(--brand)" }}>Added {added} word{added === 1 ? "" : "s"}. They'll show up first in Study.</p>}
      </div>

      {result && (
        <>
          <div className="panel">
            <h2>Translation</h2>
            <div className="lines">
              {result.lines.map((l, i) => (
                <div key={i}><div lang="sw">{l.sw}</div><div className="muted small">{l.en}</div></div>
              ))}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>Machine translation. It can be wrong, especially with slang.</p>
          </div>
          <div className="panel">
            <div className="row"><h2>Words</h2><span className="small muted">{Object.values(picked).filter(Boolean).length} selected</span></div>
            {result.words.map((w, i) => (
              <label className="word" key={i}>
                <input type="checkbox" disabled={w.isKnown} checked={Boolean(picked[i]) && !w.isKnown} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} />
                <div>
                  <b lang="sw">{w.sw}</b> — {w.en} {w.is_sheng && <span className="chip">Sheng</span>} {w.isKnown && <span className="chip">Already in your deck</span>}
                  {w.note && <div className="small muted">{w.note}</div>}
                </div>
              </label>
            ))}
            {error && <div className="error">{error}</div>}
            <button className="btn primary" style={{ width: "100%", marginTop: 12 }} onClick={save} disabled={busy}>
              {busy ? "Adding…" : "Add selected words to my flashcards"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

// ---------- progress ----------
function Progress({ cards, states, reviewsToday, userCards, onChanged }) {
  const now = Date.now();
  const seen = cards.filter((c) => states[c.key]);
  const due = seen.filter((c) => new Date(states[c.key].due).getTime() <= now).length;
  const topics = [...new Set([...userCards.map((c) => c.topic), ...TOPICS])];

  const removeCard = async (id) => {
    await supabase.from("user_cards").delete().eq("id", id);
    await supabase.from("card_states").delete().eq("card_key", `u:${id}`);
    onChanged();
  };

  return (
    <>
      <div className="stats">
        <div className="stat"><b>{seen.length}</b><span>cards started</span></div>
        <div className="stat"><b>{due}</b><span>due now</span></div>
        <div className="stat"><b>{reviewsToday}</b><span>reviews today</span></div>
      </div>
      <div className="panel">
        <h2>Mastery by topic</h2>
        <p className="small muted">Mastery is the model's estimate of how much of each topic you'd remember right now (unstarted cards count as 0).</p>
        {topics.map((t) => {
          const inTopic = cards.filter((c) => c.topic === t);
          const started = inTopic.filter((c) => states[c.key]);
          const mastery = started.length ? started.reduce((s, c) => s + (currentRecall(states[c.key]) || 0), 0) / inTopic.length : 0;
          return (
            <div className="topic" key={t}>
              <div className="row"><span>{t}</span><span className="small muted">{started.length}/{inTopic.length} started · {Math.round(mastery * 100)}%</span></div>
              <div className="bar"><i style={{ width: `${Math.round(mastery * 100)}%` }} /></div>
            </div>
          );
        })}
      </div>
      {userCards.length > 0 && (
        <div className="panel">
          <h2>Words you added</h2>
          {userCards.map((c) => (
            <div className="row topic" key={c.id}>
              <span><b lang="sw">{c.sw}</b> <span className="muted">— {c.en}</span></span>
              <button className="btn link small" onClick={() => removeCard(c.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
