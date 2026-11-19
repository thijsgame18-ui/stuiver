package nl.stuiver.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.pm.PackageInstaller;
import java.io.FileInputStream;
import java.io.InputStream;
import android.database.Cursor;
import java.io.File;
import android.app.KeyguardManager;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.os.Build;
import java.io.OutputStream;
import android.view.WindowManager;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import android.util.Base64;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final int FILE_REQ = 42;
    private static final int AUTH_REQ = 43;
    private static final int SAVE_REQ = 44;
    private String pendingSave;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private String pendingUpdate;
    static MainActivity current;
    void updateFailed(final String m) { js("window.onUpdateStatus&&window.onUpdateStatus('error',0)"); }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = this;
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        w.setStatusBarColor(Color.parseColor("#F6F1E9"));
        w.setNavigationBarColor(Color.parseColor("#FFFDF9"));
        w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        Notify.channel(this);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F6F1E9"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setSaveFormData(false);
        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("file".equals(u.getScheme())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    Intent i = p.createIntent();
                    if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(i, FILE_REQ);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(code, null); } });
    }

    @Override
    protected void onPause() { super.onPause(); js("window.appPause&&window.appPause()"); }

    @Override
    protected void onResume() { super.onResume(); js("window.appResume&&window.appResume()");
        if (pendingUpdate != null && Build.VERSION.SDK_INT >= 26 && getPackageManager().canRequestPackageInstalls()) { String u = pendingUpdate; pendingUpdate = null; startUpdate(u); }
        else if (pendingUpdate != null) { pendingUpdate = null; js("window.onUpdateStatus&&window.onUpdateStatus('noperm',0)"); }
    }

    private void installSession(File f) throws Exception {
        PackageInstaller pi = getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setAppPackageName(getPackageName());
        if (Build.VERSION.SDK_INT >= 31) {
            try { p.getClass().getMethod("setRequireUserAction", int.class).invoke(p, 2); } catch (Exception e) { }
        }
        int sid = pi.createSession(p);
        PackageInstaller.Session s = pi.openSession(sid);
        InputStream in = new FileInputStream(f);
        OutputStream out = s.openWrite("stuiver.apk", 0, f.length());
        byte[] buf = new byte[65536]; int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        s.fsync(out); in.close(); out.close();
        Intent i = new Intent(this, InstallReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 0x02000000 : 0);
        PendingIntent pend = PendingIntent.getBroadcast(this, sid, i, flags);
        s.commit(pend.getIntentSender());
        s.close();
    }

    private void startUpdate(final String url) {
        try {
            final DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            File dir = getExternalFilesDir(null);
            File old = new File(dir, "Stuiver-update.apk"); if (old.exists()) old.delete();
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle("Stuiver update");
            r.setMimeType("application/vnd.android.package-archive");
            r.setDestinationInExternalFilesDir(this, null, "Stuiver-update.apk");
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            final long id = dm.enqueue(r);
            js("window.onUpdateStatus&&window.onUpdateStatus('download',0)");
            new Thread(new Runnable() { public void run() {
                for (int n = 0; n < 1200; n++) {
                    try { Thread.sleep(400); } catch (Exception e) { }
                    Cursor c = dm.query(new DownloadManager.Query().setFilterById(id));
                    if (c == null || !c.moveToFirst()) { if (c != null) c.close(); js("window.onUpdateStatus&&window.onUpdateStatus('error',0)"); return; }
                    int st = c.getInt(c.getColumnIndex(DownloadManager.COLUMN_STATUS));
                    long done = c.getLong(c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    long tot = c.getLong(c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    c.close();
                    if (st == DownloadManager.STATUS_SUCCESSFUL) {
                        js("window.onUpdateStatus&&window.onUpdateStatus('install',100)");
                        try { installSession(new File(getExternalFilesDir(null), "Stuiver-update.apk")); }
                        catch (Exception e) {
                            final Uri u = dm.getUriForDownloadedFile(id);
                            runOnUiThread(new Runnable() { public void run() {
                                try {
                                    Intent i = new Intent(Intent.ACTION_VIEW);
                                    i.setDataAndType(u, "application/vnd.android.package-archive");
                                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                                    startActivity(i);
                                } catch (Exception e2) { js("window.onUpdateStatus&&window.onUpdateStatus('error',0)"); }
                            }});
                        }
                        return;
                    }
                    if (st == DownloadManager.STATUS_FAILED) { js("window.onUpdateStatus&&window.onUpdateStatus('error',0)"); return; }
                    int pct = tot > 0 ? (int) (done * 100 / tot) : 0;
                    js("window.onUpdateStatus&&window.onUpdateStatus('download'," + pct + ")");
                }
            }}).start();
        } catch (Exception e) { js("window.onUpdateStatus&&window.onUpdateStatus('error',0)"); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == SAVE_REQ) {
            boolean ok = false;
            if (res == RESULT_OK && data != null && data.getData() != null && pendingSave != null) {
                try { OutputStream os = getContentResolver().openOutputStream(data.getData()); os.write(pendingSave.getBytes("UTF-8")); os.close(); ok = true; } catch (Exception e) { }
            }
            pendingSave = null;
            js("window.onFileSaved&&window.onFileSaved(" + ok + ")");
            return;
        }
        if (req == AUTH_REQ) { js("window.onDeviceAuth&&window.onDeviceAuth(" + (res == RESULT_OK) + ")"); return; }
        if (req == FILE_REQ && fileCb != null) {
            Uri[] result = null;
            if (res == RESULT_OK && data != null) {
                ClipData cd = data.getClipData();
                if (cd != null) {
                    result = new Uri[cd.getItemCount()];
                    for (int i = 0; i < cd.getItemCount(); i++) result[i] = cd.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{ data.getData() };
                }
            }
            fileCb.onReceiveValue(result);
            fileCb = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.appBack&&window.appBack())?'1':'0'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (v != null && v.contains("1")) return;
                if (web.canGoBack()) web.goBack();
                else superBack();
            }
        });
    }

    private void superBack() { super.onBackPressed(); }

    class Bridge {
        @JavascriptInterface
        public int versionCode() { try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; } catch (Exception e) { return 0; } }

        @JavascriptInterface
        public void installUpdate(final String url) {
            runOnUiThread(new Runnable() { public void run() {
                if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                    pendingUpdate = url;
                    try { startActivity(new Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES", Uri.parse("package:" + getPackageName()))); }
                    catch (Exception e) { pendingUpdate = null; startUpdate(url); return; }
                    js("window.onUpdateStatus&&window.onUpdateStatus('perm',0)");
                    return;
                }
                startUpdate(url);
            }});
        }

        @JavascriptInterface
        public void notify(int id, String title, String body) { Notify.show(MainActivity.this, id, title, body); }

        @JavascriptInterface
        public void schedule(int id, long at, String title, String body) {
            Intent i = new Intent(MainActivity.this, ReminderReceiver.class);
            i.putExtra("id", id); i.putExtra("title", title); i.putExtra("body", body);
            PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this, id, i, PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000);
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (am != null) am.set(AlarmManager.RTC_WAKEUP, at, pi);
        }

        @JavascriptInterface
        public void cancel(int id) {
            Intent i = new Intent(MainActivity.this, ReminderReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this, id, i, PendingIntent.FLAG_NO_CREATE | 0x04000000);
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (am != null && pi != null) { am.cancel(pi); pi.cancel(); }
        }

        @JavascriptInterface
        public void requestNotifPermission() {
            if (Build.VERSION.SDK_INT >= 33) {
                runOnUiThread(new Runnable() { public void run() { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 7); } });
            }
        }

        @JavascriptInterface
        public void saveFile(final String name, final String content) {
            runOnUiThread(new Runnable() { public void run() {
                pendingSave = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, SAVE_REQ); } catch (Exception e) { pendingSave = null; js("window.onFileSaved&&window.onFileSaved(false)"); }
            }});
        }

        @JavascriptInterface
        public void setSecure(final boolean on) {
            runOnUiThread(new Runnable() { public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }});
        }

        @JavascriptInterface
        public boolean deviceSecure() {
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            return km != null && km.isDeviceSecure();
        }

        @JavascriptInterface
        public void deviceAuth() {
            runOnUiThread(new Runnable() { public void run() {
                KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
                Intent i = km == null ? null : km.createConfirmDeviceCredentialIntent("Stuiver ontgrendelen", "Gebruik je vingerafdruk, gezicht of de pincode van je telefoon");
                if (i == null) { js("window.onDeviceAuth&&window.onDeviceAuth(false)"); return; }
                startActivityForResult(i, AUTH_REQ);
            }});
        }

        @JavascriptInterface
        public String hash(String pin, String salt) {
            try {
                PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt.getBytes("UTF-8"), 120000, 256);
                byte[] h = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(spec).getEncoded();
                return Base64.encodeToString(h, Base64.NO_WRAP);
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public String randomSalt() {
            byte[] b = new byte[16];
            new java.security.SecureRandom().nextBytes(b);
            return Base64.encodeToString(b, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void copy(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("Stuiver", text));
        }
    }
}
