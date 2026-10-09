package com.danilo.flashsignals;

import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;

import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Servidor HTTP mínimo en 127.0.0.1 que entrega assets del APK a Termux (curl).
 * Evita copiar el paquete a Download/ y el permiso de almacenamiento de Termux.
 * Las rutas llevan un token aleatorio: otras apps del teléfono no pueden adivinarlas.
 */
final class AssetServer implements Closeable {

    private final AssetManager assets;
    private final Map<String, String> routes;
    private final ServerSocket socket;
    private final String token = UUID.randomUUID().toString().replace("-", "");
    final AtomicLong bytesSent = new AtomicLong();

    AssetServer(AssetManager assets, Map<String, String> routes) throws IOException {
        this.assets = assets;
        this.routes = routes;
        socket = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(this::acceptLoop, "flash-asset-server");
        t.setDaemon(true);
        t.start();
    }

    String url(String name) {
        return "http://127.0.0.1:" + socket.getLocalPort() + "/" + token + "/" + name;
    }

    long length(String name) {
        String asset = routes.get(name);
        if (asset == null) return -1;
        try (AssetFileDescriptor fd = assets.openFd(asset)) {
            return fd.getLength();
        } catch (IOException e) {
            return -1;
        }
    }

    @Override
    public void close() {
        try {
            socket.close();
        } catch (IOException ignored) {
            // ya cerrado
        }
    }

    private void acceptLoop() {
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                Thread t = new Thread(() -> serve(client), "flash-asset-client");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket client) {
        try (Socket c = client;
             InputStream in = c.getInputStream();
             OutputStream out = new BufferedOutputStream(c.getOutputStream(), 1 << 16)) {
            String request = readLine(in);
            String line;
            do {
                line = readLine(in);
            } while (line != null && !line.isEmpty());

            String asset = null;
            String name = null;
            String[] parts = request == null ? new String[0] : request.split(" ");
            String prefix = "/" + token + "/";
            if (parts.length >= 2 && "GET".equals(parts[0]) && parts[1].startsWith(prefix)) {
                name = parts[1].substring(prefix.length());
                asset = routes.get(name);
            }
            if (asset == null) {
                out.write(ascii("HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
                return;
            }
            long len = length(name);
            StringBuilder head = new StringBuilder("HTTP/1.0 200 OK\r\n")
                    .append("Content-Type: application/octet-stream\r\nConnection: close\r\n");
            if (len >= 0) head.append("Content-Length: ").append(len).append("\r\n");
            out.write(ascii(head.append("\r\n").toString()));

            byte[] buf = new byte[1 << 16];
            try (InputStream a = assets.open(asset, AssetManager.ACCESS_STREAMING)) {
                int n;
                while ((n = a.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    bytesSent.addAndGet(n);
                }
            }
            out.flush();
        } catch (IOException ignored) {
            // curl cortó la conexión: Termux informa del error
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = in.read()) != -1 && b != '\n') {
            if (b != '\r') sb.append((char) b);
            if (sb.length() > 8192) throw new IOException("cabecera demasiado larga");
        }
        return b == -1 && sb.length() == 0 ? null : sb.toString();
    }

    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }
}
