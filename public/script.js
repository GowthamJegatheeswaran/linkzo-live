/* ═══════════════════════════════════════════════════
   Linkzo Live · script.js
   ─────────────────────────────────────────────────
   Features:
   · WebRTC with ICE candidate queuing
   · Multiple STUN/TURN for cross-network calls
   · Group chat (broadcast)
   · Private / DM chat
   · Mute / camera toggle with correct icon state
   · Call duration timer
   · Toast notifications for join/leave events
   · Participant panel with live mic/cam status
   ═══════════════════════════════════════════════════ */

/* ── Socket ────────────────────────────────────────── */
const socket = io({ transports: ["websocket", "polling"] });

/* ── Room & identity ───────────────────────────────── */
const roomId   = decodeURIComponent(new URLSearchParams(window.location.search).get("room") || "");
const username = localStorage.getItem("username") || "Guest";

document.getElementById("room-display").textContent = roomId;
document.getElementById("group-date-label").textContent = formatDate(new Date());

/* ── State ─────────────────────────────────────────── */
let localStream       = null;
let peers             = {};          // peerId → RTCPeerConnection
let pendingCandidates = {};          // peerId → RTCIceCandidate[]
let userNames         = {};          // peerId → displayName
let muteState         = {};          // peerId → bool (isMuted)
let camState          = {};          // peerId → bool (cameraOn)
let participantCount  = 0;
let isMuted           = false;
let isCameraOn        = true;
let callTimerInterval = null;

const configuration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302"  },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        {
            urls: [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:443",
                "turns:openrelay.metered.ca:443"
            ],
            username:   "openrelayproject",
            credential: "openrelayproject"
        }
    ],
    iceTransportPolicy: "all",
    bundlePolicy:       "max-bundle",
    rtcpMuxPolicy:      "require"
};

/* ════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════ */
async function init() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
        });
    } catch (_) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err) {
            showToast("Cannot access camera/microphone. Check permissions.", "error");
            return;
        }
    }

    addVideoStream(localStream, "local", username);
    socket.emit("join-room", roomId, username);
    bindInputs();
}

/* ════════════════════════════════════════════════════
   SOCKET EVENTS
   ════════════════════════════════════════════════════ */

/* Existing users when we join */
socket.on("existing-users", (users) => {
    users.forEach(u => {
        userNames[u.id]  = u.username;
        muteState[u.id]  = u.isMuted;
        camState[u.id]   = u.cameraOn;
        if (socket.id < u.id) connectToUser(u.id);
    });
    renderParticipants();
    refreshDMList();
});

/* New user joins */
socket.on("user-connected", (userId, name) => {
    userNames[userId] = name;
    if (socket.id < userId) connectToUser(userId);
    showToast(`${name} joined the meeting`, "join");
    renderParticipants();
    refreshDMList();
});

/* WebRTC offer */
socket.on("offer", async (offer, senderId, senderName) => {
    userNames[senderId] = senderName;
    let peer = peers[senderId] || createPeer(senderId);
    try {
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        flushCandidates(senderId);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit("answer", answer, senderId);
    } catch (e) {
        console.warn("[offer]", e);
    }
});

/* WebRTC answer */
socket.on("answer", async (answer, senderId) => {
    const peer = peers[senderId];
    if (!peer || peer.signalingState !== "have-local-offer") return;
    try {
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
        flushCandidates(senderId);
    } catch (e) {
        console.warn("[answer]", e);
    }
});

    socket.on("ice-candidate", (candidate, userId) => {
        if (peers[userId]) {
            peers[userId].addIceCandidate(
                new RTCIceCandidate(candidate)
            );
        }
    });

    socket.on("chat-message", (message, sender) => {
        addMessage(sender, message);
    });

    socket.on("participant-count", (count) => {
    participantCount = count;
    document.getElementById("participant-count").textContent = count;
    document.getElementById("pane-count").textContent = count;
});

