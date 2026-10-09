package com.danilo.flashsignals;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Recibe el resultado de RUN_COMMAND (PendingIntent de Termux): extra "result" con
 * stdout, stderr, exitCode, err y errmsg. Solo comandos en segundo plano devuelven stdout.
 */
public class TermuxResultReceiver extends BroadcastReceiver {

    static final String EXTRA_ID = "flash_request_id";

    private static final Map<Integer, Consumer<Bundle>> PENDING = new ConcurrentHashMap<>();
    private static final AtomicInteger NEXT_ID = new AtomicInteger(1);

    static int register(Consumer<Bundle> callback) {
        int id = NEXT_ID.getAndIncrement();
        PENDING.put(id, callback);
        return id;
    }

    /** Quita el callback; devuelve null si ya se entregó o expiró. */
    static Consumer<Bundle> take(int id) {
        return PENDING.remove(id);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Consumer<Bundle> callback = take(intent.getIntExtra(EXTRA_ID, -1));
        if (callback == null) return;
        Bundle result = intent.getBundleExtra("result");
        callback.accept(result != null ? result : new Bundle());
    }
}
