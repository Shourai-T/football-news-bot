begin;

select plan(12);

create function pg_temp.bot_settings_count()
returns bigint
language plpgsql
as $$
declare
  result bigint;
begin
  if to_regclass('public.bot_settings') is null then
    return null;
  end if;
  execute 'select count(*) from public.bot_settings' into result;
  return result;
end;
$$;

create function pg_temp.x_posting_mode()
returns text
language plpgsql
as $$
declare
  result text;
begin
  if to_regclass('public.bot_settings') is null then
    return null;
  end if;
  execute 'select x_posting_mode from public.bot_settings where id = 1'
    into result;
  return result;
end;
$$;

select has_table('public', 'bot_settings', 'bot settings table exists');
select has_column('public', 'bot_settings', 'id', 'singleton id exists');
select has_column('public', 'bot_settings', 'x_posting_mode', 'X mode exists');
select has_column('public', 'bot_settings', 'updated_at', 'update timestamp exists');
select ok(
  coalesce(
    (select relrowsecurity
      from pg_class
      where oid = to_regclass('public.bot_settings')),
    false
  ),
  'bot settings has RLS enabled'
);
select is(
  pg_temp.bot_settings_count(),
  1::bigint,
  'one setting row exists'
);
select is(
  pg_temp.x_posting_mode(),
  'off',
  'X mode defaults to off'
);
select throws_ok(
  $$insert into public.bot_settings(id, x_posting_mode, updated_at)
    values (2, 'off', now())$$,
  '23514',
  null,
  'singleton id is constrained to one'
);
select throws_ok(
  $$update public.bot_settings set x_posting_mode = 'invalid' where id = 1$$,
  '23514',
  null,
  'X mode values are constrained'
);
select ok(
  case
    when to_regclass('public.bot_settings') is null then false
    else not has_table_privilege('anon', 'public.bot_settings', 'SELECT')
  end,
  'anon cannot read bot settings'
);
select ok(
  case
    when to_regclass('public.bot_settings') is null then false
    else not has_table_privilege(
      'authenticated',
      'public.bot_settings',
      'UPDATE'
    )
  end,
  'authenticated cannot update bot settings'
);
select ok(
  case
    when to_regclass('public.bot_settings') is null then false
    else has_table_privilege('service_role', 'public.bot_settings', 'SELECT') and
      has_table_privilege('service_role', 'public.bot_settings', 'UPDATE')
  end,
  'service role can read and update bot settings'
);

select * from finish();
rollback;
