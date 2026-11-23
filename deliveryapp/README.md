# Samruddhi DeliveryApp — public static PWA

Live URL: https://samruddhigas.github.io/locate/deliveryapp/

This folder holds only the public frontend assets for the installable delivery app. The working source and backend implementation are maintained in the private repository `samruddhigas/SAMRUDDHI-DELIVERY-APP`.

The existing LocationCapture page at the repository root has not been changed.

The frontend has no service-role key, database password, delivery PIN or saved user session. Delivery login, session validation, role checks and assigned-booking filtering are enforced by the Supabase `lpg-api` backend.

Important: the app's “Mark delivered (local only)” action is local phone progress, not an official HPCL delivery record. Official delivery confirmation remains in the HPCL workflow.
