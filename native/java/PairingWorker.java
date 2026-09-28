package app.morphe.jam.companion;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

/** Runs Android's unchanged J-PAKE exchange over a private pipe to the Node helper. */
public final class PairingWorker {
    private static final class PipeTransport implements ChannelTransport {
        private final DataInputStream input = new DataInputStream(System.in);
        private final DataOutputStream output = new DataOutputStream(System.out);

        public byte[] read(int maximum) throws IOException {
            int length = input.readInt();
            if (length < 1 || length > maximum) throw new IOException("Invalid pairing frame");
            byte[] value = new byte[length];
            input.readFully(value);
            return value;
        }

        public void write(byte[] value) throws IOException {
            output.writeInt(value.length);
            output.write(value);
            output.flush();
        }

        // Node owns the deadline and terminates this process when cancelled.
        public void setReadTimeout(int millis) {}
        public boolean isClosed() { return false; }
        public void close() throws IOException { input.close(); }
    }

    public static void main(String[] arguments) {
        try {
            PipeTransport pipe = new PipeTransport();
            JSONObject request = new JSONObject(new String(pipe.read(1024), StandardCharsets.UTF_8));
            byte[] key = CodeExchange.agree(pipe, request.getBoolean("host"),
                    request.getString("jam"), request.getString("code"));
            try {
                // This fourth message is consumed locally, never forwarded to the network.
                pipe.write(new JSONObject().put("key", SecureChannel.encode(key))
                        .toString().getBytes(StandardCharsets.UTF_8));
            } finally {
                Arrays.fill(key, (byte) 0);
            }
        } catch (Exception failure) {
            System.err.println("Pairing authentication failed");
            System.exit(1);
        }
    }
}
