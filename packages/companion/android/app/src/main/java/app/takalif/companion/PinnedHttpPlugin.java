package app.takalif.companion;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * HTTP transport for the companion, bypassing the WebView network stack.
 *
 * Why a native channel at all: the WebView cannot pin TLS certificates, and
 * verification IS the product here — the pairing QR carries the SHA-256 of
 * the server's self-signed certificate and the phone refuses any handshake
 * whose leaf does not match (trust-on-first-use; see the server's tls.ts).
 * Hostname verification is deliberately absent: the server answers an IP
 * address, and the pinned fingerprint is the identity. That is the
 * same trust model the Wikimedia/Syncthing-style TOFU tools document, not a
 * short-circuit of TLS — without a pin, https calls fail closed, and cleartext
 * http stays available for the v1 pairing contract.
 *
 * Errors are tagged machine-readably in the rejected message ("PIN:...",
 * "NET:...", "TLS:...") so the TypeScript side can route them: a pin
 * mismatch must re-pair, a network refusal may queue offline (ADR 0019).
 */
@CapacitorPlugin(name = "PinnedHttp")
public class PinnedHttpPlugin extends Plugin {

    private static final String TAG = "PinnedHttpPlugin";
    /** Where a certificate stops matching what the QR pinned. */
    private static final String ERR_PIN = "PIN";
    /** Unreachable, refused, timed out — offline-ness, not a verdict. */
    private static final String ERR_NET = "NET";
    /** Handshake failed for some other transport reason. */
    private static final String ERR_TLS = "TLS";

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        String body = call.getString("body");
        String fingerprint = call.getString("fingerprint");
        JSObject headers = call.getObject("headers");

        if (url == null || url.isEmpty()) {
            call.reject(tag(ERR_NET, "url is required"));
            return;
        }

        Request.Builder request = new Request.Builder().url(url);
        applyHeaders(request, headers, method, body);
        if (body != null) {
            MediaType type = contentTypeOf(headers);
            request.method(method, RequestBody.create(body, type));
        } else if (!"GET".equals(method) && !"HEAD".equals(method)) {
            request.method(method, RequestBody.create("", contentTypeOf(headers)));
        }

        OkHttpClient client = buildClient(fingerprint);
        client.newCall(request.build()).enqueue(new okhttp3.Callback() {
            @Override public void onFailure(Call call2, IOException error) {
                call.reject(tag(ERR_NET, "could not reach " + describe(hostOf(url)) + ": " + error.getMessage()));
            }

            @Override public void onResponse(Call call2, Response response) {
                try {
                    ResponseBody responseBody = response.body();
                    String text = responseBody == null ? "" : responseBody.string();
                    JSObject out = new JSObject();
                    out.put("status", response.code());
                    out.put("body", text);
                    out.put("headers", headersOut(response));
                    call.resolve(out);
                } catch (IOException error) {
                    call.reject(tag(ERR_NET, "response read failed: " + error.getMessage()));
                } finally {
                    response.close();
                }
            }
        });
    }

    private OkHttpClient buildClient(String pinnedSha256) {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .callTimeout(45, TimeUnit.SECONDS);
        if (pinnedSha256 == null || pinnedSha256.isEmpty()) {
            // Plain http (v1 pairing contract): no TLS configuration at all.
            return builder.build();
        }
        PinnedTrustManager trustManager = new PinnedTrustManager(pinnedSha256.trim().toLowerCase());
        SSLContext context;
        try {
            context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{trustManager}, null);
        } catch (Exception error) {
            Log.e(TAG, "tls init failed", error);
            throw new IllegalStateException("TLS context unavailable", error);
        }
        return builder
                .sslSocketFactory(context.getSocketFactory(), trustManager)
                // The fingerprint is the identity; the URL is an IP address on
                // a LAN where hostnames are fiction. Documented in tls.ts.
                .hostnameVerifier((hostname, session) -> true)
                .build();
    }

    private void applyHeaders(Request.Builder request, JSObject headers, String method, String body) {
        if (headers == null) return;
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String value = headers.optString(key, "");
            if (!value.isEmpty()) request.header(key, value);
        }
    }

    private MediaType contentTypeOf(JSObject headers) {
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if ("content-type".equalsIgnoreCase(key)) {
                    return MediaType.parse(headers.optString(key, "application/json"));
                }
            }
        }
        return MediaType.parse("application/json");
    }

    /** Only headers the web layer is allowed to reuse downstream. */
    private JSObject headersOut(Response response) {
        JSObject out = new JSObject();
        addIfPresent(out, response, "content-type");
        addIfPresent(out, response, "content-disposition");
        return out;
    }

    private void addIfPresent(JSObject out, Response response, String name) {
        String value = response.header(name);
        if (value != null) out.put(name, value);
    }

    private static String tag(String kind, String message) {
        return kind + ": " + message;
    }

    private String describe(String host) {
        // Redaction on purpose: error text travels to the user's eyes.
        return host == null ? "the server" : host;
    }

    private String hostOf(String url) {
        try {
            return new java.net.URI(url).getHost();
        } catch (Exception error) {
            return null;
        }
    }

    /**
     * The only trust this app grants: a handshake whose leaf certificate's
     * DER bytes hash to the fingerprint the QR payload carried. Everything
     * else fails closed. The chain is not walked — the server is
     * self-signed, the pin replaces the CA system, and one extra link could
     * not make a mismatch honest again.
     */
    static class PinnedTrustManager implements X509TrustManager {
        private final String fingerprint;

        PinnedTrustManager(String fingerprint) {
            this.fingerprint = fingerprint;
        }

        @Override public void checkClientTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            throw new CertificateException("client certificates are not a thing here");
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            if (chain == null || chain.length == 0) {
                throw new CertificateException(tag(ERR_TLS, "empty certificate chain"));
            }
            String sha;
            try {
                sha = sha256Hex(chain[0].getEncoded());
            } catch (CertificateEncodingException error) {
                throw new CertificateException(tag(ERR_TLS, "could not encode the certificate"));
            }
            if (!sha.equals(fingerprint)) {
                throw new CertificateException(
                        tag(ERR_PIN, "the server's certificate does not match the pairing code — re-pair"));
            }
        }

        @Override public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    private static String sha256Hex(byte[] der) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            StringBuilder out = new StringBuilder();
            for (byte b : digest.digest(der)) {
                out.append(String.format("%02x", b));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
}
