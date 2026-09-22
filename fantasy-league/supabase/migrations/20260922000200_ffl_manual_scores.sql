-- Applied as migration "ffl_manual_scores". Commissioner-entered scores used while Yahoo API access is pending.
create table public.ffl_manual_scores (
  week        int primary key check (week between 1 and 20),
  matchups    jsonb not null,
  updated_by  uuid references public.ffl_members (user_id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table public.ffl_manual_scores enable row level security;
create policy "members read manual scores" on public.ffl_manual_scores
  for select to authenticated using (public.ffl_is_member());
create policy "commissioners insert manual scores" on public.ffl_manual_scores
  for insert to authenticated with check (public.ffl_is_commissioner());
create policy "commissioners update manual scores" on public.ffl_manual_scores
  for update to authenticated using (public.ffl_is_commissioner()) with check (public.ffl_is_commissioner());
create policy "commissioners delete manual scores" on public.ffl_manual_scores
  for delete to authenticated using (public.ffl_is_commissioner());
create or replace function public.ffl_server_get_manual_scores(secret text)
returns setof public.ffl_manual_scores language plpgsql security definer set search_path = public as $$
begin
  perform public.ffl_server_check(secret);
  return query select * from public.ffl_manual_scores order by week desc limit 1;
end;
$$;
grant execute on function public.ffl_server_get_manual_scores(text) to anon, authenticated;
