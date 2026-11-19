package nl.stuiver.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String t = i.getStringExtra("title"), b = i.getStringExtra("body");
        if (t == null) return;
        Notify.show(c, i.getIntExtra("id", 1), t, b == null ? "" : b);
    }
}
