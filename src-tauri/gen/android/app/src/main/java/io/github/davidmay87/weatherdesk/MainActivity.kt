package io.github.davidmay87.weatherdesk

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // This app is a wall clock as much as a dashboard: a screen that sleeps after a minute is
    // no use on a shelf. The flag is scoped to this window, so it lapses the moment the app is
    // backgrounded — no wake lock to leak and no permission to ask for.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    super.onCreate(savedInstanceState)
  }
}
