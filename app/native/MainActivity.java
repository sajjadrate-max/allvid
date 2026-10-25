package com.sajjadrate.videodl;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String HOME = "https://allvid.org/";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DownloaderPlugin.class);
        super.onCreate(savedInstanceState);
        // Back button: step back inside the app (open sheet, My files, a page like Privacy);
        // with nothing to go back to on another page, go to the home page; only home closes the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() == null ? null : getBridge().getWebView();
                if (wv != null && wv.canGoBack()) {
                    wv.goBack();
                    return;
                }
                String url = wv == null ? null : wv.getUrl();
                if (wv != null && url != null && !url.matches("https://allvid\\.org/?(index\\.html)?([?#].*)?")) {
                    wv.loadUrl(HOME);
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
