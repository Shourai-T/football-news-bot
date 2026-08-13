begin;

select plan(38);

select has_table('public', 'articles', 'articles table exists');
select has_table('public', 'drafts', 'drafts table exists');
select has_table('public', 'scheduled_runs', 'scheduled_runs table exists');
select has_table('public', 'daily_usage', 'daily_usage table exists');
select has_function(
  'public',
  'reserve_gemini_request',
  array['text', 'date'],
  'quota reservation RPC exists'
);
select has_function(
  'public',
  'transition_draft',
  array['bigint', 'text', 'timestamp with time zone'],
  'draft transition RPC exists'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.articles'::regclass),
  'articles has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.drafts'::regclass),
  'drafts has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.scheduled_runs'::regclass),
  'scheduled_runs has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.daily_usage'::regclass),
  'daily_usage has RLS enabled'
);
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename in (
    'articles', 'drafts', 'scheduled_runs', 'daily_usage'
  )),
  0::bigint,
  'bot tables expose no RLS policies'
);
select is(
  (
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('articles', 'drafts', 'scheduled_runs', 'daily_usage')
      and grantee in ('anon', 'authenticated')
  ),
  0::bigint,
  'public API roles have no bot table grants'
);
select is(
  (
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('articles', 'drafts', 'scheduled_runs', 'daily_usage')
      and grantee = 'service_role'
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  16::bigint,
  'service_role can read and mutate every bot table'
);

create temporary table test_context (
  article_id bigint,
  draft_id bigint
) on commit drop;

with inserted_article as (
  insert into public.articles (
    canonical_url,
    title,
    source_name,
    published_at,
    excerpt,
    eligible,
    created_at
  ) values (
    'https://example.com/one',
    'First article',
    'Test source',
    '2026-08-12 00:00:00+00',
    'First excerpt',
    true,
    '2026-08-12 00:01:00+00'
  )
  returning id
)
insert into test_context(article_id)
select id from inserted_article;

select throws_ok(
  $$
    insert into public.articles (
      canonical_url, title, source_name, excerpt, eligible, created_at
    ) values (
      'https://example.com/one', 'Duplicate', 'Test source', 'Duplicate', true,
      '2026-08-12 00:02:00+00'
    )
  $$,
  '23505',
  null,
  'canonical article URLs are unique'
);

insert into public.scheduled_runs (
  slot_key, local_date, outcome, created_at
) values (
  '2026-08-12T01:07Z', '2026-08-12', 'running', '2026-08-12 01:07:00+00'
);

select throws_ok(
  $$
    insert into public.scheduled_runs (
      slot_key, local_date, outcome, created_at
    ) values (
      '2026-08-12T01:07Z', '2026-08-12', 'running',
      '2026-08-12 01:07:01+00'
    )
  $$,
  '23505',
  null,
  'scheduled slot keys are unique'
);
select throws_ok(
  $$
    insert into public.scheduled_runs (
      slot_key, local_date, outcome, created_at
    ) values (
      'invalid-outcome-slot', '2026-08-12', 'unknown',
      '2026-08-12 02:00:00+00'
    )
  $$,
  '23514',
  null,
  'scheduled outcomes are constrained'
);
select throws_ok(
  $$
    insert into public.daily_usage(local_date, gemini_requests)
    values ('2026-08-13', 6)
  $$,
  '23514',
  null,
  'daily usage cannot exceed five'
);
select throws_ok(
  $$
    insert into public.drafts(article_id, body, status, created_at)
    select article_id, '   ', 'pending', '2026-08-12 01:08:00+00'
    from test_context
  $$,
  '23514',
  null,
  'draft bodies cannot be blank'
);

select is(
  public.reserve_gemini_request('2026-08-12T01:07Z', '2026-08-12'),
  true,
  'first reservation succeeds'
);
select is(
  public.reserve_gemini_request('2026-08-12T01:07Z', '2026-08-12'),
  false,
  'duplicate slot reservation is rejected'
);
select is(
  (select gemini_requests from public.daily_usage where local_date = '2026-08-12'),
  1::smallint,
  'duplicate slot compensation preserves daily usage'
);

insert into public.scheduled_runs(slot_key, local_date, outcome, created_at)
values
  ('2026-08-12T04:07Z', '2026-08-12', 'running', '2026-08-12 04:07:00+00'),
  ('2026-08-12T07:07Z', '2026-08-12', 'running', '2026-08-12 07:07:00+00'),
  ('2026-08-12T10:07Z', '2026-08-12', 'running', '2026-08-12 10:07:00+00'),
  ('2026-08-12T13:07Z', '2026-08-12', 'running', '2026-08-12 13:07:00+00'),
  ('2026-08-12T16:07Z', '2026-08-12', 'running', '2026-08-12 16:07:00+00');

select is(
  public.reserve_gemini_request('2026-08-12T04:07Z', '2026-08-12'),
  true,
  'second reservation succeeds'
);
select is(
  public.reserve_gemini_request('2026-08-12T07:07Z', '2026-08-12'),
  true,
  'third reservation succeeds'
);
select is(
  public.reserve_gemini_request('2026-08-12T10:07Z', '2026-08-12'),
  true,
  'fourth reservation succeeds'
);
select is(
  public.reserve_gemini_request('2026-08-12T13:07Z', '2026-08-12'),
  true,
  'fifth reservation succeeds'
);
select is(
  public.reserve_gemini_request('2026-08-12T16:07Z', '2026-08-12'),
  false,
  'sixth daily reservation is rejected'
);
select is(
  (select gemini_requests from public.daily_usage where local_date = '2026-08-12'),
  5::smallint,
  'daily usage remains capped at five'
);

with inserted_draft as (
  insert into public.drafts(article_id, body, status, created_at)
  select
    article_id,
    'A valid English draft.',
    'pending',
    '2026-08-12 01:08:00+00'
  from test_context
  returning id
)
update test_context
set draft_id = inserted_draft.id
from inserted_draft;

select is(
  public.transition_draft(
    (select draft_id from test_context),
    'approved',
    '2026-08-12 01:09:00+00'
  ),
  'approved',
  'pending draft transitions to approved'
);
select is(
  public.transition_draft(
    (select draft_id from test_context),
    'rejected',
    '2026-08-12 01:10:00+00'
  ),
  'approved',
  'late decision preserves the first terminal state'
);
select is(
  (
    select status
    from public.drafts
    where id = (select draft_id from test_context)
  ),
  'approved',
  'stored draft remains in its first terminal state'
);
select throws_ok(
  $$
    select public.transition_draft(
      (select draft_id from test_context),
      'invalid',
      '2026-08-12 01:11:00+00'
    )
  $$,
  '22023',
  'invalid_draft_decision',
  'invalid draft decisions are rejected'
);
select is(
  public.transition_draft(
    9223372036854775807,
    'approved',
    '2026-08-12 01:11:00+00'
  ),
  null::text,
  'missing draft transition returns null'
);

select ok(
  not has_function_privilege(
    'anon', 'public.reserve_gemini_request(text,date)', 'EXECUTE'
  ),
  'anon cannot reserve Gemini quota'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.reserve_gemini_request(text,date)', 'EXECUTE'
  ),
  'authenticated cannot reserve Gemini quota'
);
select ok(
  has_function_privilege(
    'service_role', 'public.reserve_gemini_request(text,date)', 'EXECUTE'
  ),
  'service_role can reserve Gemini quota'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.transition_draft(bigint,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'anon cannot transition drafts'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.transition_draft(bigint,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated cannot transition drafts'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.transition_draft(bigint,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'service_role can transition drafts'
);

select * from finish();
rollback;