/* Call timer sync */
socket.on("call-started", (startTime) => {
    if (callTimerInterval) clearInterval(callTimerInterval);
    const el = document.getElementById("call-duration");
    callTimerInterval = setInterval(() => {
        const total = Math.floor((Date.now() - startTime) / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        el.textContent = h > 0
            ? `${pad(h)}:${pad(m)}:${pad(s)}`
            : `${pad(m)}:${pad(s)}`;
    }, 1000);
    // Show the status dot as green/active
    document.querySelector(".status-dot")?.classList.add("active");
});

/* Mute state change */
socket.on("mute-status", (userId, muted) => {
    muteState[userId] = muted;
    const icon = document.getElementById("mute-icon-" + userId);
    if (icon) icon.style.display = muted ? "flex" : "none";
    renderParticipants();
});

    socket.on("camera-status", (userId, isOn) => {

        localCameraStates[userId] = isOn;

        const container = document.getElementById("container-" + userId);
        if (!container) return;

        const video = document.getElementById(userId);
        let avatar = document.getElementById("avatar-" + userId);

        if (!isOn) {

            if (!avatar) {
                avatar = document.createElement("div");
                avatar.classList.add("avatar");
                avatar.id = "avatar-" + userId;
                avatar.innerText =
                    (userNames[userId]?.charAt(0).toUpperCase()) || "?";
                container.appendChild(avatar);
            }

            if (video) video.style.display = "none";

        } else {

            if (video) video.style.display = "block";
            if (avatar) avatar.remove();
        }

        renderParticipants();
    });

/* Group message */
socket.on("group-message", (payload) => {
    const isMe = (payload.senderId === socket.id);
    appendGroupMessage(payload, isMe);
    if (!isMe) {
        if (activeTab !== "group" || !panelVisible) {
            groupUnread++;
            updateUnreadBadges();
        }
    }
});

/* Private message received */
socket.on("private-message", (payload) => {
    const senderId = payload.senderId;
    if (!dmHistory[senderId]) dmHistory[senderId] = [];
    dmHistory[senderId].push({ ...payload, isMe: false });

    if (activeDMId === senderId && activeTab === "private" && panelVisible) {
        appendDMMessage(payload, false);
    } else {
        privateUnread++;
        updateUnreadBadges();
        showToast(`💬 ${payload.senderName}: ${payload.message.substring(0, 50)}`, "dm");
    }
});

/* Echo of our own private message */
socket.on("private-message-echo", (payload) => {
    const rid = payload.recipientId;
    if (!dmHistory[rid]) dmHistory[rid] = [];
    dmHistory[rid].push({ ...payload, isMe: true });
    if (activeDMId === rid && activeTab === "private" && panelVisible) {
        appendDMMessage({ ...payload, senderName: "You" }, true);
    }
});

/* ════════════════════════════════════════════════════
   PEER CONNECTIONS
   ════════════════════════════════════════════════════ */
function createPeer(userId) {
    if (peers[userId]) peers[userId].close();

    const peer = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => {
        peer.addTrack(track, localStream);
    });

    peer.ontrack = ({ streams: [stream] }) => {
        if (!document.getElementById("container-" + userId)) {
            addVideoStream(stream, userId, userNames[userId] || "Participant");
        } else {
            const v = document.getElementById(userId);
            if (v && v.srcObject !== stream) v.srcObject = stream;
        }
    };

    peer.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit("ice-candidate", candidate, userId);
    };

    peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" && socket.id < userId) {
            peer.restartIce();
        }
    };

    peers[userId] = peer;
    return peer;
}

async function connectToUser(userId) {
    const peer  = createPeer(userId);
    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await peer.setLocalDescription(offer);
    socket.emit("offer", offer, userId);
}

function flushCandidates(userId) {
    (pendingCandidates[userId] || []).forEach(c =>
        peers[userId]?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
    );
    delete pendingCandidates[userId];
}

function closePeerConnection(userId) {
    peers[userId]?.close();
    delete peers[userId];
    delete pendingCandidates[userId];
    delete userNames[userId];
    delete muteState[userId];
    delete camState[userId];
    document.getElementById("container-" + userId)?.remove();

    // Revert main video to local if it was showing this user
    const mv = document.getElementById("mainVideo");
    if (mv && !document.getElementById(userId)) {
        mv.srcObject = localStream;
        mv.muted = true;
        mv.classList.add("mirror");
        document.getElementById("mainVideoLabel").textContent = `You (${username})`;
    }
}

/* ════════════════════════════════════════════════════
   VIDEO UI
   ════════════════════════════════════════════════════ */
