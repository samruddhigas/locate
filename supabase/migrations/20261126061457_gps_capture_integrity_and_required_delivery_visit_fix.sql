-- GPS integrity hardening. Existing completion rows are preserved; only new
-- delivery completion inserts/changes must include a valid visit-specific GPS fix.

alter table public.lpg_gps_history
  drop constraint if exists lpg_gps_history_acc_nonnegative;
alter table public.lpg_gps_history
  add constraint lpg_gps_history_acc_positive
  check (acc > 0 and acc <= 30);

alter table public.lpg_gps
  add constraint lpg_gps_accuracy_positive
  check (acc is null or (acc > 0 and acc <= 30));

alter table public.lpg_delivery_location_observations
  drop constraint if exists lpg_delivery_location_observations_accuracy_m_check;
alter table public.lpg_delivery_location_observations
  add constraint lpg_delivery_location_observations_accuracy_positive
  check (accuracy_m > 0 and accuracy_m <= 30);

alter table public.lpg_gps_temporary
  drop constraint if exists lpg_gps_temporary_best_accuracy_m_check;
alter table public.lpg_gps_temporary
  add constraint lpg_gps_temporary_best_accuracy_positive
  check (best_accuracy_m > 0 and best_accuracy_m <= 30);

alter table public.lpg_delivery_completions
  drop constraint if exists lpg_delivery_completions_gps_accuracy_check;
alter table public.lpg_delivery_completions
  add constraint lpg_delivery_completions_gps_accuracy_check
  check (gps_accuracy is null or (gps_accuracy > 0 and gps_accuracy <= 30));

create or replace function public.enforce_delivery_completion_visit_gps()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.gps_captured_at is null
     or new.gps_lat is null or new.gps_lat not between -90 and 90
     or new.gps_lng is null or new.gps_lng not between -180 and 180
     or new.gps_accuracy is null or new.gps_accuracy <= 0 or new.gps_accuracy > 30
     or new.gps_captured_at < new.completed_at - interval '30 minutes'
     or new.gps_captured_at > new.completed_at + interval '5 minutes' then
    raise exception 'A fresh visit GPS fix with 1–30 metre accuracy is required to complete a delivery';
  end if;
  return new;
end;
$$;

drop trigger if exists lpg_delivery_completion_require_visit_gps
  on public.lpg_delivery_completions;
create trigger lpg_delivery_completion_require_visit_gps
before insert or update of gps_captured_at, gps_lat, gps_lng, gps_accuracy, completed_at
on public.lpg_delivery_completions
for each row execute function public.enforce_delivery_completion_visit_gps();
