create table if not exists public.lpg_delivery_completions (
  booking_key text primary key,
  consumer_no text not null,
  order_no text,
  pending_id bigint,
  delivery_man text not null,
  qty integer not null default 1 check (qty > 0),
  completed_at timestamptz not null default now(),
  gps_captured_at timestamptz not null,
  gps_lat double precision not null check (gps_lat between -90 and 90),
  gps_lng double precision not null check (gps_lng between -180 and 180),
  gps_accuracy double precision not null check (gps_accuracy >= 0 and gps_accuracy <= 5),
  source text not null default 'deliveryapp',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lpg_delivery_completions_delivery_time_idx
  on public.lpg_delivery_completions (delivery_man, completed_at desc);
create index if not exists lpg_delivery_completions_consumer_time_idx
  on public.lpg_delivery_completions (consumer_no, completed_at desc);
alter table public.lpg_delivery_completions enable row level security;
revoke all on table public.lpg_delivery_completions from public, anon, authenticated;
grant all on table public.lpg_delivery_completions to service_role;