function addVideoStream(stream, id, name) {
    if (document.getElementById("container-" + id)) return;

    const wrap  = document.getElementById("video-grid");
    const outer = document.createElement("div");
    outer.className = "thumb-card";
    outer.id = "container-" + id;
    outer.title = "Click to spotlight";
    outer.onclick = () => spotlightVideo(id, stream, id === "local" ? `You (${username})` : name);

    const video = document.createElement("video");
    video.srcObject  = stream;
    video.autoplay   = true;
    video.playsInline = true;
    video.muted      = (id === "local");
    video.id         = id;
    video.onloadedmetadata = () => video.play().catch(() => {});
    if (id === "local") video.classList.add("mirror");

    const labelEl = document.createElement("div");
    labelEl.className = "thumb-name";
    labelEl.id = "label-" + id;
    labelEl.textContent = id === "local" ? `You (${username})` : name;

    const muteEl = document.createElement("div");
    muteEl.className = "thumb-mute-icon";
    muteEl.id = "mute-icon-" + id;
    muteEl.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
    muteEl.style.display = (muteState[id] ? "flex" : "none");

    outer.append(video, labelEl, muteEl);
    wrap.appendChild(outer);

    // Spotlight: set as main video (prefer remote)
    const mv = document.getElementById("mainVideo");
    if (mv && (!mv.srcObject || id !== "local")) {
        spotlightVideo(id, stream, id === "local" ? `You (${username})` : name);
    }

    // If camera already known to be off, show avatar
    if (camState[id] === false) {
        video.style.display = "none";
        injectAvatar(outer, id);
    }
}

function spotlightVideo(id, stream, label) {
    const mv = document.getElementById("mainVideo");
    const ml = document.getElementById("mainVideoLabel");
    if (!mv || !stream) return;
    mv.srcObject = stream;
    mv.muted = (id === "local");
    id === "local" ? mv.classList.add("mirror") : mv.classList.remove("mirror");
    if (ml) ml.textContent = label;

    // Highlight the active thumb
    document.querySelectorAll(".thumb-card").forEach(c => c.classList.remove("spotlit"));
    document.getElementById("container-" + id)?.classList.add("spotlit");
}

function applyRemoteCamState(userId, isOn) {
    const cont   = document.getElementById("container-" + userId);
    const video  = document.getElementById(userId);
    const avatar = document.getElementById("avatar-" + userId);
    if (!cont) return;
    if (!isOn) {
        if (video)  video.style.display = "none";
        if (!avatar) injectAvatar(cont, userId);
    } else {
        if (video)  video.style.display = "";
        avatar?.remove();
    }

    bottomRow.innerHTML = "";

    allContainers.forEach(container => {
        if (container.id !== "container-" + id) {
            container.classList.remove("focused");
            bottomRow.appendChild(container);
        }
    });
}

function removeFocusMode() {

    focusedId = null;
    videoGrid.classList.remove("focus-mode");

    const bottomRow = document.querySelector(".bottom-row");

    if (bottomRow) {
        const children = Array.from(bottomRow.children);
        children.forEach(child => videoGrid.appendChild(child));
        bottomRow.remove();
    }

    document.querySelectorAll(".video-container").forEach(c => {
        c.classList.remove("focused");
    });
}

/* ================= CHAT ================= */

function sendMessage() {
    const input = document.getElementById("chat-message");
    if (input.value.trim() !== "") {
        socket.emit("chat-message", input.value);
        input.value = "";
    }
}

function addMessage(sender, message) {

    const messages = document.getElementById("messages");

    const bubble = document.createElement("div");

    const isMe = sender === username;

    bubble.classList.add("chat-bubble");
    bubble.classList.add(isMe ? "me" : "other");

    // message wrapper
    if (isMe) {
        bubble.innerHTML = `
            <div class="chat-text">${message}</div>
        `;
    } else {
        bubble.innerHTML = `
            <div class="chat-name">${sender}</div>
            <div class="chat-text">${message}</div>
        `;
    }

    messages.appendChild(bubble);
    bubble.style.opacity = "0";
bubble.style.transform = "translateY(6px)";

setTimeout(() => {
    bubble.style.transition = "all 0.2s ease";
    bubble.style.opacity = "1";
    bubble.style.transform = "translateY(0)";
}, 10);
    messages.scrollTop = messages.scrollHeight;
}
/* ================= MEDIA CONTROLS ================= */

function toggleMute() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    isMuted = !isMuted;
    track.enabled = !isMuted;
    muteState["local"] = isMuted;

    const btn  = document.getElementById("btnMute");
    const icon = btn?.querySelector("i");
    if (icon) icon.className = isMuted
        ? "fa-solid fa-microphone-slash"
        : "fa-solid fa-microphone";
    btn?.classList.toggle("ctrl-off", isMuted);
    document.querySelector(".ctrl-item:nth-child(1) .ctrl-label").textContent =
        isMuted ? "Unmute" : "Mute";

    const thumbMute = document.getElementById("mute-icon-local");
    if (thumbMute) thumbMute.style.display = isMuted ? "flex" : "none";

    socket.emit("mute-status", isMuted);
    renderParticipants();
}

