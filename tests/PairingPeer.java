package app.morphe.jam.companion;

import java.net.ServerSocket;
import java.net.Socket;
import java.util.UUID;

/** Runs the Android invitation exchange and then a real Jam handshake on the same socket. */
public final class PairingPeer {
    public static void main(String[] args) throws Exception {
        Invitation invite = new Invitation(args[1]);
        if (args[0].equals("host")) {
            try (ServerSocket server = new ServerSocket(0)) {
                System.out.println(server.getLocalPort());
                System.out.flush();
                try (Socket socket = server.accept()) {
                    CodeExchange.giveAndKeep(socket, invite, args[2]);
                    try (SecureChannel channel = new SecureChannel(socket, true, invite.jamId, invite.secret, null)) {
                        channel.send(channel.receive());
                    }
                }
            }
        } else {
            try (Socket socket = new Socket("127.0.0.1", Integer.parseInt(args[3]))) {
                Invitation received = new Invitation(CodeExchange.takeAndKeep(socket, invite.jamId, args[2]));
                try (SecureChannel channel = new SecureChannel(socket, false, received.jamId, received.secret, UUID.randomUUID().toString())) {
                    channel.send("{\"op\":\"PING\"}");
                    System.out.println(channel.receive());
                }
            }
        }
    }
}
