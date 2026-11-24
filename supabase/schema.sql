-- Msamiati: run this once in Supabase > SQL Editor > New query > Run.

-- Words a learner added from pasted text
create table if not exists public.user_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  sw text not null,
  en text not null,
  note text,
  example_sw text,
  example_en text,
  topic text not null default 'My words',
  import_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists user_cards_unique_word on public.user_cards (user_id, lower(sw));

-- Pasted texts and their translations
create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text,
  source_text text not null,
  translation jsonb,
  created_at timestamptz not null default now()
);

-- Memory state per learner per card (the learner model)
create table if not exists public.card_states (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  card_key text not null,
  stability double precision not null,
  difficulty double precision not null,
  due timestamptz not null,
  last_review timestamptz not null,
  reps int not null default 0,
  lapses int not null default 0,
  primary key (user_id, card_key)
);

-- Every review, for analysis
create table if not exists public.review_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  card_key text not null,
  topic text,
  rating smallint not null check (rating between 1 and 4),
  elapsed_days double precision,
  scheduled_days int,
  predicted_recall double precision,
  was_new boolean,
  reviewed_at timestamptz not null default now()
);

-- Row-level security: each learner sees only their own rows
alter table public.user_cards enable row level security;
alter table public.imports enable row level security;
alter table public.card_states enable row level security;
alter table public.review_log enable row level security;

do $$
declare t text;
begin
  foreach t in array array['user_cards','imports','card_states','review_log'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Handy view for you (the owner) in the dashboard: reviews per tester per day
create or replace view public.tester_activity with (security_invoker = true) as
select u.email, date(r.reviewed_at) as day, count(*) as reviews,
       round(avg((r.rating > 1)::int)::numeric, 2) as recall_rate
from public.review_log r join auth.users u on u.id = r.user_id
group by 1, 2 order by 2 desc, 1;
revoke all on public.tester_activity from anon, authenticated;
