# Samruddhi LPG Office Dashboard

- Hosted Dashboard: https://samruddhigas.github.io/locate/dashboard/
- Dashboard source: `dashboard/index.html`
- Secure consumer GPS capture: https://samruddhigas.github.io/locate/consumer-location/
- Consumer capture source: `consumer-location/index.html`
- Backend: NEW Samruddhi Supabase project, authenticated through `lpg-api`.

## Publishing updates

Commit an updated `dashboard/index.html` to the `main` branch. GitHub Pages publishes branch changes automatically when Pages is configured to deploy this repository. Office users then refresh the page or reopen it to load the published version.

Changes to the secure WhatsApp consumer GPS capture page belong in `consumer-location/index.html`.

## Security

This is a public static website. The HTML source is publicly viewable. It must never contain a Supabase service-role key, `SESSION_SECRET`, `ADMIN_RESET_SECRET`, database password, or other server-side credential. Use only the public publishable/anon key in the browser. Authenticated office operations must continue through the custom session token validated by the `lpg-api` Edge Function.

The root `index.html` is the existing legacy LocationCapture page; do not overwrite it when updating the Dashboard or secure consumer capture page.
