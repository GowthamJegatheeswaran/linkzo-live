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
let activeTab         = "participants";
let activeDMId        = null;        // peerId of current DM partner
let dmHistory         = {};          // peerId → [{...}]
let groupUnread       = 0;
let privateUnread     = 0;
let panelVisible      = true;

/* ── ICE config (multiple STUN + TURN for cross-network) ── */
const RTC_CONFIG = {
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

/* ICE candidate */
socket.on("ice-candidate", (candidate, senderId) => {
    const peer = peers[senderId];
    if (peer?.remoteDescription?.type) {
        peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    } else {
        if (!pendingCandidates[senderId]) pendingCandidates[senderId] = [];
        pendingCandidates[senderId].push(candidate);
    }
});

/* User leaves */
socket.on("user-disconnected", (userId) => {
    const name = userNames[userId] || "A participant";
    closePeerConnection(userId);
    showToast(`${name} left the meeting`, "leave");
    renderParticipants();
    refreshDMList();
    if (activeDMId === userId) closeDM();
});

/* Participant count */
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

/* Camera state change */
socket.on("camera-status", (userId, isOn) => {
    camState[userId] = isOn;
    applyRemoteCamState(userId, isOn);
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

    const peer = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach(t => peer.addTrack(t, localStream));

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
}

function injectAvatar(container, id) {
    const av = document.createElement("div");
    av.className = "thumb-avatar";
    av.id = "avatar-" + id;
    av.textContent = (id === "local" ? username : userNames[id] || "?")
                        .charAt(0).toUpperCase();
    container.appendChild(av);
}

/* ════════════════════════════════════════════════════
   CONTROLS
   ════════════════════════════════════════════════════ */
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
    const row  = document.createElement("div");
    row.className = "p-row";

    const initials = getInitials(name);
    const micOff   = muteState[id];
    const camOff   = camState[id] === false;
    const isLocal  = (id === "local");

    row.innerHTML = `
      <div class="p-av" style="background:${avatarColor(name)}">${initials}</div>
      <div class="p-info">
        <div class="p-name">${esc(name)}</div>
        ${isLocal ? '<div class="p-you-tag">You</div>' : ""}
      </div>
      <div class="p-status">
        <span class="p-icon ${micOff ? "off" : ""}" title="${micOff ? "Muted" : "Unmuted"}">
          <i class="fa-solid ${micOff ? "fa-microphone-slash" : "fa-microphone"}"></i>
        </span>
        <span class="p-icon ${camOff ? "off" : ""}" title="${camOff ? "Camera off" : "Camera on"}">
          <i class="fa-solid ${camOff ? "fa-video-slash" : "fa-video"}"></i>
        </span>
        ${!isLocal ? `<button class="p-dm-btn" onclick="openDM('${id}')" title="Send DM">
          <i class="fa-solid fa-message"></i>
        </button>` : ""}
      </div>
    `;
    list.appendChild(row);
}

/* ════════════════════════════════════════════════════
   GROUP CHAT
   ════════════════════════════════════════════════════ */
function sendGroupMessage() {
    const input = document.getElementById("group-input");
    const text  = input.value.trim();
    if (!text) return;
    socket.emit("group-message", text);
    input.value = "";
    input.focus();
}

function appendGroupMessage(payload, isMe) {
    const area = document.getElementById("group-messages");
    if (!area) return;

    // Time separator if needed
    maybeInsertTimeSeparator(area, payload.time);

    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (isMe ? "msg-me" : "msg-them");

    if (!isMe) {
        wrap.innerHTML = `
          <div class="msg-av" style="background:${avatarColor(payload.senderName)}">${getInitials(payload.senderName)}</div>
          <div class="msg-body">
            <div class="msg-sender">${esc(payload.senderName)}</div>
            <div class="msg-bubble">${esc(payload.message)}</div>
            <div class="msg-time">${formatTime(payload.time)}</div>
          </div>
        `;
    } else {
        wrap.innerHTML = `
          <div class="msg-body">
            <div class="msg-bubble">${esc(payload.message)}</div>
            <div class="msg-time">${formatTime(payload.time)}</div>
          </div>
        `;
    }

    area.appendChild(wrap);
    animateIn(wrap);
    scrollToBottom("group-messages");
}

/* ════════════════════════════════════════════════════
   PRIVATE / DM CHAT
   ════════════════════════════════════════════════════ */
function refreshDMList() {
    const list = document.getElementById("dm-user-list");
    if (!list) return;
    list.innerHTML = "";

    Object.keys(userNames).forEach(id => {
        const name  = userNames[id];
        const item  = document.createElement("div");
        item.className = "dm-item";
        item.onclick   = () => openDM(id);
        item.innerHTML = `
          <div class="dm-av" style="background:${avatarColor(name)}">${getInitials(name)}</div>
          <div class="dm-info">
            <div class="dm-name">${esc(name)}</div>
            <div class="dm-hint">Tap to start private chat</div>
          </div>
          <i class="fa-solid fa-chevron-right dm-arrow"></i>
        `;
        list.appendChild(item);
    });

    if (list.children.length === 0) {
        list.innerHTML = `<div class="dm-empty">
          <i class="fa-solid fa-user-group"></i>
          <p>No other participants yet</p>
        </div>`;
    }
}

function openDM(userId) {
    activeDMId = userId;
    const name = userNames[userId] || "Unknown";

    // Show conversation pane
    document.getElementById("dm-pane")?.classList.add("hidden");
    const conv = document.getElementById("dm-conversation");
    conv?.classList.remove("hidden");

    // Set header
    document.getElementById("dm-conv-name").textContent = name;
    document.getElementById("dm-conv-avatar").textContent = getInitials(name);
    document.getElementById("dm-conv-avatar").style.background = avatarColor(name);

    // Render history
    const area = document.getElementById("dm-messages");
    if (area) {
        area.innerHTML = "";
        (dmHistory[userId] || []).forEach(m => appendDMMessage(m, m.isMe));
        if (area.children.length === 0) {
            area.innerHTML = `<div class="dm-no-msgs">
              <i class="fa-regular fa-comment-dots"></i>
              <p>Start the conversation with <strong>${esc(name)}</strong></p>
            </div>`;
        }
    }

    scrollToBottom("dm-messages");
    document.getElementById("dm-input")?.focus();

    // Switch to private tab
    switchTab("private");
    privateUnread = 0;
    updateUnreadBadges();
}

function closeDM() {
    activeDMId = null;
    document.getElementById("dm-conversation")?.classList.add("hidden");
    document.getElementById("dm-pane")?.classList.remove("hidden");
    refreshDMList();
}

function sendPrivateMessage() {
    const input = document.getElementById("dm-input");
    const text  = input.value.trim();
    if (!text || !activeDMId) return;
    socket.emit("private-message", activeDMId, text);
    input.value = "";
    input.focus();

    // Optimistic local append
    const payload = { senderName: username, message: text, time: Date.now() };
    if (!dmHistory[activeDMId]) dmHistory[activeDMId] = [];
    dmHistory[activeDMId].push({ ...payload, isMe: true });
    appendDMMessage(payload, true);

    // Clear "no messages" placeholder
    document.querySelector("#dm-messages .dm-no-msgs")?.remove();
}

function appendDMMessage(payload, isMe) {
    const area = document.getElementById("dm-messages");
    if (!area) return;

    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (isMe ? "msg-me" : "msg-them");

    if (!isMe) {
        wrap.innerHTML = `
          <div class="msg-av" style="background:${avatarColor(payload.senderName)}">${getInitials(payload.senderName)}</div>
          <div class="msg-body">
            <div class="msg-bubble dm-bubble">${esc(payload.message)}</div>
            <div class="msg-time">${formatTime(payload.time)}</div>
          </div>
        `;
    } else {
        wrap.innerHTML = `
          <div class="msg-body">
            <div class="msg-bubble dm-bubble">${esc(payload.message)}</div>
            <div class="msg-time">${formatTime(payload.time)}</div>
          </div>
        `;
    }

    area.appendChild(wrap);
    animateIn(wrap);
    scrollToBottom("dm-messages");
}

/* ════════════════════════════════════════════════════
   UNREAD BADGES
   ════════════════════════════════════════════════════ */
function updateUnreadBadges() {
    const gb = document.getElementById("badge-group");
    const pb = document.getElementById("badge-private");
    const cu = document.getElementById("ctrl-unread");

    if (gb) { gb.textContent = groupUnread || ""; gb.style.display = groupUnread ? "" : "none"; }
    if (pb) { pb.textContent = privateUnread || ""; pb.style.display = privateUnread ? "" : "none"; }

    const total = groupUnread + privateUnread;
    if (cu) { cu.textContent = total || ""; cu.style.display = total ? "flex" : "none"; }
}

/* ════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ════════════════════════════════════════════════════ */
let toastTimeout;
function showToast(msg, type = "info") {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = `toast toast-${type} toast-show`;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove("toast-show"), 3500);
}

