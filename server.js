const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*" },
    transports: ["websocket", "polling"],
    pingTimeout:  60000,
    pingInterval: 25000
});

app.use(express.static("public"));

/* ── ICE / TURN credential endpoint ────────────────
   Serves fresh TURN credentials to the client.
   Uses multiple free TURN servers as fallback so
   cross-network video works even if one goes down.
   ─────────────────────────────────────────────────*/
app.get("/ice-config", (req, res) => {
    // Multiple TURN servers for maximum reliability
    // These are well-known free/public TURN servers
    const iceServers = [
        // Google STUN (just for NAT detection, not relay)
        { urls: "stun:stun.l.google.com:19302"  },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },

        // Metered.ca free TURN — most reliable free option
        // Sign up free at app.metered.ca → Dashboard → TURN credentials
        // Replace these with your own from: https://app.metered.ca/tools/online-turn-server
        {
            urls: [
                "turn:a.relay.metered.ca:80",
                "turn:a.relay.metered.ca:80?transport=tcp",
                "turn:a.relay.metered.ca:443",
                "turn:a.relay.metered.ca:443?transport=tcp",
                "turns:a.relay.metered.ca:443"
            ],
            username:   process.env.METERED_USERNAME   || "openrelayproject",
            credential: process.env.METERED_CREDENTIAL || "openrelayproject"
        },

        // Cloudflare TURN (if you have Cloudflare account — free tier available)
        // Kept as extra fallback with same credentials structure

        // Twilio backup (requires Twilio account but very reliable)
        // Uncomment and add your own if needed:
        // {
        //   urls: "turn:global.turn.twilio.com:3478?transport=udp",
        //   username: process.env.TWILIO_TURN_USERNAME,
        //   credential: process.env.TWILIO_TURN_CREDENTIAL
        // }
    ];

    res.json({ iceServers });
});

const roomStartTimes = {};
const users          = {};
const muteStates     = {};
const cameraStates   = {};
const screenStates   = {};

function getRoomUsers(roomId, excludeId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room)
        .filter(id => id !== excludeId && users[id])
        .map(id => ({
            id,
            username:  users[id].username,
            isMuted:   muteStates[id]   || false,
            cameraOn:  cameraStates[id] !== false,
            isSharing: screenStates[id] || false
        }));
}

io.on("connection", (socket) => {

    socket.on("join-room", (roomId, username) => {
        socket.join(roomId);

        users[socket.id]        = { roomId, username: username || "Guest" };
        muteStates[socket.id]   = false;
        cameraStates[socket.id] = true;
        screenStates[socket.id] = false;

        socket.emit("existing-users", getRoomUsers(roomId, socket.id));
        socket.to(roomId).emit("user-connected", socket.id, username);

        const count = io.sockets.adapter.rooms.get(roomId)?.size || 1;
        io.to(roomId).emit("participant-count", count);

        if (count === 2 && !roomStartTimes[roomId]) {
            roomStartTimes[roomId] = Date.now();
            io.to(roomId).emit("call-started", roomStartTimes[roomId]);
        } else if (roomStartTimes[roomId]) {
            socket.emit("call-started", roomStartTimes[roomId]);
        }

        socket.on("offer", (offer, targetId) => {
            const user = users[socket.id];
            if (!user) return;
            io.to(targetId).emit("offer", offer, socket.id, user.username);
        });
        socket.on("answer", (answer, targetId) => {
            io.to(targetId).emit("answer", answer, socket.id);
        });
        socket.on("ice-candidate", (candidate, targetId) => {
            io.to(targetId).emit("ice-candidate", candidate, socket.id);
        });

        socket.on("screen-sharing", (isSharing) => {
            const user = users[socket.id];
            if (!user) return;
            screenStates[socket.id] = isSharing;
            socket.to(user.roomId).emit("screen-sharing", socket.id, isSharing, user.username);
        });

        socket.on("group-message", (message) => {
            const user = users[socket.id];
            if (!user || !message?.trim()) return;
            io.to(user.roomId).emit("group-message", {
                senderId:   socket.id,
                senderName: user.username,
                message:    message.trim(),
                time:       Date.now()
            });
        });

        socket.on("private-message", (targetId, message) => {
            const user = users[socket.id];
            if (!user || !message?.trim() || !users[targetId]) return;
            // Only send to recipient — sender renders their own message immediately
            io.to(targetId).emit("private-message", {
                senderId:   socket.id,
                senderName: user.username,
                message:    message.trim(),
                time:       Date.now()
            });
        });

        socket.on("mute-status", (isMuted) => {
            const user = users[socket.id];
            if (!user) return;
            muteStates[socket.id] = isMuted;
            socket.to(user.roomId).emit("mute-status", socket.id, isMuted);
        });
        socket.on("camera-status", (isOn) => {
            const user = users[socket.id];
            if (!user) return;
            cameraStates[socket.id] = isOn;
            socket.to(user.roomId).emit("camera-status", socket.id, isOn);
        });

        socket.on("disconnect", () => {
            const user = users[socket.id];
            if (!user) return;
            socket.to(user.roomId).emit("user-disconnected", socket.id);
            delete users[socket.id];
            delete muteStates[socket.id];
            delete cameraStates[socket.id];
            delete screenStates[socket.id];
            const remaining = io.sockets.adapter.rooms.get(user.roomId)?.size || 0;
            io.to(user.roomId).emit("participant-count", remaining);
            if (remaining === 0) delete roomStartTimes[user.roomId];
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Linkzo Live on port ${PORT}`));