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

/* ── In-memory state ──────────────────────────────── */
const roomStartTimes = {};   // roomId  → timestamp
const users          = {};   // socketId → { roomId, username }
const muteStates     = {};   // socketId → bool
const cameraStates   = {};   // socketId → bool

/* ── Helpers ──────────────────────────────────────── */
function getRoomUsers(roomId, excludeId = null) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room)
        .filter(id => id !== excludeId && users[id])
        .map(id => ({
            id,
            username:  users[id].username,
            isMuted:   muteStates[id]   || false,
            cameraOn:  cameraStates[id] !== false
        }));
}

/* ── Socket logic ─────────────────────────────────── */
io.on("connection", (socket) => {

    /* JOIN ROOM */
    socket.on("join-room", (roomId, username) => {
        socket.join(roomId);

        users[socket.id]       = { roomId, username: username || "Guest" };
        muteStates[socket.id]  = false;
        cameraStates[socket.id] = true;

        // Send existing users list to the new joiner
        socket.emit("existing-users", getRoomUsers(roomId, socket.id));

        // Tell everyone else a new user arrived
        socket.to(roomId).emit("user-connected", socket.id, username);

        // Participant count to all
        const count = io.sockets.adapter.rooms.get(roomId)?.size || 1;
        io.to(roomId).emit("participant-count", count);

        // Start/sync call timer
        if (count === 2 && !roomStartTimes[roomId]) {
            roomStartTimes[roomId] = Date.now();
            io.to(roomId).emit("call-started", roomStartTimes[roomId]);
        } else if (roomStartTimes[roomId]) {
            socket.emit("call-started", roomStartTimes[roomId]);
        }

        // ── WebRTC Signaling ─────────────────────────────
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

        // ── Group Chat ───────────────────────────────────
        // targetId = null  → broadcast to whole room
        socket.on("group-message", (message) => {
            const user = users[socket.id];
            if (!user || !message?.trim()) return;
            const payload = {
                senderId:   socket.id,
                senderName: user.username,
                message:    message.trim(),
                time:       Date.now()
            };
            // Send to everyone in room INCLUDING sender (so they see it too)
            io.to(user.roomId).emit("group-message", payload);
        });

        // ── Private Chat ─────────────────────────────────
        socket.on("private-message", (targetId, message) => {
            const user = users[socket.id];
            if (!user || !message?.trim() || !users[targetId]) return;
            const payload = {
                senderId:   socket.id,
                senderName: user.username,
                message:    message.trim(),
                time:       Date.now()
            };
            // Send to recipient
            io.to(targetId).emit("private-message", payload);
            // Echo back to sender so they see their own DM
            socket.emit("private-message-echo", { ...payload, recipientId: targetId, recipientName: users[targetId].username });
        });

        // ── Media States ─────────────────────────────────
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

        // ── Disconnect ───────────────────────────────────
        socket.on("disconnect", () => {
            const user = users[socket.id];
            if (!user) return;

            socket.to(user.roomId).emit("user-disconnected", socket.id);

            delete users[socket.id];
            delete muteStates[socket.id];
            delete cameraStates[socket.id];

            const remaining = io.sockets.adapter.rooms.get(user.roomId)?.size || 0;
            io.to(user.roomId).emit("participant-count", remaining);

            if (remaining === 0) {
                delete roomStartTimes[user.roomId];
            }
        });
    });
});

/* ── Start ────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Linkzo Live running on port ${PORT}`);
});