/* ════════════════════════════════════════════════════
   INPUT BINDING
   ════════════════════════════════════════════════════ */
function bindInputs() {
    document.getElementById("group-input")?.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); sendGroupMessage(); }
    });
    document.getElementById("dm-input")?.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); sendPrivateMessage(); }
    });
}

/* ════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════ */
function esc(text = "") {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function pad(n) { return String(n).padStart(2, "0"); }

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(d) {
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function getInitials(name = "?") {
    return name.trim().split(/\s+/).map(w => w[0]).join("").substring(0, 2).toUpperCase();
}

const COLOR_PALETTE = ["#4f8ef7","#7c4dff","#00b894","#e17055","#fdcb6e","#a29bfe","#55efc4","#fd79a8"];
function avatarColor(name = "") {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

function scrollToBottom(id) {
    const el = document.getElementById(id);
    if (el) el.scrollTop = el.scrollHeight;
}

function animateIn(el) {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    requestAnimationFrame(() => {
        el.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
    });
}

let lastSeparatorDate = null;
function maybeInsertTimeSeparator(area, ts) {
    const d = new Date(ts);
    const key = d.toDateString();
    if (lastSeparatorDate !== key) {
        lastSeparatorDate = key;
        const sep = document.createElement("div");
        sep.className = "time-separator";
        sep.textContent = formatDate(d);
        area.appendChild(sep);
    }
}

/* ════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════ */
init();
