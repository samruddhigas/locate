# Samruddhi LPG Office Dashboard

This folder contains the hosted office Dashboard for Samruddhi Gas Agency.

- Live page: https://samruddhigas.github.io/locate/dashboard/
- Source file: index.html
- Backend: the NEW Samruddhi Supabase project through the authenticated `lpg-api` Edge Function.

## Updating the Dashboard

Update `dashboard/index.html` on the `main` branch. GitHub Pages republishes the site automatically when the repository's Pages source is configured to deploy the `main` branch. Office users can then refresh the page to load the newest version.

## Security

The page is public static HTML. It must never contain a Supabase service-role key, `SESSION_SECRET`, `ADMIN_RESET_SECRET`, database password, or other server-side credential. Data operations must continue through the authenticated Edge Function. Users must sign in with their own Dashboard account.

Do not overwrite the repository-root `index.html`; that file belongs to the consumer LocationCapture application.
