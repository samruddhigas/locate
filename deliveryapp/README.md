# Samruddhi DeliveryApp — public static PWA

**App URL:** https://samruddhigas.github.io/locate/deliveryapp/

This folder holds the public frontend for the DeliveryApp. Main application source and backend code are in the private repository `samruddhigas/SAMRUDDHI-DELIVERY-APP`.

The root LocationCapture page in this repository has not been modified.

The frontend contains the Supabase publishable key only; it does not contain a service-role key, database password, delivery PIN, or logged-in session token. PIN authentication, session validation, role checks, assigned-booking filtering, and GPS assignment checks are handled by the Supabase Edge Function.

Important: the app's **“Done on this phone”** action stores local progress only. It does not create an official HPCL delivered record. Official delivery confirmation continues through the HPCL workflow/import.

Offline support covers the app shell and locally saved progress; bookings are refreshed from the server and GPS upload requires internet.
