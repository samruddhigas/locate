# Samruddhi Native Android DeliveryApp

This is an Android WebView shell for the existing DeliveryApp. It keeps the current authenticated web workflow and adds a native Android location source.

## Location method

- First requests Google Play services `FusedLocationProviderClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, ...)`.
- If the fused fix is missing or weaker than 10 m, also listens to Android `GPS_PROVIDER` and `NETWORK_PROVIDER` for up to 20 seconds, retaining the best fresh positive-accuracy fix.
- Browser geolocation is no longer a prerequisite for the native bridge; the DeliveryApp can request native location even if the browser geolocation API is absent or denied.
- Requests Android fine/precise location permission.
- Returns latitude, longitude, reported accuracy and timestamp to the web app through a restricted JavaScript bridge.
- The web app combines the native fix with browser `watchPosition` and `getCurrentPosition` readings.
- The existing 1–30 m validation remains in force. The native provider does not bypass a poor accuracy estimate or fabricate a coordinate.
- No Google Maps API key or Supabase secret is embedded in this Android project. The app loads the existing HTTPS DeliveryApp URL and uses its existing login/session flow.

## Build

GitHub Actions workflow: `.github/workflows/build-native-delivery-android.yml`

The workflow builds a debug APK and uploads it as an Actions artifact. The APK is not considered production-ready until the workflow succeeds and the app is installed and tested on a physical Android phone.

## Important limitations

- Fine/precise Android location permission must be granted. If the device is set to approximate location only, the system cannot promise a 30 m fix.
- Google Play services must be available and functioning.
- This is a first native bridge build; real-device permission, GPS, WebView, offline and delivery-completion tests are still required.
- Do not distribute the APK as production until those tests pass.
