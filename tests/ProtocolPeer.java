package app.morphe.jam.companion;

import java.net.ServerSocket;
import java.net.Socket;

/** Interoperability fixture using the Android project's actual SecureChannel implementation. */
public final class ProtocolPeer {
    public static void main(String[] args) throws Exception {
        boolean host = args[0].equals("host");
        String jamId = args[1];
        byte[] secret = SecureChannel.decode(args[2]);
        if (host) {
            try (ServerSocket server = new ServerSocket(0)) {
                System.out.println(server.getLocalPort());
                System.out.flush();
                try (Socket socket = server.accept();
                     SecureChannel channel = new SecureChannel(socket, true, jamId, secret, args[3])) {
                    channel.send(channel.receive());
                }
            }
        } else {
            try (Socket socket = new Socket("127.0.0.1", Integer.parseInt(args[4]));
                 SecureChannel channel = new SecureChannel(socket, false, jamId, secret, args[3])) {
                channel.send("{\"op\":\"PING\",\"from\":\"android\"}");
                System.out.println(channel.receive());
            }
        }
    }
}
