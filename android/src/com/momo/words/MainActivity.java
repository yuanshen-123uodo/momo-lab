package com.momo.words;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

/**
 * 纯本地 WebView 壳：所有请求都从 APK 的 assets 里读，不联网。
 *
 * 用 https://appassets.momo.local/ 这个假域名而不是 file://，
 * 是因为 file:// 下 fetch / IndexedDB / Web Worker 都受同源策略限制，
 * 而 store.js 完全依赖 fetch 读取 data/*.json 分片。
 * 该域名的请求在 shouldInterceptRequest 里被直接接管，不会真的出网，
 * 所以也不存在证书问题。
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.momo.local";
    private static final String BASE = "https://" + HOST + "/";
    private static final String ENTRY = "index.html";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        web.setBackgroundColor(0xFFFDFBF6);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        // 页面里靠 UA 判断"这是原生壳"，跳过 Service Worker 注册
        s.setUserAgentString(s.getUserAgentString() + " MomoNative/1.0");

        web.setWebViewClient(new LocalClient());
        setContentView(web);
        web.loadUrl(BASE + ENTRY);
    }

    private class LocalClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u == null || !HOST.equals(u.getHost())) return null;

            String path = u.getPath();
            if (path == null || path.length() == 0) path = "/" + ENTRY;
            if (path.endsWith("/")) path = path + ENTRY;
            String rel = path.substring(1);

            try {
                InputStream in = getAssets().open(rel);
                return new WebResourceResponse(mimeOf(rel), encodingOf(rel), in);
            } catch (FileNotFoundException e) {
                return notFound(rel);
            } catch (IOException e) {
                return notFound(rel);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            // 站内链接照常走 WebView，外部链接不在本 App 内打开
            Uri u = req.getUrl();
            return u == null || !HOST.equals(u.getHost());
        }
    }

    private static WebResourceResponse notFound(String rel) {
        byte[] msg = ("not found: " + rel).getBytes();
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                null, new ByteArrayInputStream(msg));
    }

    private static String mimeOf(String p) {
        String q = p.toLowerCase();
        if (q.endsWith(".html") || q.endsWith(".htm")) return "text/html";
        if (q.endsWith(".js")) return "application/javascript";
        if (q.endsWith(".css")) return "text/css";
        if (q.endsWith(".json")) return "application/json";
        if (q.endsWith(".webmanifest")) return "application/manifest+json";
        if (q.endsWith(".png")) return "image/png";
        if (q.endsWith(".jpg") || q.endsWith(".jpeg")) return "image/jpeg";
        if (q.endsWith(".svg")) return "image/svg+xml";
        if (q.endsWith(".woff2")) return "font/woff2";
        if (q.endsWith(".woff")) return "font/woff";
        if (q.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private static String encodingOf(String p) {
        String q = p.toLowerCase();
        if (q.endsWith(".png") || q.endsWith(".jpg") || q.endsWith(".jpeg")
                || q.endsWith(".woff2") || q.endsWith(".woff") || q.endsWith(".ico")) {
            return null; // 二进制，不声明编码
        }
        return "UTF-8";
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            if (web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
