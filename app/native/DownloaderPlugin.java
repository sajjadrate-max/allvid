package com.sajjadrate.videodl;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Iterator;

/**
 * Hands downloads to Android's DownloadManager (notification with progress, file in
 * Downloads/VideoDownloader) and passes links shared to the app ("Share" -> this app).
 */
@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {

    private DownloadManager manager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("name", "video.mp4");
        if (url == null || url.isEmpty()) {
            call.reject("no url");
            return;
        }
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            JSObject headers = call.getObject("headers", new JSObject());
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                req.addRequestHeader(k, headers.getString(k));
            }
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "VideoDownloader/" + name);
            long id = manager().enqueue(req);
            JSObject ret = new JSObject();
            ret.put("id", id);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        long id = call.getData().optLong("id", -1L);
        JSObject o = new JSObject();
        Cursor c = null;
        try {
            c = manager().query(new DownloadManager.Query().setFilterById(id));
            if (c != null && c.moveToFirst()) {
                int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                String s = st == DownloadManager.STATUS_SUCCESSFUL ? "done"
                        : st == DownloadManager.STATUS_FAILED ? "failed"
                        : st == DownloadManager.STATUS_PAUSED ? "paused"
                        : st == DownloadManager.STATUS_PENDING ? "pending" : "running";
                o.put("status", s);
                o.put("got", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
                o.put("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
                o.put("reason", c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)));
                String uri = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                o.put("uri", uri == null ? "" : uri);
            } else {
                o.put("status", "missing");
            }
        } catch (Exception e) {
            o.put("status", "missing");
        } finally {
            if (c != null) c.close();
        }
        call.resolve(o);
    }

    /** Text shared into the app when it was opened from the share sheet. */
    @PluginMethod
    public void getShared(PluginCall call) {
        Intent intent = getActivity().getIntent();
        String text = sharedText(intent);
        if (text != null) intent.removeExtra(Intent.EXTRA_TEXT);
        JSObject o = new JSObject();
        o.put("text", text == null ? "" : text);
        call.resolve(o);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = sharedText(intent);
        if (text != null) {
            JSObject o = new JSObject();
            o.put("text", text);
            notifyListeners("shared", o, true);
        }
    }

    private static String sharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        return intent.getStringExtra(Intent.EXTRA_TEXT);
    }
}
