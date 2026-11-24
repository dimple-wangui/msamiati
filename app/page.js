"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";
import { SYLLABUS, LEVELS, ALL_ITEMS, MY_WORDS_UNIT } from "../lib/syllabus";
import { review, previewLabel, currentRecall } from "../lib/fsrs";

const MY_WORDS_TITLE = "Your words";

// ---------- helpers ----------
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const norm = (s) => s.toLowerCase().replace(/[.,!?;:"“”]/g, "").replace(/\s+/g, " ").trim();
const isDue = (st, now = Date.now()) => st && new Date(st.due).getTime() <= now;

function mastery(items, states) {
  if (!items.length) return { started: 0, total: 0, pct: 0 };
  const started = items.filter((i) => states[i.key]);
  const sum = started.reduce((s, i) => s + (currentRecall(states[i.key]) || 0), 0);
  return { started: started.length, total: items.length, pct: Math.round((sum / items.length) * 100) };
}

// Endless session: due items first (weakest first), then new items in syllabus order,
// then extra practice on whatever the model thinks you're most likely to forget.
function pickNext(items, states, recent) {
  if (!items.length) return null;
  const avoid = new Set(recent);
  const pool = items.filter((i) => !avoid.has(i.key));
  const use = pool.length ? pool : items;
  const byRecall = (a, b) => (currentRecall(states[a.key]) ?? 0) - (currentRecall(states[b.key]) ?? 0);
  const due = use.filter((i) => isDue(states[i.key])).sort(byRecall);
  if (due.length) return { item: due[0], mode: "due" };
  const fresh = use.find((i) => !states[i.key]);
  if (fresh) return { item: fresh, mode: "new" };
  return { item: [...use].sort(byRecall)[0], mode: "extra" };
}

// ---------- speech (device's own Swahili voice, free) ----------
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
      const u = new SpeechSynthesisUtterance(text.replace(/\//g, ",").replace(/\.\.\./g, "").replace(/[()]/g, ""));
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 0.85;
      window.speechSynthesis.speak(u);
    },
    [voice]
  );
  return { hasVoice: Boolean(voice), speak };
}

function Hear({ text, voice }) {
  if (!voice.hasVoice) return null;
  return (
    <button className="speak" onClick={(e) => { e.stopPropagation(); voice.speak(text); }} aria-label="Hear it">▶ Hear it</button>
  );
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
          <p className="muted">The app isn't connected to its database yet.</p>
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
      <p className="muted">Learn Kiswahili step by step, with practice that adapts to your memory.</p>
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
  const voice = useSwahiliVoice();
  const [tab, setTab] = useState("learn");
  const [unitId, setUnitId] = useState(null);
  const [practice, setPractice] = useState(null);
  const [userCards, setUserCards] = useState([]);
  const [states, setStates] = useState({});
  const [days, setDays] = useState([]);
  const [reviewsToday, setReviewsToday] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const [c, s, r] = await Promise.all([
      supabase.from("user_cards").select("*").order("created_at", { ascending: true }),
      supabase.from("card_states").select("*"),
      supabase.from("review_log").select("reviewed_at").gte("reviewed_at", since).order("reviewed_at", { ascending: false }).limit(5000),
    ]);
    if (c.error || s.error) {
      setLoadError("Couldn't load your progress. Check your connection and try again.");
    } else {
      setUserCards(c.data);
      setStates(Object.fromEntries(s.data.map((x) => [x.card_key, x])));
      const rows = r.data || [];
      setReviewsToday(rows.filter((x) => new Date(x.reviewed_at) >= start).length);
      setDays([...new Set(rows.map((x) => new Date(x.reviewed_at).toDateString()))]);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const myItems = useMemo(
    () => userCards.map((c) => ({
      type: "card", key: `u:${c.id}`, id: c.id, sw: c.sw, en: c.en, note: c.note,
      example_sw: c.example_sw, example_en: c.example_en, unit: MY_WORDS_UNIT, topic: MY_WORDS_TITLE,
    })),
    [userCards]
  );
  const allItems = useMemo(() => [...myItems, ...ALL_ITEMS], [myItems]);
  const itemsFor = useCallback(
    (scope) => (scope === "all" ? allItems : scope === MY_WORDS_UNIT ? myItems : allItems.filter((i) => i.unit === scope)),
    [allItems, myItems]
  );

  const onReviewed = (key, next) => {
    setStates((prev) => ({ ...prev, [key]: { ...next, card_key: key } }));
    setReviewsToday((x) => x + 1);
    const today = new Date().toDateString();
    setDays((d) => (d.includes(today) ? d : [today, ...d]));
  };

  const goTab = (t) => { setTab(t); setUnitId(null); setPractice(null); };

  let body;
  if (loading) body = <p className="muted">Loading your progress…</p>;
  else if (loadError) body = <div className="panel"><div className="error">{loadError}</div><button className="btn" onClick={load}>Try again</button></div>;
  else if (practice) {
    const scopeTitle = practice.scope === "all" ? "Mixed practice" : practice.scope === MY_WORDS_UNIT ? MY_WORDS_TITLE : SYLLABUS.find((u) => u.id === practice.scope)?.title;
    body = (
      <Session
        key={practice.scope}
        title={scopeTitle}
        items={itemsFor(practice.scope)}
        states={states}
        userId={userId}
        voice={voice}
        onReviewed={onReviewed}
        onExit={() => setPractice(null)}
      />
    );
  } else if (tab === "learn" && unitId) {
    body = <UnitPage unitId={unitId} myItems={myItems} states={states} voice={voice} onBack={() => setUnitId(null)} onPractice={() => setPractice({ scope: unitId })} />;
  } else if (tab === "learn") {
    body = <Learn states={states} myItems={myItems} onOpen={setUnitId} onPracticeAll={() => setPractice({ scope: "all" })} />;
  } else if (tab === "practice") {
    body = <PracticeHome items={allItems} states={states} myItems={myItems} onStart={(scope) => setPractice({ scope })} />;
  } else if (tab === "add") {
    body = <AddWords session={session} userCards={userCards} onAdded={load} />;
  } else {
    body = <Progress allItems={allItems} myItems={myItems} states={states} reviewsToday={reviewsToday} days={days} userCards={userCards} onChanged={load} />;
  }

  return (
    <main className="wrap">
      <header className="top">
        <div className="logo">Msamiati</div>
        <button className="btn link small" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      {body}
      <nav className="tabs">
        {[["learn", "Learn"], ["practice", "Practice"], ["add", "Add words"], ["progress", "Progress"]].map(([t, label]) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => goTab(t)}>{label}</button>
        ))}
      </nav>
    </main>
  );
}

