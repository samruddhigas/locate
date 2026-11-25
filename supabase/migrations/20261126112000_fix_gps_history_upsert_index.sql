-- Replace the earlier partial index with a full unique index so PostgREST
-- upsert(onConflict: booking_key,consumer_no) can infer the constraint.
-- NULL booking keys remain non-conflicting under PostgreSQL unique-index semantics.
drop index if exists public.lpg_gps_history_booking_consumer_uidx;
create unique index lpg_gps_history_booking_consumer_uidx
  on public.lpg_gps_history (booking_key, consumer_no);
