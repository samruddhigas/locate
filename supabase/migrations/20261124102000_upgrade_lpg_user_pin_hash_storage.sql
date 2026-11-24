alter table public.lpg_users add column if not exists pin_salt text;
alter table public.lpg_users add column if not exists pin_fingerprint text;
create index if not exists lpg_users_pin_fingerprint_idx
  on public.lpg_users (pin_fingerprint)
  where pin_fingerprint is not null;