// ---------- learn: the syllabus ----------
function Learn({ states, myItems, onOpen, onPracticeAll }) {
  const next = SYLLABUS.find((u) => mastery(u.items, states).started < u.items.length) || SYLLABUS[0];
  return (
    <>
      <div className="panel hero">
        <div className="small muted">Continue where you left off</div>
        <h2 style={{ margin: "4px 0" }}>{next.title}</h2>
        <div className="small muted" style={{ marginBottom: 12 }}>{next.summary}</div>
        <div className="row" style={{ gap: 8, justifyContent: "flex-start" }}>
          <button className="btn primary" onClick={() => onOpen(next.id)}>Open lesson</button>
          <button className="btn" onClick={onPracticeAll}>Mixed practice</button>
        </div>
      </div>
      {myItems.length > 0 && (
        <UnitRow title={MY_WORDS_TITLE} sw="Maneno yako" summary="Words you added from songs and texts." m={mastery(myItems, states)} onClick={() => onOpen(MY_WORDS_UNIT)} />
      )}
      {LEVELS.map((lv) => (
        <section key={lv.id}>
          <h3 className="level">{lv.title}</h3>
          {SYLLABUS.filter((u) => u.level === lv.id).map((u) => (
            <UnitRow key={u.id} title={u.title} sw={u.sw} summary={u.summary} m={mastery(u.items, states)} onClick={() => onOpen(u.id)} />
          ))}
        </section>
      ))}
    </>
  );
}

