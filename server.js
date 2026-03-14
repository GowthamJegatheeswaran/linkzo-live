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

        /* ── WebRTC signaling ── */
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

        /* ── Screen share state ── */
        socket.on("screen-sharing", (isSharing) => {
            const user = users[socket.id];
            if (!user) return;
            screenStates[socket.id] = isSharing;
            socket.to(user.roomId).emit("screen-sharing", socket.id, isSharing, user.username);
        });

        /* ── Group chat ── */
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

        /* ── Private chat ── */
        socket.on("private-message", (targetId, message) => {
            const user = users[socket.id];
            if (!user || !message?.trim() || !users[targetId]) return;
            const payload = {
                senderId:   socket.id,
                senderName: user.username,
                message:    message.trim(),
                time:       Date.now()
            };
            io.to(targetId).emit("private-message", payload);
            socket.emit("private-message-echo", {
                ...payload,
                recipientId:   targetId,
                recipientName: users[targetId].username
            });
        });

        /* ── Media states ── */
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

        /* ── Disconnect ── */
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
