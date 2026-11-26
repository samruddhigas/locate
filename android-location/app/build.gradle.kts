plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "in.samruddhigas.delivery"
    compileSdk = 35
    defaultConfig {
        applicationId = "in.samruddhigas.delivery"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }
}
dependencies {
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
