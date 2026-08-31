begin;
select plan(4);
select has_index('public', 'articles', 'articles_published_at_idx', 'article history index exists');
select has_index('public', 'drafts', 'drafts_delivered_created_at_idx', 'delivery history index exists');
select ok(not has_table_privilege('anon', 'public.articles', 'SELECT'), 'articles remain private');
select ok(not has_table_privilege('authenticated', 'public.drafts', 'SELECT'), 'drafts remain private');
select * from finish();
rollback;
