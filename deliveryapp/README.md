# Samruddhi DeliveryApp static release

This folder is the public, static PWA build served from the existing GitHub Pages site. The main working source and backend code are maintained in the private repository `samruddhigas/SAMRUDDHI-DELIVERY-APP`.

App URL: https://samruddhigas.github.io/locate/deliveryapp/

Only public frontend assets are stored here. The Supabase publishable key is intended for browser use; no service-role key, database password, delivery PIN, or user session token is stored in this folder. User authentication, role enforcement, assigned-booking filtering, and GPS authorization are handled by the Supabase Edge Function.
