create table public.articles (
  id bigint generated always as identity primary key,
  canonical_url text not null unique,
  title text not null,
  source_name text not null,
  published_at timestamptz,
  excerpt text not null,
  eligible boolean not null,
  created_at timestamptz not null
);

create table public.scheduled_runs (
  slot_key text primary key,
  local_date date not null,
  outcome text not null check (outcome in (
    'running',
    'no_candidate',
    'draft_sent',
    'rss_unavailable',
    'quota_limited',
    'gemini_failed',
    'telegram_failed',
    'internal_failed'
  )),
  gemini_requests smallint not null default 0
    check (gemini_requests between 0 and 1),
  error_summary text,
  created_at timestamptz not null,
  completed_at timestamptz
);

create table public.daily_usage (
  local_date date primary key,
  gemini_requests smallint not null
    check (gemini_requests between 0 and 5)
);

create table public.drafts (
  id bigint generated always as identity primary key,
  article_id bigint not null references public.articles(id),
  body text not null check (length(btrim(body)) > 0),
  telegram_message_id bigint,
  status text not null check (status in (
    'pending',
    'approved',
    'rejected',
    'failed'
  )),
  created_at timestamptz not null,
  decided_at timestamptz
);

create index drafts_status_created_at_idx
  on public.drafts(status, created_at);

alter table public.articles enable row level security;
alter table public.drafts enable row level security;
alter table public.scheduled_runs enable row level security;
alter table public.daily_usage enable row level security;

revoke all on table public.articles from public, anon, authenticated;
revoke all on table public.drafts from public, anon, authenticated;
revoke all on table public.scheduled_runs from public, anon, authenticated;
revoke all on table public.daily_usage from public, anon, authenticated;

grant select, insert, update, delete on table public.articles to service_role;
grant select, insert, update, delete on table public.drafts to service_role;
grant select, insert, update, delete on table public.scheduled_runs to service_role;
grant select, insert, update, delete on table public.daily_usage to service_role;

revoke all on sequence public.articles_id_seq from public, anon, authenticated;
revoke all on sequence public.drafts_id_seq from public, anon, authenticated;
grant usage, select on sequence public.articles_id_seq to service_role;
grant usage, select on sequence public.drafts_id_seq to service_role;

create or replace function public.reserve_gemini_request(
  p_slot_key text,
  p_local_date date
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  quota_reserved boolean := false;
  run_marked boolean := false;
begin
  insert into public.daily_usage(local_date, gemini_requests)
  values (p_local_date, 0)
  on conflict (local_date) do nothing;

  update public.daily_usage
  set gemini_requests = gemini_requests + 1
  where local_date = p_local_date
    and gemini_requests < 5
  returning true into quota_reserved;

  if not coalesce(quota_reserved, false) then
    return false;
  end if;

  update public.scheduled_runs
  set gemini_requests = 1
  where slot_key = p_slot_key
    and local_date = p_local_date
    and gemini_requests = 0
  returning true into run_marked;

  if coalesce(run_marked, false) then
    return true;
  end if;

  update public.daily_usage
  set gemini_requests = gemini_requests - 1
  where local_date = p_local_date
    and gemini_requests > 0;

  return false;
end;
$$;

create or replace function public.transition_draft(
  p_draft_id bigint,
  p_decision text,
  p_decided_at timestamptz
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  final_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception using
      errcode = '22023',
      message = 'invalid_draft_decision';
  end if;

  update public.drafts
  set status = p_decision,
      decided_at = p_decided_at
  where id = p_draft_id
    and status = 'pending'
  returning status into final_status;

  if final_status is not null then
    return final_status;
  end if;

  select status
  into final_status
  from public.drafts
  where id = p_draft_id;

  return final_status;
end;
$$;

revoke all on function public.reserve_gemini_request(text, date)
  from public, anon, authenticated;
revoke all on function public.transition_draft(bigint, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.reserve_gemini_request(text, date)
  to service_role;
grant execute on function public.transition_draft(bigint, text, timestamptz)
  to service_role;
