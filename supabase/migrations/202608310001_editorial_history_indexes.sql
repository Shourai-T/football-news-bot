create index articles_published_at_idx
  on public.articles (published_at);

create index drafts_delivered_created_at_idx
  on public.drafts (created_at)
  where telegram_message_id is not null
    and status in ('pending', 'approved', 'rejected');
