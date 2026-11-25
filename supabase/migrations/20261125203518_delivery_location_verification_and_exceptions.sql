-- Repeated-delivery location verification.
-- Temporary pins are route-eligible after three independent, consistent deliveries.
-- Permanent office-approved lpg_gps coordinates are never modified by this workflow.

create table if not exists public.lpg_gps_temporary (
  consumer_no text primary key,
  lat double precision not null,
  lng double precision not null,
  best_accuracy_m double precision not null default 30,
  confirmation_count integer not null default 1,
  status text not null default 'candidate' check (status in ('candidate','provisional','temporary_approved','needs_review')),
  first_confirmed_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  last_delivery_man text,
  updated_at timestamptz not null default now(),
  check (lat between -90 and 90),
  check (lng between -180 and 180),
  check (best_accuracy_m between 0 and 30),
  check (confirmation_count >= 1)
);

create table if not exists public.lpg_delivery_location_observations (
  id uuid primary key default gen_random_uuid(),
  booking_key text not null unique,
  consumer_no text not null,
  delivery_man text not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m double precision not null,
  captured_at timestamptz not null,
  reference_distance_m double precision,
  result text not null check (result in ('candidate','provisional','temporary_approved','matched_approved','nearby_warning','deviation','outlier_review','low_confidence')),
  temporary_confirmation_count integer,
  created_at timestamptz not null default now(),
  check (lat between -90 and 90),
  check (lng between -180 and 180),
  check (accuracy_m between 0 and 30)
);
create index if not exists lpg_delivery_location_observations_consumer_time_idx
  on public.lpg_delivery_location_observations (consumer_no, captured_at desc);

create table if not exists public.lpg_delivery_location_exceptions (
  id uuid primary key default gen_random_uuid(),
  booking_key text not null unique,
  consumer_no text not null,
  delivery_man text not null,
  observed_lat double precision not null,
  observed_lng double precision not null,
  reference_lat double precision,
  reference_lng double precision,
  distance_m double precision not null,
  accuracy_m double precision not null,
  severity text not null check (severity in ('warning','deviation','outlier')),
  reason text not null default 'Delivery location differs from the verified customer location',
  status text not null default 'open' check (status in ('open','reviewed','resolved','dismissed')),
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz
);
create index if not exists lpg_delivery_location_exceptions_status_idx
  on public.lpg_delivery_location_exceptions (status, created_at desc);

alter table public.lpg_delivery_completions
  add column if not exists location_check_status text not null default 'not_checked',
  add column if not exists location_distance_m double precision,
  add column if not exists temporary_location_status text,
  add column if not exists location_exception_id uuid;

alter table public.lpg_gps_temporary enable row level security;
alter table public.lpg_delivery_location_observations enable row level security;
alter table public.lpg_delivery_location_exceptions enable row level security;
revoke all on public.lpg_gps_temporary, public.lpg_delivery_location_observations, public.lpg_delivery_location_exceptions from anon, authenticated;
grant all on public.lpg_gps_temporary, public.lpg_delivery_location_observations, public.lpg_delivery_location_exceptions to service_role;