function toggleVideo() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    isCameraOn = !isCameraOn;
    track.enabled = isCameraOn;
    camState["local"] = isCameraOn;

    const btn  = document.getElementById("btnVideo");
    const icon = btn?.querySelector("i");
    if (icon) icon.className = isCameraOn
        ? "fa-solid fa-video"
        : "fa-solid fa-video-slash";
    btn?.classList.toggle("ctrl-off", !isCameraOn);
    document.querySelector(".ctrl-item:nth-child(2) .ctrl-label").textContent =
        isCameraOn ? "Camera" : "Start Cam";

    const cont   = document.getElementById("container-local");
    const video  = document.getElementById("local");
    const avatar = document.getElementById("avatar-local");
    if (!isCameraOn) {
        if (video) video.style.display = "none";
        if (!avatar && cont) injectAvatar(cont, "local");
    } else {
        if (video) video.style.display = "";
        avatar?.remove();
    }

    socket.emit("camera-status", isCameraOn);
    renderParticipants();
}

function togglePanel() {
    panelVisible = !panelVisible;
    const panel = document.getElementById("sidePanel");
    panel?.classList.toggle("panel-hidden", !panelVisible);
}

function openGroupChat() {
    panelVisible = true;
    document.getElementById("sidePanel")?.classList.remove("panel-hidden");
    switchTab("group");
}

function openPeople() {
    panelVisible = true;
    document.getElementById("sidePanel")?.classList.remove("panel-hidden");
    switchTab("participants");
}

/* ════════════════════════════════════════════════════
   FULLSCREEN / PiP
   ════════════════════════════════════════════════════ */
function toggleFullscreen() {
    const wrap = document.getElementById("mainVideoWrap");
    if (!document.fullscreenElement) wrap?.requestFullscreen();
    else document.exitFullscreen();
}

async function togglePiP() {
    const video = document.getElementById("mainVideo");
    try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else {
            if (document.fullscreenElement) await document.exitFullscreen();
            await video.requestPictureInPicture();
        }
    } catch (e) { console.warn("PiP:", e); }
}

/* ════════════════════════════════════════════════════
   END CALL
   ════════════════════════════════════════════════════ */
function endCall() {
    if (!confirm("Leave this meeting?")) return;
    localStream?.getTracks().forEach(t => t.stop());
    Object.values(peers).forEach(p => p.close());
    if (callTimerInterval) clearInterval(callTimerInterval);
    socket.disconnect();
    window.location.href = "/";
}

/* ════════════════════════════════════════════════════
   PANEL TABS
   ════════════════════════════════════════════════════ */
function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(p => p.classList.remove("active"));
    document.getElementById("tab-" + tab)?.classList.add("active");
    document.getElementById("pane-" + tab)?.classList.add("active");

    if (tab === "group") {
        groupUnread = 0;
        updateUnreadBadges();
        scrollToBottom("group-messages");
    }
    if (tab === "private") {
        privateUnread = 0;
        updateUnreadBadges();
    }
    if (tab === "participants") renderParticipants();
}

/* ════════════════════════════════════════════════════
   PARTICIPANTS
   ════════════════════════════════════════════════════ */
function renderParticipants() {
    const list = document.getElementById("participants-list");
    if (!list) return;
    list.innerHTML = "";

    // Local user
    appendParticipantRow("local", `You (${username})`);

    // Remote users
    Object.keys(userNames).forEach(id => appendParticipantRow(id, userNames[id]));
}

function appendParticipantRow(id, name) {
    const list = document.getElementById("participants-list");

    const div = document.createElement("div");
    div.className = "participant-item";

    const muteIcon = localMuteStates[id]
        ? '<i class="fa-solid fa-microphone-slash"></i>'
        : '<i class="fa-solid fa-microphone"></i>';

    const camIcon = localCameraStates[id] === false
        ? '<i class="fa-solid fa-video-slash"></i>'
        : '<i class="fa-solid fa-video"></i>';

    div.innerHTML = `
        <span class="participant-name">${name}</span>
        <span class="participant-icons">
            ${muteIcon} ${camIcon}
        </span>
    `;

    list.appendChild(div);
}

function startCallTimer() {

    const durationEl = document.getElementById("call-duration");

    callTimerInterval = setInterval(() => {

        callSeconds++;

        const minutes = Math.floor(callSeconds / 60);
        const seconds = callSeconds % 60;

        durationEl.innerText =
            `${String(minutes).padStart(2,'0')}:` +
            `${String(seconds).padStart(2,'0')}`;

    }, 1000);
}