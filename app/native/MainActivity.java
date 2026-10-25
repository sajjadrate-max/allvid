package com.sajjadrate.videodl;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String HOME = "https://allvid.org/#youtube";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DownloaderPlugin.class);
        super.onCreate(savedInstanceState);
        // Back button: from anywhere in the app, back returns to the YouTube home screen;
        // only from there does it close the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final WebView wv = getBridge() == null ? null : getBridge().getWebView();
                if (wv == null) { leave(); return; }
                // The page decides: anything open or another tab -> YouTube home ("true");
                // already there -> leave ("false"); another page (Privacy, articles...) -> home.
                wv.evaluateJavascript("window.allvidBack?String(window.allvidBack()):'none'", r -> {
                    String v = r == null ? "" : r.replace("\"", "");
                    if (v.equals("true")) return;
                    if (v.equals("false")) { leave(); return; }
                    wv.loadUrl(HOME);
                });
            }

            private void leave() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
