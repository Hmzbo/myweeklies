package app.takalif.companion;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The pinned HTTP transport lives native-side because the WebView
        // cannot pin certificates; every /api call rides through it.
        registerPlugin(PinnedHttpPlugin.class);
    }
}
