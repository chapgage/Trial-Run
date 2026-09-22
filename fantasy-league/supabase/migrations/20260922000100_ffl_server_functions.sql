-- Applied as migration "ffl_server_functions". Server-side access without the service_role key:
-- api/ functions call these RPCs with the anon key plus FFL_SERVER_SECRET.
-- After running this, insert your own secret:  insert into public.ffl_server_secret (id, secret) values (1, '<random>');

create table public.ffl_server_secret (
  id     int primary key default 1 check (id = 1),
  secret text not null,
  rotated_at timestamptz not null default now()
);
alter table public.ffl_server_secret enable row level security;  -- no policies: never readable via the API

create or replace function public.ffl_server_check(secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if secret is null or secret <> (select s.secret from public.ffl_server_secret s where s.id = 1) then
    raise exception 'Server secret rejected.' using errcode = '28000';
  end if;
end;
$$;
revoke all on function public.ffl_server_check(text) from public, anon, authenticated;

create or replace function public.ffl_server_get_yahoo_tokens(secret text)
returns setof public.ffl_yahoo_tokens language plpgsql security definer set search_path = public as $$
begin
  perform public.ffl_server_check(secret);
  return query select * from public.ffl_yahoo_tokens where id = 1;
end;
$$;

create or replace function public.ffl_server_save_yahoo_tokens(
  secret text, access_token text, refresh_token text, expires_at timestamptz, yahoo_guid text default null)
returns public.ffl_yahoo_tokens language plpgsql security definer set search_path = public as $$
declare row public.ffl_yahoo_tokens;
begin
  perform public.ffl_server_check(secret);
  insert into public.ffl_yahoo_tokens as t (id, access_token, refresh_token, expires_at, yahoo_guid, updated_at)
  values (1, access_token, refresh_token, expires_at, yahoo_guid, now())
  on conflict (id) do update
    set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at, yahoo_guid = coalesce(excluded.yahoo_guid, t.yahoo_guid), updated_at = now()
  returning * into row;
  return row;
end;
$$;

create or replace function public.ffl_server_get_league(secret text)
returns setof public.ffl_league language plpgsql security definer set search_path = public as $$
begin
  perform public.ffl_server_check(secret);
  return query select * from public.ffl_league where id = 1;
end;
$$;

create or replace function public.ffl_server_set_league_key(secret text, league_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.ffl_server_check(secret);
  update public.ffl_league set yahoo_league_key = league_key where id = 1;
end;
$$;

create or replace function public.ffl_server_insert_burn(
  secret text, target text, headline text, burn text, prompt text, source text,
  requested_by uuid default null, last_message_id bigint default null)
returns public.ffl_burns language plpgsql security definer set search_path = public as $$
declare row public.ffl_burns;
begin
  perform public.ffl_server_check(secret);
  insert into public.ffl_burns (target, headline, burn, prompt, source, requested_by, last_message_id)
  values (target, headline, burn, prompt, source, requested_by, last_message_id)
  returning * into row;
  return row;
end;
$$;

create or replace function public.ffl_server_chat_context(secret text, message_limit int default 40)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  perform public.ffl_server_check(secret);
  select jsonb_build_object(
    'league', (select to_jsonb(l) from public.ffl_league l where l.id = 1),
    'members', coalesce((select jsonb_agg(to_jsonb(m)) from public.ffl_members m), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.id)
      from (select * from public.ffl_messages order by id desc limit greatest(1, least(message_limit, 200))) x
    ), '[]'::jsonb),
    'latest_burn', (select to_jsonb(b) from public.ffl_burns b order by b.id desc limit 1)
  ) into result;
  return result;
end;
$$;

grant execute on function public.ffl_server_get_yahoo_tokens(text) to anon, authenticated;
grant execute on function public.ffl_server_save_yahoo_tokens(text, text, text, timestamptz, text) to anon, authenticated;
grant execute on function public.ffl_server_get_league(text) to anon, authenticated;
grant execute on function public.ffl_server_set_league_key(text, text) to anon, authenticated;
grant execute on function public.ffl_server_insert_burn(text, text, text, text, text, text, uuid, bigint) to anon, authenticated;
grant execute on function public.ffl_server_chat_context(text, int) to anon, authenticated;
