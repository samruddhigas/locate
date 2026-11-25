-- Make queued delivery GPS captures durable and idempotent.
-- A delayed sync keeps the original device-fix timestamp so delivery completion
-- can still associate the reading with the actual visit (up to the 48-hour queue window).
alter table public.lpg_gps_history
  add column if not exists booking_key text;

create unique index if not exists lpg_gps_history_booking_consumer_uidx
  on public.lpg_gps_history (booking_key, consumer_no)
  ;