create or replace function public.record_lpg_delivery_location_observation(
  p_booking_key text,
  p_consumer_no text,
  p_delivery_man text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_captured_at timestamptz,
  p_exception_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_existing public.lpg_gps%rowtype;
  v_temp public.lpg_gps_temporary%rowtype;
  v_ref_lat double precision;
  v_ref_lng double precision;
  v_distance double precision;
  v_result text;
  v_count integer;
  v_exception_id uuid;
  v_new_lat double precision;
  v_new_lng double precision;
begin
  if coalesce(length(trim(p_booking_key)),0) = 0 or coalesce(length(trim(p_consumer_no)),0) = 0
     or coalesce(length(trim(p_delivery_man)),0) = 0
     or p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or p_accuracy is null or p_accuracy < 0 or p_accuracy > 30
     or p_captured_at is null or p_captured_at > now() + interval '5 minutes'
     or p_captured_at < now() - interval '2 hours' then
    raise exception 'Invalid or stale delivery location observation';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_consumer_no));
  insert into public.lpg_delivery_location_observations
    (booking_key,consumer_no,delivery_man,lat,lng,accuracy_m,captured_at,result)
  values (p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,p_accuracy,p_captured_at,'candidate')
  on conflict (booking_key) do nothing
  returning id into v_id;

  if v_id is null then
    return (select jsonb_build_object('duplicate',true,'result',result,'distance_m',reference_distance_m,
      'temporary_confirmation_count',temporary_confirmation_count)
      from public.lpg_delivery_location_observations where booking_key=p_booking_key);
  end if;

  select * into v_existing from public.lpg_gps where consumer_no=p_consumer_no and status='approved';
  if found then
    v_ref_lat := coalesce(v_existing.pin_lat,v_existing.lat);
    v_ref_lng := coalesce(v_existing.pin_lng,v_existing.lng);
    v_distance := 6371000 * 2 * asin(sqrt(
      power(sin(radians(p_lat-v_ref_lat)/2),2) +
      cos(radians(v_ref_lat))*cos(radians(p_lat))*power(sin(radians(p_lng-v_ref_lng)/2),2)
    ));
    if v_distance <= 30 then v_result := 'matched_approved';
    elsif v_distance <= 50 then v_result := 'nearby_warning';
    else v_result := 'deviation';
    end if;
    update public.lpg_delivery_location_observations
      set result=v_result, reference_distance_m=round(v_distance::numeric,2)
      where id=v_id;
    if v_result in ('nearby_warning','deviation') then
      insert into public.lpg_delivery_location_exceptions
        (booking_key,consumer_no,delivery_man,observed_lat,observed_lng,reference_lat,reference_lng,
         distance_m,accuracy_m,severity,reason)
      values (p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,v_ref_lat,v_ref_lng,
        round(v_distance::numeric,2),p_accuracy,
        case when v_result='deviation' then 'deviation' else 'warning' end,
        coalesce(nullif(trim(p_exception_reason),''),case when v_result='deviation'
          then 'Delivery recorded more than 50 metres from the approved customer pin'
          else 'Delivery recorded 30–50 metres from the approved customer pin' end))
      on conflict (booking_key) do update set distance_m=excluded.distance_m
      returning id into v_exception_id;
    end if;
    return jsonb_build_object('result',v_result,'distance_m',round(v_distance::numeric,2),
      'exception_id',v_exception_id,'temporary_confirmation_count',null);
  end if;

  select * into v_temp from public.lpg_gps_temporary where consumer_no=p_consumer_no for update;
  if not found then
    insert into public.lpg_gps_temporary(consumer_no,lat,lng,best_accuracy_m,confirmation_count,status,last_delivery_man)
      values(p_consumer_no,p_lat,p_lng,p_accuracy,1,'candidate',p_delivery_man)
      returning * into v_temp;
    v_result := 'candidate';
  else
    v_ref_lat := v_temp.lat; v_ref_lng := v_temp.lng;
    v_distance := 6371000 * 2 * asin(sqrt(
      power(sin(radians(p_lat-v_ref_lat)/2),2) +
      cos(radians(v_ref_lat))*cos(radians(p_lat))*power(sin(radians(p_lng-v_ref_lng)/2),2)
    ));
    if v_distance > 20 then
      v_result := 'outlier_review';
      insert into public.lpg_delivery_location_exceptions
        (booking_key,consumer_no,delivery_man,observed_lat,observed_lng,reference_lat,reference_lng,
         distance_m,accuracy_m,severity,reason)
      values(p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,v_ref_lat,v_ref_lng,
        round(v_distance::numeric,2),p_accuracy,'outlier',
        coalesce(nullif(trim(p_exception_reason),''),'Repeat delivery position differs by more than 20 metres from the temporary customer-location cluster'))
      on conflict(booking_key) do nothing returning id into v_exception_id;
    else
      v_count := v_temp.confirmation_count + 1;
      v_new_lat := ((v_temp.lat * v_temp.confirmation_count) + p_lat) / v_count;
      v_new_lng := ((v_temp.lng * v_temp.confirmation_count) + p_lng) / v_count;
      v_result := case when v_count >= 3 then 'temporary_approved' when v_count >= 2 then 'provisional' else 'candidate' end;
      update public.lpg_gps_temporary set lat=v_new_lat,lng=v_new_lng,
        best_accuracy_m=least(best_accuracy_m,p_accuracy),confirmation_count=v_count,
        status=v_result,last_confirmed_at=p_captured_at,last_delivery_man=p_delivery_man,updated_at=now()
        where consumer_no=p_consumer_no returning * into v_temp;
    end if;
  end if;

  update public.lpg_delivery_location_observations
    set result=v_result,reference_distance_m=case when v_distance is null then null else round(v_distance::numeric,2) end,
        temporary_confirmation_count=coalesce(v_temp.confirmation_count,1)
    where id=v_id;

  return jsonb_build_object('result',v_result,'distance_m',case when v_distance is null then null else round(v_distance::numeric,2) end,
    'exception_id',v_exception_id,'temporary_confirmation_count',coalesce(v_temp.confirmation_count,1),
    'temporary_lat',v_temp.lat,'temporary_lng',v_temp.lng);
end;
$$;

revoke all on function public.record_lpg_delivery_location_observation(text,text,text,double precision,double precision,double precision,timestamptz,text) from public, anon, authenticated;
grant execute on function public.record_lpg_delivery_location_observation(text,text,text,double precision,double precision,double precision,timestamptz,text) to service_role;