function UnitRow({ title, sw, summary, m, onClick }) {
  return (
    <button className="unit" onClick={onClick}>
      <div className="row">
        <div style={{ textAlign: "left" }}>
          <b>{title}</b> <span className="muted small" lang="sw">· {sw}</span>
          <div className="small muted">{summary}</div>
        </div>
        <span className="small muted" style={{ whiteSpace: "nowrap" }}>{m.pct}%</span>
      </div>
      <div className="bar"><i style={{ width: `${m.pct}%` }} /></div>
      <div className="small muted" style={{ textAlign: "left", marginTop: 4 }}>{m.started}/{m.total} started</div>
    </button>
  );
}

function UnitPage({ unitId, myItems, states, voice, onBack, onPractice }) {
  const u = unitId === MY_WORDS_UNIT
    ? { title: MY_WORDS_TITLE, sw: "Maneno yako", lesson: ["These are the words you added from songs and texts. Practise them like any other unit."], examples: myItems.slice(0, 12).map((i) => [i.sw, i.en]), items: myItems }
    : SYLLABUS.find((x) => x.id === unitId);
  const m = mastery(u.items, states);
  const counts = u.items.reduce((c, i) => ({ ...c, [i.type]: (c[i.type] || 0) + 1 }), {});
  return (
    <>
      <button className="btn link small" onClick={onBack}>← All units</button>
      <div className="panel">
        <div className="small muted" lang="sw">{u.sw}</div>
        <h2>{u.title}</h2>
        {u.lesson.map((p, i) => <p key={i} className="lesson">{p}</p>)}
      </div>
      {u.examples?.length > 0 && (
        <div className="panel">
          <h2>Examples</h2>
          {u.examples.map(([sw, en], i) => (
            <div className="row topic" key={i}>
              <div><div lang="sw"><b>{sw}</b></div><div className="small muted">{en}</div></div>
              <Hear text={sw.split(" (")[0]} voice={voice} />
            </div>
          ))}
        </div>
      )}
      <div className="panel">
        <div className="row"><h2 style={{ margin: 0 }}>Practice</h2><span className="small muted">{m.pct}% mastered</span></div>
        <p className="small muted">
          {counts.card || 0} flashcards · {counts.quiz || 0} questions · {counts.build || 0} sentence builders. The session keeps going for as long as you like.
        </p>
        <button className="btn primary" style={{ width: "100%" }} onClick={onPractice} disabled={!u.items.length}>Start practising</button>
      </div>
    </>
  );
}

function PracticeHome({ items, states, myItems, onStart }) {
  const due = items.filter((i) => isDue(states[i.key])).length;
  const fresh = items.filter((i) => !states[i.key]).length;
  return (
    <>
      <div className="panel hero">
        <h2>Mixed practice</h2>
        <p className="small muted">Reviews that are due come first, then new material in syllabus order. It never runs out: once everything is reviewed, it keeps going with what you're most likely to forget.</p>
        <div className="stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="stat"><b>{due}</b><span>due now</span></div>
          <div className="stat"><b>{fresh}</b><span>not started yet</span></div>
        </div>
        <button className="btn primary" style={{ width: "100%" }} onClick={() => onStart("all")}>Start</button>
      </div>
      <h3 className="level">Or practise one unit</h3>
      {myItems.length > 0 && <button className="unit" onClick={() => onStart(MY_WORDS_UNIT)}><b>{MY_WORDS_TITLE}</b></button>}
      {SYLLABUS.map((u) => (
        <button className="unit" key={u.id} onClick={() => onStart(u.id)}>
          <div className="row"><b style={{ textAlign: "left" }}>{u.title}</b><span className="small muted">{mastery(u.items, states).pct}%</span></div>
        </button>
      ))}
    </>
  );
}

