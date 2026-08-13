do $$
declare
  matching_count bigint;
  configured_job record;
  expected_command text := $job$
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
  $job$;
begin
  select count(*)
  into matching_count
  from cron.job
  where jobname = 'football-news-pipeline';

  if matching_count <> 1 then
    raise exception 'expected exactly one football-news-pipeline job, found %',
      matching_count;
  end if;

  select schedule, command, active
  into configured_job
  from cron.job
  where jobname = 'football-news-pipeline';

  if configured_job.active is not true then
    raise exception 'football-news-pipeline is inactive';
  end if;
  if configured_job.schedule <> '7 1,4,7,10,13 * * *' then
    raise exception 'football-news-pipeline schedule is incorrect';
  end if;
  if regexp_replace(btrim(configured_job.command), '\s+', ' ', 'g') <>
     regexp_replace(btrim(expected_command), '\s+', ' ', 'g') then
    raise exception 'football-news-pipeline command is incorrect';
  end if;
end;
$$;

select jobid, jobname, schedule, active
from cron.job
where jobname = 'football-news-pipeline';

select jobid, runid, status, start_time, end_time
from cron.job_run_details
where jobid in (
  select jobid
  from cron.job
  where jobname = 'football-news-pipeline'
)
order by start_time desc
limit 10;
