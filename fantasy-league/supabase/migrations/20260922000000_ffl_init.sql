-- Applied to the Supabase project as migration "ffl_init". Kept here for reference / re-creation.
-- See README.md for what each table is for.

create table public.ffl_league (
  id            int primary key default 1 check (id = 1),
  name          text not null default 'The League',
  invite_code   text not null,
  yahoo_league_key text,
  created_at    timestamptz not null default now()
);

create table public.ffl_members (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  display_name    text not null check (char_length(display_name) between 1 and 40),
  team_name       text check (team_name is null or char_length(team_name) <= 60),
  is_commissioner boolean not null default false,
  joined_at       timestamptz not null default now()
);

create table public.ffl_messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.ffl_members (user_id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index ffl_messages_created_at_idx on public.ffl_messages (created_at desc);

create table public.ffl_burns (
  id           bigint generated always as identity primary key,
  target       text,
  headline     text not null,
  burn         text not null,
  prompt       text not null,
  source       text not null default 'manual' check (source in ('manual', 'auto', 'cron')),
  requested_by uuid references public.ffl_members (user_id) on delete set null,
  last_message_id bigint,
  created_at   timestamptz not null default now()
);
create index ffl_burns_created_at_idx on public.ffl_burns (created_at desc);

create table public.ffl_yahoo_tokens (
  id            int primary key default 1 check (id = 1),
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  yahoo_guid    text,
  updated_at    timestamptz not null default now()
);

alter table public.ffl_league        enable row level security;
alter table public.ffl_members       enable row level security;
alter table public.ffl_messages      enable row level security;
alter table public.ffl_burns         enable row level security;
alter table public.ffl_yahoo_tokens  enable row level security;

create or replace function public.ffl_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ffl_members where user_id = auth.uid());
$$;

create or replace function public.ffl_is_commissioner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ffl_members where user_id = auth.uid() and is_commissioner);
$$;

create or replace function public.ffl_join_league(code text, display_name text, team_name text default null)
returns public.ffl_members language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  league public.ffl_league;
  member public.ffl_members;
begin
  if uid is null then
    raise exception 'You must be signed in to join.' using errcode = '28000';
  end if;
  select * into league from public.ffl_league where id = 1;
  if league is null then
    raise exception 'The league has not been set up yet.' using errcode = 'P0002';
  end if;
  if lower(trim(code)) <> lower(trim(league.invite_code)) then
    raise exception 'That invite code is not right.' using errcode = '28000';
  end if;
  insert into public.ffl_members (user_id, display_name, team_name, is_commissioner)
  values (uid, trim(display_name), nullif(trim(coalesce(team_name, '')), ''), not exists (select 1 from public.ffl_members))
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        team_name    = coalesce(excluded.team_name, public.ffl_members.team_name)
  returning * into member;
  return member;
end;
$$;

revoke all on function public.ffl_join_league(text, text, text) from public, anon;
grant execute on function public.ffl_join_league(text, text, text) to authenticated;
revoke all on function public.ffl_is_member() from public, anon;
revoke all on function public.ffl_is_commissioner() from public, anon;
grant execute on function public.ffl_is_member() to authenticated;
grant execute on function public.ffl_is_commissioner() to authenticated;

create policy "commissioners read league" on public.ffl_league
  for select to authenticated using (public.ffl_is_commissioner());
create policy "commissioners update league" on public.ffl_league
  for update to authenticated using (public.ffl_is_commissioner()) with check (public.ffl_is_commissioner());

create policy "members read members" on public.ffl_members
  for select to authenticated using (public.ffl_is_member());
create policy "members update own profile" on public.ffl_members
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_commissioner = (select m.is_commissioner from public.ffl_members m where m.user_id = auth.uid()));

create policy "members read messages" on public.ffl_messages
  for select to authenticated using (public.ffl_is_member());
create policy "members post messages" on public.ffl_messages
  for insert to authenticated with check (public.ffl_is_member() and user_id = auth.uid());

create policy "members read burns" on public.ffl_burns
  for select to authenticated using (public.ffl_is_member());

-- ffl_yahoo_tokens: no policies on purpose (service role only).

alter publication supabase_realtime add table public.ffl_messages;
alter publication supabase_realtime add table public.ffl_burns;

-- Seed the single league row with a random invite code (change it in Settings).
insert into public.ffl_league (id, name, invite_code)
values (1, 'The League', 'GRIDIRON-' || upper(substr(md5(gen_random_uuid()::text), 1, 6)))
on conflict (id) do nothing;
