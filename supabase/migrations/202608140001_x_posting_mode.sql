create table public.bot_settings (
  id smallint primary key check (id = 1),
  x_posting_mode text not null
    check (x_posting_mode in ('off', 'manual', 'auto')),
  updated_at timestamptz not null
);

insert into public.bot_settings(id, x_posting_mode, updated_at)
values (1, 'off', now());

alter table public.bot_settings enable row level security;

revoke all on table public.bot_settings from public, anon, authenticated;
grant select, update on table public.bot_settings to service_role;
