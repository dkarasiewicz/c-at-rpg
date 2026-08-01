-- c(at)rpg — the shared content pool ("the Dreaming").
--
-- Lives in its OWN schema (`catrpg`) inside the shared Supabase project, so it
-- cannot collide with anything else in that database.
--
-- Everything here is CONTENT, never player identity: a Stand somebody dreamed,
-- an item, an event, an enemy, a compiled Stand interaction, and the art that
-- belongs to each. The local MetaFile remains the source of truth for a
-- player's own town; this table set only makes the WORLD bigger. The game must
-- stay completely playable with none of it reachable.
--
-- Apply:  psql "$POSTGRES_URL_NON_POOLING" -f supabase/001_init.sql
-- Safe to re-run.
--
-- ONE THING THIS FILE CANNOT DO ALONE. PostgREST only serves schemas it has
-- been told to expose, so a perfectly created table answers 404 over the REST
-- API ("Could not find the table 'catrpg.content' in the schema cache" — it can
-- SEE the table, it just will not serve it). Exposing it is a role setting plus
-- a cache reload, applied once per database:
--
--   alter role authenticator set pgrst.db_schemas = 'public,graphql_public,catrpg';
--   notify pgrst, 'reload schema';
--   notify pgrst, 'reload config';
--
-- Both notifies matter: `reload config` picks up the schema LIST, `reload
-- schema` rebuilds the cache that knows the tables in it. Sending only one
-- leaves the 404 in place and looks like a permissions problem.
-- The statements are below so a fresh database is one command.

create schema if not exists catrpg;

-- One table per content kind would fragment the pool-first read, and one
-- table with a `kind` column keeps "give me something for floor 3" a single
-- query. The payload stays JSONB because every kind is already validated
-- against the engine's own schemas before it gets here — Postgres is the
-- store, the game is the authority.
create table if not exists catrpg.content (
  id             text primary key,
  kind           text not null check (kind in
                   ('stand','item','event','enemy','encounter','background','cat','power')),
  -- what the engine consumes, exactly as the client will receive it
  payload        jsonb not null,
  -- art
  art_url        text,
  art_prompt     text,
  style_version  integer not null default 1,
  -- pool-first selection knobs
  floor_min      smallint not null default 1 check (floor_min between 1 and 6),
  floor_max      smallint not null default 6 check (floor_max between 1 and 6),
  tier           smallint,
  rating         integer  not null default 0,
  times_used     integer  not null default 0,
  -- provenance: who dreamed it, and against which rules
  author_session text,
  framework_ver  integer  not null default 1,
  created_at     timestamptz not null default now(),
  check (floor_min <= floor_max)
);

-- The selection query is "a <kind> legal on floor N, not retired, freshest
-- first" — this index is that query.
create index if not exists content_pick_idx
  on catrpg.content (kind, floor_min, floor_max, rating desc, created_at desc);

create index if not exists content_style_idx
  on catrpg.content (style_version);

-- Compiled Stand-vs-Stand interactions (stand-powers.md Layer 3). Memoised by
-- an ORDERED pair key so the first meeting anywhere pays the model cost once
-- and every later meeting is free. A null rule is a real answer ("these two do
-- not resonate") and is worth storing precisely so it is never recomputed.
create table if not exists catrpg.interactions (
  pair_key        text primary key,
  framework_ver   integer not null default 1,
  rule            jsonb,            -- null = no resonance, deliberately
  flavor          text,
  announce        text,
  times_triggered integer not null default 0,
  first_by        text,             -- credited on the results screen
  created_at      timestamptz not null default now()
);

-- Keyed art for things that are not pool rows (shipped sprites, generated
-- icons), so a style-version bump can find and requeue stale pictures.
create table if not exists catrpg.art (
  key            text primary key,
  url            text not null,
  prompt         text,
  style_version  integer not null default 1,
  created_at     timestamptz not null default now()
);

-- RLS on everything. The grants are split deliberately and the split is the
-- whole security model: the service role (the DM agent, and only the DM agent)
-- WRITES; anon READS. The read policies are at the bottom of this file, with
-- the argument for why content-with-no-identity is safe to publish.
alter table catrpg.content      enable row level security;
alter table catrpg.interactions enable row level security;
alter table catrpg.art          enable row level security;

grant usage on schema catrpg to service_role;
grant all on all tables in schema catrpg to service_role;
alter default privileges in schema catrpg grant all on tables to service_role;

-- Expose the schema to PostgREST (see the header note). Idempotent.
alter role authenticator set pgrst.db_schemas = 'public,graphql_public,catrpg';
notify pgrst, 'reload schema';
notify pgrst, 'reload config';

-- ANON MAY READ, NOBODY BUT THE SERVICE ROLE MAY WRITE.
--
-- Everything in this schema is CONTENT — a dreamed Stand, an item, a rule —
-- with no player identity anywhere, so it is safe for the browser to read
-- directly. That matters for the offline story: the game can show the world
-- other players have dreamed even when the DM agent is slow or down, because
-- reading the pool needs no agent and no secret, only the publishable key.
-- Writing stays service-role-only, which is why the DM is the only thing that
-- ever holds that key.
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='catrpg' and tablename='content' and policyname='content_read') then
    create policy content_read on catrpg.content for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname='catrpg' and tablename='interactions' and policyname='interactions_read') then
    create policy interactions_read on catrpg.interactions for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname='catrpg' and tablename='art' and policyname='art_read') then
    create policy art_read on catrpg.art for select to anon, authenticated using (true);
  end if;
end $$;

grant usage on schema catrpg to anon, authenticated;
grant select on all tables in schema catrpg to anon, authenticated;
alter default privileges in schema catrpg grant select on tables to anon, authenticated;
notify pgrst, 'reload schema';