// ---------- the endless session ----------
function Session({ title, items, states, userId, voice, onReviewed, onExit }) {
  const [recent, setRecent] = useState([]);
  const [current, setCurrent] = useState(() => pickNext(items, states, []));
  const [count, setCount] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const grade = async (g) => {
    if (!current || saving) return;
    const { item } = current;
    setSaving(true);
    setError("");
    const { state: next, log } = review(states[item.key], g);
    const [a, b] = await Promise.all([
      supabase.from("card_states").upsert({ user_id: userId, card_key: item.key, ...next }),
      supabase.from("review_log").insert({ user_id: userId, card_key: item.key, topic: item.topic, ...log }),
    ]);
    setSaving(false);
    if (a.error || b.error) return setError("Couldn't save that answer. Check your connection and try again.");
    const newStates = { ...states, [item.key]: { ...next, card_key: item.key } };
    onReviewed(item.key, next);
    const newRecent = [item.key, ...recent].slice(0, Math.min(4, Math.max(1, items.length - 1)));
    setRecent(newRecent);
    setCount((c) => c + 1);
    if (g > 1) setCorrect((c) => c + 1);
    setCurrent(pickNext(items, newStates, newRecent));
  };

  if (!current) {
    return (
      <div className="panel done">
        <h2>Nothing here yet</h2>
        <p className="muted">Add words from a song or text first.</p>
        <button className="btn" onClick={onExit}>Back</button>
      </div>
    );
  }
  const { item, mode } = current;
  const label = mode === "due" ? "Review" : mode === "new" ? "New" : "Extra practice";

  return (
    <>
      <div className="row small muted" style={{ marginBottom: 8 }}>
        <button className="btn link small" onClick={onExit}>← End session</button>
        <span>{count} done{count ? ` · ${Math.round((correct / count) * 100)}% right` : ""}</span>
      </div>
      <div className="row small" style={{ marginBottom: 8 }}>
        <span className="chip">{title === "Mixed practice" ? item.topic : title}</span>
        <span className="muted">{label}</span>
      </div>
      {item.type === "card" && <CardView key={item.key + count} item={item} state={states[item.key]} voice={voice} saving={saving} onGrade={grade} />}
      {item.type === "quiz" && <QuizView key={item.key + count} item={item} saving={saving} onGrade={grade} />}
      {item.type === "build" && <BuildView key={item.key + count} item={item} voice={voice} saving={saving} onGrade={grade} />}
      {error && <div className="error">{error}</div>}
      {count > 0 && count % 20 === 0 && <p className="small muted" style={{ textAlign: "center" }}>Hongera! {count} done. Keep going or end the session any time.</p>}
    </>
  );
}

