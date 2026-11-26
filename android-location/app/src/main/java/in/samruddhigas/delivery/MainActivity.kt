package in.samruddhigas.delivery

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.location.Location
import android.os.Bundle
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
        if (!fine) ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), permissionRequest)
    }

    inner class NativeLocationBridge {
        @JavascriptInterface
        fun getCurrentLocation(callbackId: String) {
            runOnUiThread {
                if (callbackId.isBlank() || callbackId.length > 100) return@runOnUiThread
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

    private fun fetchFusedLocation(callbackId: String) {
        val client = LocationServices.getFusedLocationProviderClient(this)
        val cancellation = CancellationTokenSource()
        client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancellation.token)
            .addOnSuccessListener { location ->
                if (location == null) sendGpsError(callbackId, "Android fused location returned no fix")
                else if (System.currentTimeMillis() - location.time > 10_000) sendGpsError(callbackId, "Android location fix is older than 10 seconds")
                else sendGps(callbackId, location)
            }
            .addOnFailureListener { sendGpsError(callbackId, it.message ?: "Android fused location failed") }
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
