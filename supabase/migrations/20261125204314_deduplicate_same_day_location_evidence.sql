alter table public.lpg_delivery_location_observations drop constraint if exists lpg_delivery_location_observations_result_check;
alter table public.lpg_delivery_location_observations add constraint lpg_delivery_location_observations_result_check check (result in ('candidate','provisional','temporary_approved','matched_approved','nearby_warning','deviation','outlier_review','low_confidence','same_day_repeat'));

CREATE OR REPLACE FUNCTION public.record_lpg_delivery_location_observation(p_booking_key text, p_consumer_no text, p_delivery_man text, p_lat double precision, p_lng double precision, p_accuracy double precision, p_captured_at timestamp with time zone, p_exception_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid; v_existing public.lpg_gps%rowtype; v_temp public.lpg_gps_temporary%rowtype;
  v_ref_lat double precision; v_ref_lng double precision; v_distance double precision;
  v_result text; v_count integer; v_exception_id uuid; v_new_lat double precision; v_new_lng double precision;
begin
  if coalesce(length(trim(p_booking_key)),0)=0 or coalesce(length(trim(p_consumer_no)),0)=0
     or coalesce(length(trim(p_delivery_man)),0)=0
     or p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or p_accuracy is null or p_accuracy<0 or p_accuracy>30
     or p_captured_at is null or p_captured_at>now()+interval '5 minutes'
     or p_captured_at<now()-interval '2 hours' then
    raise exception 'Invalid or stale delivery location observation';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_consumer_no));
  insert into public.lpg_delivery_location_observations
    (booking_key,consumer_no,delivery_man,lat,lng,accuracy_m,captured_at,result)
  values(p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,p_accuracy,p_captured_at,'candidate')
  on conflict(booking_key) do nothing returning id into v_id;

  if v_id is null then
    return (select jsonb_build_object('duplicate',true,'result',result,'distance_m',reference_distance_m,
      'temporary_confirmation_count',temporary_confirmation_count)
      from public.lpg_delivery_location_observations where booking_key=p_booking_key);
  end if;

  -- A permanent office-approved pin always wins; visit readings never overwrite it.
  select * into v_existing from public.lpg_gps where consumer_no=p_consumer_no and status='approved';
  if found then
    v_ref_lat:=coalesce(v_existing.pin_lat,v_existing.lat); v_ref_lng:=coalesce(v_existing.pin_lng,v_existing.lng);
    v_distance:=6371000*2*asin(sqrt(power(sin(radians(p_lat-v_ref_lat)/2),2)+
      cos(radians(v_ref_lat))*cos(radians(p_lat))*power(sin(radians(p_lng-v_ref_lng)/2),2)));
    if v_distance<=30 then v_result:='matched_approved';
    elsif v_distance<=50 then v_result:='nearby_warning';
    else v_result:='deviation'; end if;
    update public.lpg_delivery_location_observations set result=v_result,reference_distance_m=round(v_distance::numeric,2) where id=v_id;
    if v_result in ('nearby_warning','deviation') then
      insert into public.lpg_delivery_location_exceptions
        (booking_key,consumer_no,delivery_man,observed_lat,observed_lng,reference_lat,reference_lng,distance_m,accuracy_m,severity,reason)
      values(p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,v_ref_lat,v_ref_lng,round(v_distance::numeric,2),p_accuracy,
        case when v_result='deviation' then 'deviation' else 'warning' end,
        coalesce(nullif(trim(p_exception_reason),''),case when v_result='deviation'
          then 'Delivery recorded more than 50 metres from the approved customer pin'
          else 'Delivery recorded 30–50 metres from the approved customer pin' end))
      on conflict(booking_key) do update set distance_m=excluded.distance_m returning id into v_exception_id;
    end if;
    return jsonb_build_object('result',v_result,'distance_m',round(v_distance::numeric,2),'exception_id',v_exception_id,
      'temporary_confirmation_count',null);
  end if;

  -- Only one physical visit per local day may count toward the 2/3-visit threshold.
  if exists(select 1 from public.lpg_delivery_location_observations o
    where o.consumer_no=p_consumer_no and o.id<>v_id
      and (o.captured_at at time zone 'Asia/Kolkata')::date=(p_captured_at at time zone 'Asia/Kolkata')::date) then
    select * into v_temp from public.lpg_gps_temporary where consumer_no=p_consumer_no for update;
    v_result:='same_day_repeat';
    if found then
      v_ref_lat:=v_temp.lat; v_ref_lng:=v_temp.lng;
      v_distance:=6371000*2*asin(sqrt(power(sin(radians(p_lat-v_ref_lat)/2),2)+
        cos(radians(v_ref_lat))*cos(radians(p_lat))*power(sin(radians(p_lng-v_ref_lng)/2),2)));
      if v_distance>20 then
        v_result:='outlier_review';
        insert into public.lpg_delivery_location_exceptions
          (booking_key,consumer_no,delivery_man,observed_lat,observed_lng,reference_lat,reference_lng,distance_m,accuracy_m,severity,reason)
        values(p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,v_ref_lat,v_ref_lng,round(v_distance::numeric,2),p_accuracy,'outlier',
          coalesce(nullif(trim(p_exception_reason),''),'Same-day delivery position differs by more than 20 metres from the temporary location cluster'))
        on conflict(booking_key) do nothing returning id into v_exception_id;
      end if;
    end if;
    update public.lpg_delivery_location_observations set result=v_result,
      reference_distance_m=case when v_distance is null then null else round(v_distance::numeric,2) end,
      temporary_confirmation_count=coalesce(v_temp.confirmation_count,0) where id=v_id;
    return jsonb_build_object('result',v_result,'distance_m',case when v_distance is null then null else round(v_distance::numeric,2) end,
      'exception_id',v_exception_id,'temporary_confirmation_count',coalesce(v_temp.confirmation_count,0));
  end if;

  select * into v_temp from public.lpg_gps_temporary where consumer_no=p_consumer_no for update;
  if not found then
    insert into public.lpg_gps_temporary(consumer_no,lat,lng,best_accuracy_m,confirmation_count,status,last_delivery_man)
      values(p_consumer_no,p_lat,p_lng,p_accuracy,1,'candidate',p_delivery_man) returning * into v_temp;
    v_result:='candidate';
  else
    v_ref_lat:=v_temp.lat; v_ref_lng:=v_temp.lng;
    v_distance:=6371000*2*asin(sqrt(power(sin(radians(p_lat-v_ref_lat)/2),2)+
      cos(radians(v_ref_lat))*cos(radians(p_lat))*power(sin(radians(p_lng-v_ref_lng)/2),2)));
    if v_distance>20 then
      v_result:='outlier_review';
      insert into public.lpg_delivery_location_exceptions
        (booking_key,consumer_no,delivery_man,observed_lat,observed_lng,reference_lat,reference_lng,distance_m,accuracy_m,severity,reason)
      values(p_booking_key,p_consumer_no,p_delivery_man,p_lat,p_lng,v_ref_lat,v_ref_lng,round(v_distance::numeric,2),p_accuracy,'outlier',
        coalesce(nullif(trim(p_exception_reason),''),'Repeat delivery position differs by more than 20 metres from the temporary customer-location cluster'))
      on conflict(booking_key) do nothing returning id into v_exception_id;
    else
      v_count:=v_temp.confirmation_count+1;
      v_new_lat:=((v_temp.lat*v_temp.confirmation_count)+p_lat)/v_count;
      v_new_lng:=((v_temp.lng*v_temp.confirmation_count)+p_lng)/v_count;
      v_result:=case when v_count>=3 then 'temporary_approved' when v_count>=2 then 'provisional' else 'candidate' end;
      update public.lpg_gps_temporary set lat=v_new_lat,lng=v_new_lng,best_accuracy_m=least(best_accuracy_m,p_accuracy),
        confirmation_count=v_count,status=v_result,last_confirmed_at=p_captured_at,last_delivery_man=p_delivery_man,updated_at=now()
        where consumer_no=p_consumer_no returning * into v_temp;
    end if;
  end if;

  update public.lpg_delivery_location_observations set result=v_result,
    reference_distance_m=case when v_distance is null then null else round(v_distance::numeric,2) end,
    temporary_confirmation_count=coalesce(v_temp.confirmation_count,1) where id=v_id;
  return jsonb_build_object('result',v_result,'distance_m',case when v_distance is null then null else round(v_distance::numeric,2) end,
    'exception_id',v_exception_id,'temporary_confirmation_count',coalesce(v_temp.confirmation_count,1),
    'temporary_lat',v_temp.lat,'temporary_lng',v_temp.lng);
end;
$function$;

revoke all on function public.record_lpg_delivery_location_observation(text,text,text,double precision,double precision,double precision,timestamptz,text) from public,anon,authenticated;
grant execute on function public.record_lpg_delivery_location_observation(text,text,text,double precision,double precision,double precision,timestamptz,text) to service_role;