function CardView({ item, state, voice, saving, onGrade }) {
  const [flipped, setFlipped] = useState(false);
  // Once a card has been seen twice, alternate to English → Swahili.
  const reverse = state && state.reps >= 2 && state.reps % 2 === 0;
  const recall = state ? currentRecall(state) : null;
  return (
    <>
      <div className="panel flash" onClick={() => !flipped && setFlipped(true)} style={{ cursor: flipped ? "default" : "pointer" }}>
        <div className="small muted">{reverse ? "Say it in Swahili" : "What does it mean?"}</div>
        {reverse ? <div className="sw">{item.en}</div> : <><div className="sw" lang="sw">{item.sw}</div><Hear text={item.sw} voice={voice} /></>}
        {!flipped ? (
          <p className="muted small" style={{ marginTop: 20 }}>Think of the answer, then tap to check.</p>
        ) : (
          <>
            {reverse ? <><div className="en" lang="sw"><b>{item.sw}</b></div><Hear text={item.sw} voice={voice} /></> : <div className="en">{item.en}</div>}
            {item.note && <div className="note">{item.note}</div>}
            {item.example_sw && <div className="ex"><div lang="sw">{item.example_sw}</div>{item.example_en && <div className="muted small">{item.example_en}</div>}</div>}
            {recall !== null && <div className="recall">The model estimated a {Math.round(recall * 100)}% chance you'd remember this.</div>}
          </>
        )}
      </div>
      {flipped ? (
        <div className="ratings">
          {[["Again", 1], ["Hard", 2], ["Good", 3], ["Easy", 4]].map(([label, g]) => (
            <button key={g} className={`r${g}`} disabled={saving} onClick={() => onGrade(g)}>
              <b>{label}</b><span>{previewLabel(state, g)}</span>
            </button>
          ))}
        </div>
      ) : (
        <button className="btn primary" style={{ width: "100%" }} onClick={() => setFlipped(true)}>Show answer</button>
      )}
    </>
  );
}

function QuizView({ item, saving, onGrade }) {
  const options = useMemo(() => shuffle([item.answer, ...item.wrong]), [item]);
  const [picked, setPicked] = useState(null);
  const right = picked === item.answer;
  return (
    <>
      <div className="panel">
        <div className="small muted">Choose the answer</div>
        <h2 style={{ marginTop: 6 }}>{item.q}</h2>
        <div className="options">
          {options.map((o) => {
            const cls = picked === null ? "" : o === item.answer ? "opt-right" : o === picked ? "opt-wrong" : "opt-dim";
            return <button key={o} className={`opt ${cls}`} disabled={picked !== null} onClick={() => setPicked(o)}>{o}</button>;
          })}
        </div>
        {picked !== null && (
          <div className={right ? "feedback ok" : "feedback bad"}>
            <b>{right ? "Sahihi! Correct." : `Not quite. The answer is: ${item.answer}`}</b>
            {item.why && <div className="small">{item.why}</div>}
          </div>
        )}
      </div>
      {picked !== null && <button className="btn primary" style={{ width: "100%" }} disabled={saving} onClick={() => onGrade(right ? 3 : 1)}>Continue</button>}
    </>
  );
}

function BuildView({ item, voice, saving, onGrade }) {
  const words = useMemo(() => item.sw.replace(/[.,!?;:"“”]/g, "").trim().split(/\s+/), [item]);
  const tiles = useMemo(() => {
    const base = words.map((w, i) => ({ id: i, w }));
    let s = shuffle(base);
    for (let k = 0; k < 5 && words.length > 1 && s.map((t) => t.w).join(" ") === words.join(" "); k++) s = shuffle(base);
    return s;
  }, [words]);
  const [chosen, setChosen] = useState([]);
  const [checked, setChecked] = useState(null);
  const answer = chosen.map((id) => tiles.find((t) => t.id === id).w).join(" ");
  const done = chosen.length === tiles.length;
  const check = () => setChecked(norm(answer) === norm(item.sw));
  return (
    <>
      <div className="panel">
        <div className="small muted">Build the sentence in Swahili</div>
        <h2 style={{ marginTop: 6 }}>{item.en}</h2>
        <div className="answer-line" lang="sw">
          {chosen.length === 0 && <span className="muted small">Tap the words in order…</span>}
          {chosen.map((id) => (
            <button key={id} className="tile on" disabled={checked !== null} onClick={() => setChosen(chosen.filter((x) => x !== id))}>{tiles.find((t) => t.id === id).w}</button>
          ))}
        </div>
        <div className="tiles" lang="sw">
          {tiles.map((t) => (
            <button key={t.id} className="tile" disabled={chosen.includes(t.id) || checked !== null} onClick={() => setChosen([...chosen, t.id])}>{t.w}</button>
          ))}
        </div>
        {checked !== null && (
          <div className={checked ? "feedback ok" : "feedback bad"}>
            <b>{checked ? "Sahihi! Correct." : "Not quite. The correct sentence is:"}</b>
            {!checked && <div lang="sw">{item.sw}</div>}
            <div style={{ marginTop: 6 }}><Hear text={item.sw} voice={voice} /></div>
          </div>
        )}
      </div>
      {checked === null ? (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={() => setChosen([])} disabled={!chosen.length}>Clear</button>
          <button className="btn primary" style={{ flex: 2 }} onClick={check} disabled={!done}>Check</button>
        </div>
      ) : (
        <button className="btn primary" style={{ width: "100%" }} disabled={saving} onClick={() => onGrade(checked ? 3 : 1)}>Continue</button>
      )}
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
    const set = new Set();
    const add = (s) => { const k = s.toLowerCase().trim(); set.add(k); set.add(k.split(" /")[0].trim()); };
    userCards.forEach((c) => add(c.sw));
    ALL_ITEMS.filter((i) => i.type === "card").forEach((i) => add(i.sw));
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
    const t = topic.trim() || MY_WORDS_TITLE;
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
        <p className="small muted">Paste Swahili lyrics, a message or a paragraph. You'll get a translation and can add the new words to "Your words".</p>
        <label className="small muted">Name this set (optional)</label>
        <input className="field" placeholder="e.g. Sauti Sol song" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <label className="small muted">Swahili text</label>
        <textarea className="field" lang="sw" value={text} maxLength={3000} placeholder="Paste here…" onChange={(e) => { setText(e.target.value); setError(""); }} />
        <div className="row">
          <span className="small muted">{text.length} / 3000</span>
          <button className="btn primary" onClick={translate} disabled={busy}>{busy && !result ? "Translating…" : "Translate"}</button>
        </div>
        {error && <div className="error">{error}</div>}
        {added > 0 && <p style={{ color: "var(--brand)" }}>Added {added} word{added === 1 ? "" : "s"} to Your words.</p>}
      </div>
      {result && (
        <>
          <div className="panel">
            <h2>Translation</h2>
            <div className="lines">
              {result.lines.map((l, i) => <div key={i}><div lang="sw">{l.sw}</div><div className="muted small">{l.en}</div></div>)}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>Machine translation. It can be wrong, especially with slang.</p>
          </div>
          <div className="panel">
            <div className="row"><h2>Words</h2><span className="small muted">{Object.values(picked).filter(Boolean).length} selected</span></div>
            {result.words.map((w, i) => (
              <label className="word" key={i}>
                <input type="checkbox" disabled={w.isKnown} checked={Boolean(picked[i]) && !w.isKnown} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} />
                <div>
                  <b lang="sw">{w.sw}</b> — {w.en} {w.is_sheng && <span className="chip">Sheng</span>} {w.isKnown && <span className="chip">Already in the course</span>}
                  {w.note && <div className="small muted">{w.note}</div>}
                </div>
              </label>
            ))}
            {error && <div className="error">{error}</div>}
            <button className="btn primary" style={{ width: "100%", marginTop: 12 }} onClick={save} disabled={busy}>{busy ? "Adding…" : "Add selected words"}</button>
          </div>
        </>
      )}
    </>
  );
}

// ---------- progress ----------
function streakOf(days) {
  const set = new Set(days);
  let d = new Date();
  if (!set.has(d.toDateString())) d = new Date(Date.now() - 86400000);
  let n = 0;
  while (set.has(d.toDateString())) { n++; d = new Date(d.getTime() - 86400000); }
  return n;
}

function Progress({ allItems, myItems, states, reviewsToday, days, userCards, onChanged }) {
  const started = allItems.filter((i) => states[i.key]).length;
  const due = allItems.filter((i) => isDue(states[i.key])).length;
  const overall = mastery(allItems, states);
  const removeCard = async (id) => {
    await supabase.from("user_cards").delete().eq("id", id);
    await supabase.from("card_states").delete().eq("card_key", `u:${id}`);
    onChanged();
  };
  return (
    <>
      <div className="stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="stat"><b>{streakOf(days)}</b><span>day streak</span></div>
        <div className="stat"><b>{reviewsToday}</b><span>answers today</span></div>
        <div className="stat"><b>{started}/{allItems.length}</b><span>items started</span></div>
        <div className="stat"><b>{due}</b><span>due for review</span></div>
      </div>
      <div className="panel">
        <div className="row"><h2>Course mastery</h2><b>{overall.pct}%</b></div>
        <div className="bar"><i style={{ width: `${overall.pct}%` }} /></div>
        <p className="small muted">Mastery is the model's estimate of how much you'd remember right now. Items you haven't started count as 0.</p>
        {myItems.length > 0 && <TopicRow name={MY_WORDS_TITLE} m={mastery(myItems, states)} />}
        {SYLLABUS.map((u) => <TopicRow key={u.id} name={u.title} m={mastery(u.items, states)} />)}
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

function TopicRow({ name, m }) {
  return (
    <div className="topic">
      <div className="row"><span>{name}</span><span className="small muted">{m.started}/{m.total} · {m.pct}%</span></div>
      <div className="bar"><i style={{ width: `${m.pct}%` }} /></div>
    </div>
  );
}
