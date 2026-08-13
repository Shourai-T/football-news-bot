create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'football-news-pipeline'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'football-news-pipeline',
  '7 1,4,7,10,13 * * *',
  $job$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'project_url'
    ) || '/functions/v1/scheduled-pipeline',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'X-Scheduled-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'scheduled_function_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $job$
);
