package asia.plugsure.liveupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The payload built by src/native/liveSession.ts (`liveUpdatePayload` / `handleLiveSessionData`). */
class LiveUpdatePayload : Record {
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var shortText: String? = null
  @Field var progress: Int = 0
  @Field var progressMax: Int = 100
  @Field var indeterminate: Boolean = false
  @Field var ongoing: Boolean = true
  @Field var url: String = ""
}

/**
 * One ongoing notification per charge (`ref`): on Android 16 (API 36) a Live Update — `Notification.ProgressStyle`
 * with a status-bar chip (`shortCriticalText`) and `requestPromotedOngoing` (needs POST_PROMOTED_NOTIFICATIONS,
 * added by plugins/withAndroidLiveSession); before Android 16 a standard progress notification. Tapping opens the
 * session screen (`url`, the app's scheme). Channel `live-session` (low importance: no sound on every update).
 */
class PlugSureLiveUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("PlugSureLiveUpdate")

    Function("isSupported") { true }
    Function("isProgressStyle") { Build.VERSION.SDK_INT >= 36 }

    Function("show") { ref: String, payload: LiveUpdatePayload ->
      show(ref, payload)
    }

    Function("end") { ref: String ->
      NotificationManagerCompat.from(context).cancel(TAG, idFor(ref))
    }
  }

  private fun idFor(ref: String) = BASE_ID + (ref.hashCode() and 0xffff)

  private fun ensureChannel(nm: NotificationManager) {
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Live charging session", NotificationManager.IMPORTANCE_LOW).apply {
        setShowBadge(false)
        enableVibration(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      })
    }
  }

  private fun smallIcon(): Int {
    val res = context.resources
    val id = res.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  private fun contentIntent(url: String): PendingIntent? {
    if (url.isEmpty()) return null
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, url.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun show(ref: String, p: LiveUpdatePayload) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    ensureChannel(nm)
    val max = if (p.progressMax > 0) p.progressMax else 100
    val progress = p.progress.coerceIn(0, max)
    val notification: Notification = if (Build.VERSION.SDK_INT >= 36) {
      val style = Notification.ProgressStyle()
        .setStyledByProgress(true)
        .setProgressSegments(listOf(Notification.ProgressStyle.Segment(max)))
        .setProgress(progress)
        .setProgressIndeterminate(p.indeterminate)
      Notification.Builder(context, CHANNEL)
        .setSmallIcon(smallIcon())
        .setContentTitle(p.title)
        .setContentText(p.text)
        .setStyle(style)
        .setOngoing(p.ongoing)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_PROGRESS)
        .setRequestPromotedOngoing(p.ongoing)
        .apply { p.shortText?.let { setShortCriticalText(it) } }
        .apply { contentIntent(p.url)?.let { setContentIntent(it) } }
        .build()
    } else {
      NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(smallIcon())
        .setContentTitle(p.title)
        .setContentText(p.text)
        .setProgress(max, progress, p.indeterminate)
        .setOngoing(p.ongoing)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .apply { contentIntent(p.url)?.let { setContentIntent(it) } }
        .build()
    }
    try {
      nm.notify(TAG, idFor(ref), notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS revoked between the check and the call.
    }
  }

  companion object {
    const val CHANNEL = "live-session"
    const val TAG = "plugsure-live"
    const val BASE_ID = 0x5100000
  }
}
