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
