package in.samruddhigas.delivery

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var pendingCallback: String? = null
    private var permissionInFlight = false
    private val permissionRequest = 7001
    private val appUrl = "https://samruddhigas.github.io/locate/deliveryapp/"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        web.settings.setGeolocationEnabled(true)
        web.settings.allowFileAccess = false
        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                val granted = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                callback.invoke(origin, granted, false)
            }
        }
        web.addJavascriptInterface(NativeLocationBridge(), "AndroidLocation")
        setContentView(web)
        web.loadUrl(appUrl)
        requestFineLocationIfNeeded()
    }

    private fun requestFineLocationIfNeeded() {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !permissionInFlight) { permissionInFlight = true; ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), permissionRequest) }
    }

    inner class NativeLocationBridge {
        @JavascriptInterface
        fun getCurrentLocation(callbackId: String) {
            runOnUiThread {
                if (!callbackId.matches(Regex("[A-Za-z0-9_-]{1,100}"))) return@runOnUiThread
                val fine = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                if (!fine) {
                    pendingCallback = callbackId
                    requestFineLocationIfNeeded()
                    return@runOnUiThread
                }
                fetchFusedLocation(callbackId)
            }
        }
    }

    private fun isFreshLocation(location: Location): Boolean {
        val age = System.currentTimeMillis() - location.time
        return location.latitude.isFinite() && location.longitude.isFinite() &&
            location.latitude in -90.0..90.0 && location.longitude in -180.0..180.0 &&
            location.accuracy.isFinite() && location.accuracy > 0f &&
            age >= -5_000 && age <= 10_000
    }

    private fun fetchFusedLocation(callbackId: String) {
        val client = LocationServices.getFusedLocationProviderClient(this)
        val cancellation = CancellationTokenSource()
        client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancellation.token)
            .addOnSuccessListener { location ->
                if (location != null && isFreshLocation(location) && location.accuracy <= 10f) {
                    sendGps(callbackId, location)
                } else {
                    fetchPlatformLocation(callbackId, location?.takeIf { isFreshLocation(it) })
                }
            }
            .addOnFailureListener { fetchPlatformLocation(callbackId, null) }
    }

    @SuppressLint("MissingPermission")
    private fun fetchPlatformLocation(callbackId: String, initial: Location?) {
        val manager = getSystemService(LOCATION_SERVICE) as LocationManager
        val handler = Handler(Looper.getMainLooper())
        val startedAt = System.currentTimeMillis()
        var best: Location? = initial
        var finished = false

        lateinit var listener: LocationListener
        val timeout = Runnable { finish() }
        fun finish() {
            if (finished) return
            finished = true
            try { manager.removeUpdates(listener) } catch (_: Exception) { }
            handler.removeCallbacks(timeout)
            val result = best
            if (result != null && isFreshLocation(result)) sendGps(callbackId, result)
            else sendGpsError(callbackId, "Android GPS and network providers returned no fresh location")
        }

        listener = LocationListener { location ->
            if (!finished && isFreshLocation(location) &&
                (best == null || location.accuracy < best!!.accuracy)) best = location
            val candidate = best
            if (!finished && candidate != null && candidate.accuracy <= 10f &&
                System.currentTimeMillis() - startedAt >= 5_000) finish()
        }

        var requested = false
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (manager.isProviderEnabled(provider)) {
                    manager.requestLocationUpdates(provider, 1_000L, 0f, listener, Looper.getMainLooper())
                    requested = true
                }
            } catch (_: Exception) { }
        }
        if (!requested) { finish(); return }
        handler.postDelayed(timeout, 20_000L)
    }

    private fun sendGps(callbackId: String, location: Location) {
        val js = "window.__nativeGpsCallbacks&&window.__nativeGpsCallbacks['" + callbackId + "']&&window.__nativeGpsCallbacks['" + callbackId + "'](" + location.latitude + "," + location.longitude + "," + location.accuracy + "," + location.time + ",null);"
        web.post { web.evaluateJavascript(js, null) }
    }

    private fun sendGpsError(callbackId: String, message: String) {
        val safe = message.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")
        val js = "window.__nativeGpsCallbacks&&window.__nativeGpsCallbacks['" + callbackId + "']&&window.__nativeGpsCallbacks['" + callbackId + "'](null,null,0,Date.now(),'" + safe + "');"
        web.post { web.evaluateJavascript(js, null) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == permissionRequest) {
            permissionInFlight = false
            val callback = pendingCallback
            pendingCallback = null
            if (callback != null) {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) fetchFusedLocation(callback)
                else sendGpsError(callback, "Precise location permission was denied in Android")
            }
        }
    }

    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
