create table if not exists public.lpg_delivery_routes (
  id uuid primary key default gen_random_uuid(),
  route_date date not null,
  delivery_man text not null,
  route_version uuid not null,
  status text not null default 'published' check (status in ('published','superseded','cancelled')),
  stop_count integer not null default 0 check (stop_count >= 0),
  total_distance_km numeric(10,2) not null default 0 check (total_distance_km >= 0),
  published_by text not null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(route_date, delivery_man, route_version)
);
create index if not exists lpg_delivery_routes_lookup_idx
  on public.lpg_delivery_routes (route_date, delivery_man, status, published_at desc);
create table if not exists public.lpg_delivery_route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.lpg_delivery_routes(id) on delete cascade,
  booking_key text not null,
  consumer_no text not null,
  stop_order integer not null check (stop_order > 0),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  dist_from_prev_km numeric(10,3) not null default 0 check (dist_from_prev_km >= 0),
  created_at timestamptz not null default now(),
  unique(route_id, booking_key),
  unique(route_id, stop_order)
);
create index if not exists lpg_delivery_route_stops_route_order_idx
  on public.lpg_delivery_route_stops (route_id, stop_order);
alter table public.lpg_delivery_routes enable row level security;
alter table public.lpg_delivery_route_stops enable row level security;
revoke all on table public.lpg_delivery_routes, public.lpg_delivery_route_stops from public, anon, authenticated;
grant all on table public.lpg_delivery_routes, public.lpg_delivery_route_stops to service_role;
