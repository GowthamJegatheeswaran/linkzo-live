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

/* ── ICE / TURN endpoint ─────────────────────────────
   Multiple TURN servers from different providers.
   WebRTC tries ALL of them simultaneously and uses
   whichever responds first — so if one quota runs out
   or goes down, the others automatically take over.
   ─────────────────────────────────────────────────── */
app.get("/ice-config", (req, res) => {

    const iceServers = [

        // ── STUN servers (free, no quota, just for NAT detection) ──
        { urls: "stun:stun.l.google.com:19302"       },
        { urls: "stun:stun1.l.google.com:19302"      },
        { urls: "stun:stun2.l.google.com:19302"      },
        { urls: "stun:stun3.l.google.com:19302"      },
        { urls: "stun:stun4.l.google.com:19302"      },
        { urls: "stun:stun.cloudflare.com:3478"      },
        { urls: "stun:stun.stunprotocol.org:3478"    },
        { urls: "stun:stun.voip.blackberry.com:3478" },

        // ── TURN #1 — Metered.ca (your account, env vars) ──
        // 500MB free/month — primary relay
        {
            urls: [
                "turn:a.relay.metered.ca:80",
                "turn:a.relay.metered.ca:80?transport=tcp",
                "turn:a.relay.metered.ca:443",
                "turn:a.relay.metered.ca:443?transport=tcp",
                "turns:a.relay.metered.ca:443"
            ],
            username:   process.env.METERED_USERNAME   || "",
            credential: process.env.METERED_CREDENTIAL || ""
        },

        // ── TURN #2 — Metered.ca second credential (env vars) ──
        // Add METERED_USERNAME2 / METERED_CREDENTIAL2 in Railway
        // for a second 500MB pool — doubles your relay capacity
        ...(process.env.METERED_USERNAME2 ? [{
            urls: [
                "turn:a.relay.metered.ca:80",
                "turn:a.relay.metered.ca:443",
                "turns:a.relay.metered.ca:443"
            ],
            username:   process.env.METERED_USERNAME2,
            credential: process.env.METERED_CREDENTIAL2 || ""
        }] : []),

        // ── TURN #3 — Open Relay Project (free, no signup) ──
        // Less reliable but zero quota — good emergency fallback
        {
            urls: [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:80?transport=tcp",
                "turn:openrelay.metered.ca:443",
                "turns:openrelay.metered.ca:443"
            ],
            username:   "openrelayproject",
            credential: "openrelayproject"
        },

        // ── TURN #4 — Numb (free public TURN, no signup) ──
        {
            urls: [
                "turn:numb.viagenie.ca:3478",
                "turn:numb.viagenie.ca:3478?transport=tcp"
            ],
            username:   "webrtc@live.com",
            credential: "muazkh"
        },

        // ── TURN #5 — Xirsys free tier (very reliable) ──
        // Add XIRSYS_USERNAME / XIRSYS_CREDENTIAL in Railway
        // after signing up free at xirsys.com
        ...(process.env.XIRSYS_USERNAME ? [{
            urls: [
                "turn:ss.xirsys.com:80?transport=udp",
                "turn:ss.xirsys.com:3478?transport=udp",
                "turn:ss.xirsys.com:443?transport=tcp",
                "turns:ss.xirsys.com:443?transport=tcp"
            ],
            username:   process.env.XIRSYS_USERNAME,
            credential: process.env.XIRSYS_CREDENTIAL || ""
        }] : []),
    ];

    // Filter out TURN entries with empty credentials
    const filtered = iceServers.filter(s => {
        if (!s.username && !s.credential) return true; // STUN — keep always
        if (s.username === "") return false;            // empty cred — skip
        return true;
    });

    res.json({ iceServers: filtered });
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