-- Reconcile the live optional-GPS delivery completion migration with source control.
-- Delivery completion remains valid when the phone cannot obtain a usable fix;
-- a supplied GPS accuracy must be within 30 metres.

alter table public.lpg_delivery_completions
  alter column gps_captured_at drop not null,
  alter column gps_lat drop not null,
  alter column gps_lng drop not null,
  alter column gps_accuracy drop not null;

alter table public.lpg_delivery_completions
  drop constraint if exists lpg_delivery_completions_gps_accuracy_check;

alter table public.lpg_delivery_completions
  add constraint lpg_delivery_completions_gps_accuracy_check
  check (gps_accuracy is null or (gps_accuracy >= 0 and gps_accuracy <= 30));
