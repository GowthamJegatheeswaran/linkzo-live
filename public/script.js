/* ═══════════════════════════════════════════════════
   Linkzo Live · script.js
   Assignment: Video/Audio · Text Chat · Mute/Camera
   Extra: Screen Share · Group Chat · Private DM
          Call Timer · Participants Panel · Toast
          Mobile-friendly panel
   ═══════════════════════════════════════════════════ */

const socket   = io({ transports: ["websocket", "polling"] });
const roomId   = decodeURIComponent(new URLSearchParams(window.location.search).get("room") || "");
const username = localStorage.getItem("username") || "Guest";

document.getElementById("room-display").textContent = roomId;
document.getElementById("group-date-label").textContent = new Date().toLocaleDateString([],
    { weekday:"long", month:"long", day:"numeric" });

/* ── State ── */
let localStream       = null;
let screenStream      = null;
let peers             = {};
let pendingCandidates = {};
let userNames         = {};
let muteState         = {};
let camState          = {};
let participantCount  = 0;
let isMuted           = false;
let isCameraOn        = true;
let isSharingScreen   = false;
let callTimerInterval = null;
let activeTab         = "participants";
let activeDMId        = null;
let dmHistory         = {};
let groupUnread       = 0;
let privateUnread     = 0;
let dmUnread          = {};      // peerId → unread count (per-user, like WhatsApp)
let panelOpen         = false;   // starts CLOSED — opens when user taps Chat/People

/* ── ICE config ── */
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
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
};

/* ══════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════ */
async function init() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width:{ideal:1280}, height:{ideal:720}, facingMode:"user" },
            audio: { echoCancellation:true, noiseSuppression:true, sampleRate:48000 }
        });
    } catch (_) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
        } catch(e) {
            showToast("Cannot access camera/microphone. Check permissions.", "error");
            return;
        }
    }

    addVideoStream(localStream, "local", username);
    socket.emit("join-room", roomId, username);

    /* Hide screen share button on mobile (not supported in most mobile browsers) */
    if (!navigator.mediaDevices.getDisplayMedia) {
        const ssItem = document.getElementById("screenShareItem");
        if (ssItem) ssItem.style.display = "none";
    }

    bindInputs();
    renderParticipants();
}

/* ══════════════════════════════════════════════════
   SOCKET EVENTS
   ══════════════════════════════════════════════════ */

socket.on("existing-users", (users) => {
    users.forEach(u => {
        userNames[u.id] = u.username;
        muteState[u.id] = u.isMuted;
        camState[u.id]  = u.cameraOn;
        if (socket.id < u.id) connectToUser(u.id);
    });
    renderParticipants();
    refreshDMList();
});

socket.on("user-connected", (userId, name) => {
    userNames[userId] = name;
    if (socket.id < userId) connectToUser(userId);
    showToast(`${name} joined the meeting`, "join");
    renderParticipants();
    refreshDMList();
});

socket.on("offer", async (offer, senderId, senderName) => {
    userNames[senderId] = senderName;
    let peer = peers[senderId] || createPeer(senderId);
    try {
        await peer.setRemoteDescription(new RTCSessionDescription(offer));
        flushCandidates(senderId);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit("answer", answer, senderId);
    } catch(e) { console.warn("[offer]", e); }
});

socket.on("answer", async (answer, senderId) => {
    const peer = peers[senderId];
    if (!peer || peer.signalingState !== "have-local-offer") return;
    try {
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
        flushCandidates(senderId);
    } catch(e) { console.warn("[answer]", e); }
});

socket.on("ice-candidate", (candidate, senderId) => {
    const peer = peers[senderId];
    if (peer?.remoteDescription?.type) {
        peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    } else {
        if (!pendingCandidates[senderId]) pendingCandidates[senderId] = [];
        pendingCandidates[senderId].push(candidate);
    }
});

socket.on("user-disconnected", (userId) => {
    const name = userNames[userId] || "A participant";
    closePeer(userId);
    showToast(`${name} left the meeting`, "leave");
    renderParticipants();
    refreshDMList();
    if (activeDMId === userId) closeDM();
});

socket.on("participant-count", (count) => {
    participantCount = count;
    document.getElementById("participant-count").textContent = count;
    document.getElementById("pane-count").textContent        = count;
});

socket.on("call-started", (startTime) => {
    if (callTimerInterval) clearInterval(callTimerInterval);
    const el  = document.getElementById("call-duration");
    const dot = document.getElementById("statusDot");
    if (dot) dot.classList.add("active");
    callTimerInterval = setInterval(() => {
        const total = Math.floor((Date.now() - startTime) / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        el.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }, 1000);
});

socket.on("mute-status", (userId, muted) => {
    muteState[userId] = muted;
    const icon = document.getElementById("mute-icon-" + userId);
    if (icon) icon.style.display = muted ? "flex" : "none";
    renderParticipants();
});

socket.on("camera-status", (userId, isOn) => {
    camState[userId] = isOn;
    applyRemoteCam(userId, isOn);
    renderParticipants();
});

socket.on("screen-sharing", (userId, isSharing, sharerName) => {
    const banner     = document.getElementById("screenBanner");
    const bannerText = document.getElementById("screenBannerText");
    if (isSharing) {
        if (banner) { banner.style.display = "flex"; bannerText.textContent = `${sharerName} is sharing their screen`; }
        showToast(`${sharerName} started screen sharing`, "info");
    } else {
        if (banner) banner.style.display = "none";
        showToast(`${sharerName} stopped screen sharing`, "info");
    }
});

socket.on("group-message", (payload) => {
    const isMe = (payload.senderId === socket.id);
    appendGroupMsg(payload, isMe);
    if (!isMe) {
        if (activeTab !== "group" || !panelOpen) {
            groupUnread++;
            updateBadges();
        }
    }
});

socket.on("private-message", (payload) => {
    const sid = payload.senderId;
    if (!dmHistory[sid]) dmHistory[sid] = [];
    dmHistory[sid].push({ ...payload, isMe: false });
    if (activeDMId === sid && activeTab === "private" && panelOpen) {
        // Currently viewing this conversation — mark as read immediately
        appendDMMsg(payload, false);
    } else {
        // Not viewing — increment per-user AND total unread
        dmUnread[sid] = (dmUnread[sid] || 0) + 1;
        privateUnread++;
        updateBadges();
        refreshDMList();   // re-render DM list so badge shows on the right person
        showToast(`💬 ${payload.senderName}: ${payload.message.substring(0, 45)}`, "dm");
    }
});

socket.on("private-message-echo", (payload) => {
    const rid = payload.recipientId;
    if (!dmHistory[rid]) dmHistory[rid] = [];
    dmHistory[rid].push({ ...payload, isMe: true });
    if (activeDMId === rid && activeTab === "private" && panelOpen) {
        appendDMMsg({ ...payload, senderName: "You" }, true);
    }
});

/* ══════════════════════════════════════════════════
   PEER CONNECTIONS
   ══════════════════════════════════════════════════ */
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
        if (peer.connectionState === "failed" && socket.id < userId) peer.restartIce();
    };

    peers[userId] = peer;
    return peer;
}

async function connectToUser(userId) {
    const peer  = createPeer(userId);
    const offer = await peer.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await peer.setLocalDescription(offer);
    socket.emit("offer", offer, userId);
}

function flushCandidates(userId) {
    (pendingCandidates[userId] || []).forEach(c =>
        peers[userId]?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
    );
    delete pendingCandidates[userId];
}

function closePeer(userId) {
    peers[userId]?.close();
    delete peers[userId];
    delete pendingCandidates[userId];
    delete userNames[userId];
    delete muteState[userId];
    delete camState[userId];
    // Clean up any pending unread for this user
    if (dmUnread[userId]) {
        privateUnread = Math.max(0, privateUnread - dmUnread[userId]);
        delete dmUnread[userId];
        updateBadges();
    }
    document.getElementById("container-" + userId)?.remove();

    // Revert main video to local if needed
    const mv = document.getElementById("mainVideo");
    if (mv && !document.getElementById(userId)) {
        mv.srcObject = localStream;
        mv.muted = true;
        mv.classList.add("mirror");
        document.getElementById("mainVideoLabel").textContent = `You (${username})`;
    }
}

/* ══════════════════════════════════════════════════
   SCREEN SHARING
   ══════════════════════════════════════════════════ */
async function toggleScreenShare() {
    if (!isSharingScreen) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: "always" },
                audio: false
            });

            /* Replace video track in all existing peer connections */
            const screenTrack = screenStream.getVideoTracks()[0];
            Object.values(peers).forEach(peer => {
                const sender = peer.getSenders().find(s => s.track?.kind === "video");
                if (sender) sender.replaceTrack(screenTrack);
            });

            /* Show screen in main video locally */
            spotlightVideo("local", screenStream, `You (${username}) · Screen`);
            const mv = document.getElementById("mainVideo");
            if (mv) { mv.muted = true; mv.classList.remove("mirror"); }

            isSharingScreen = true;
            socket.emit("screen-sharing", true);

            /* Update button */
            const btn  = document.getElementById("btnScreen");
            const icon = btn?.querySelector("i");
            if (icon) icon.className = "fa-solid fa-display-slash";
            btn?.classList.add("ctrl-sharing");
            document.getElementById("lblScreen").textContent = "Stop Share";

            showToast("Screen sharing started", "info");

            /* Listen for user stopping share via browser UI */
            screenTrack.onended = () => stopScreenShare();

        } catch(e) {
            if (e.name !== "NotAllowedError") {
                showToast("Screen sharing not supported or denied", "error");
            }
        }
    } else {
        stopScreenShare();
    }
}

function stopScreenShare() {
    if (!isSharingScreen) return;

    /* Restore camera track in all peers */
    const camTrack = localStream.getVideoTracks()[0];
    Object.values(peers).forEach(peer => {
        const sender = peer.getSenders().find(s => s.track?.kind === "video");
        if (sender && camTrack) sender.replaceTrack(camTrack);
    });

    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    isSharingScreen = false;
    socket.emit("screen-sharing", false);

    /* Restore local video */
    spotlightVideo("local", localStream, `You (${username})`);
    const mv = document.getElementById("mainVideo");
    if (mv) { mv.muted = true; mv.classList.add("mirror"); }

    const btn  = document.getElementById("btnScreen");
    const icon = btn?.querySelector("i");
    if (icon) icon.className = "fa-solid fa-display";
    btn?.classList.remove("ctrl-sharing");
    document.getElementById("lblScreen").textContent = "Share";

    document.getElementById("screenBanner").style.display = "none";
    showToast("Screen sharing stopped", "info");
}

/* ══════════════════════════════════════════════════
   VIDEO UI
   ══════════════════════════════════════════════════ */
function addVideoStream(stream, id, name) {
    if (document.getElementById("container-" + id)) return;

    const outer = document.createElement("div");
    outer.className = "thumb-card";
    outer.id = "container-" + id;
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
    labelEl.textContent = id === "local" ? `You (${username})` : name;

    const muteEl = document.createElement("div");
    muteEl.className = "thumb-mute-icon";
    muteEl.id = "mute-icon-" + id;
    muteEl.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
    muteEl.style.display = (muteState[id] ? "flex" : "none");

    outer.append(video, labelEl, muteEl);
    document.getElementById("video-grid").appendChild(outer);

    /* Set main video: prefer remote */
    const mv = document.getElementById("mainVideo");
    if (mv && (!mv.srcObject || id !== "local")) {
        spotlightVideo(id, stream, id === "local" ? `You (${username})` : name);
    }

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
    document.querySelectorAll(".thumb-card").forEach(c => c.classList.remove("spotlit"));
    document.getElementById("container-" + id)?.classList.add("spotlit");
}

function applyRemoteCam(userId, isOn) {
    const cont   = document.getElementById("container-" + userId);
    const video  = document.getElementById(userId);
    const avatar = document.getElementById("avatar-" + userId);
    if (!cont) return;
    if (!isOn) {
        if (video) video.style.display = "none";
        if (!avatar) injectAvatar(cont, userId);
    } else {
        if (video) video.style.display = "";
        avatar?.remove();
    }
}

function injectAvatar(container, id) {
    const av = document.createElement("div");
    av.className = "thumb-avatar";
    av.id = "avatar-" + id;
    av.textContent = (id === "local" ? username : userNames[id] || "?").charAt(0).toUpperCase();
    container.appendChild(av);
}

/* ══════════════════════════════════════════════════
   MEDIA CONTROLS
   ══════════════════════════════════════════════════ */
function toggleMute() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    isMuted = !isMuted;
    track.enabled = !isMuted;
    muteState["local"] = isMuted;

    const btn  = document.getElementById("btnMute");
    const icon = btn?.querySelector("i");
    if (icon) icon.className = isMuted ? "fa-solid fa-microphone-slash" : "fa-solid fa-microphone";
    btn?.classList.toggle("ctrl-off", isMuted);
    document.getElementById("lblMute").textContent = isMuted ? "Unmute" : "Mute";

    const tm = document.getElementById("mute-icon-local");
    if (tm) tm.style.display = isMuted ? "flex" : "none";

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
    if (icon) icon.className = isCameraOn ? "fa-solid fa-video" : "fa-solid fa-video-slash";
    btn?.classList.toggle("ctrl-off", !isCameraOn);
    document.getElementById("lblVideo").textContent = isCameraOn ? "Camera" : "Start Cam";

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

/* ══════════════════════════════════════════════════
   PANEL  (desktop: sidebar / mobile: slide-over)
   ══════════════════════════════════════════════════ */
function openPanel() {
    panelOpen = true;
    const panel    = document.getElementById("sidePanel");
    const backdrop = document.getElementById("panelBackdrop");
    panel?.classList.add("panel-open");
    backdrop?.classList.add("backdrop-show");
}

function closePanel() {
    panelOpen = false;
    const panel    = document.getElementById("sidePanel");
    const backdrop = document.getElementById("panelBackdrop");
    panel?.classList.remove("panel-open");
    backdrop?.classList.remove("backdrop-show");
}

function togglePanel() {
    panelOpen ? closePanel() : openPanel();
}

function openGroupChat() {
    openPanel();
    switchTab("group");
}

function openPeople() {
    openPanel();
    switchTab("participants");
}

/* ══════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════ */
function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(p => p.classList.remove("active"));
    document.getElementById("tab-" + tab)?.classList.add("active");
    document.getElementById("pane-" + tab)?.classList.add("active");

    if (tab === "group")   { groupUnread   = 0; updateBadges(); scrollBottom("group-messages"); }
    if (tab === "private") { /* per-user badges clear when you open each DM — don't clear all here */ updateBadges(); }
    if (tab === "participants") renderParticipants();
}

/* ══════════════════════════════════════════════════
   PARTICIPANTS
   ══════════════════════════════════════════════════ */
function renderParticipants() {
    const list = document.getElementById("participants-list");
    if (!list) return;
    list.innerHTML = "";
    appendParticipantRow("local", `You (${username})`);
    Object.keys(userNames).forEach(id => appendParticipantRow(id, userNames[id]));
}

function appendParticipantRow(id, name) {
    const list    = document.getElementById("participants-list");
    const row     = document.createElement("div");
    row.className = "p-row";
    const micOff  = muteState[id];
    const camOff  = camState[id] === false;
    const isLocal = (id === "local");

    row.innerHTML = `
      <div class="p-av" style="background:${avatarColor(name)}">${getInitials(name)}</div>
      <div class="p-info">
        <div class="p-name">${esc(name)}</div>
        ${isLocal ? '<span class="p-you-tag">You</span>' : ""}
      </div>
      <div class="p-status">
        <span class="p-icon ${micOff?"off":""}">
          <i class="fa-solid ${micOff?"fa-microphone-slash":"fa-microphone"}"></i>
        </span>
        <span class="p-icon ${camOff?"off":""}">
          <i class="fa-solid ${camOff?"fa-video-slash":"fa-video"}"></i>
        </span>
        ${!isLocal ? `<button class="p-dm-btn" onclick="openDM('${id}')" title="DM"><i class="fa-solid fa-message"></i></button>` : ""}
      </div>`;
    list.appendChild(row);
}

/* ══════════════════════════════════════════════════
   GROUP CHAT
   ══════════════════════════════════════════════════ */
function sendGroupMessage() {
    const input = document.getElementById("group-input");
    const text  = input.value.trim();
    if (!text) return;
    socket.emit("group-message", text);
    input.value = "";
    input.focus();
}

function appendGroupMsg(payload, isMe) {
    const area = document.getElementById("group-messages");
    if (!area) return;
    const wrap = buildMsgBubble(payload, isMe, false);
    area.appendChild(wrap);
    animateIn(wrap);
    scrollBottom("group-messages");
}

/* ══════════════════════════════════════════════════
   PRIVATE DM
   ══════════════════════════════════════════════════ */
function refreshDMList() {
    const list = document.getElementById("dm-user-list");
    if (!list) return;
    list.innerHTML = "";
    const ids = Object.keys(userNames);
    if (ids.length === 0) {
        list.innerHTML = `<div class="dm-empty"><i class="fa-solid fa-user-group"></i><p>No other participants yet</p></div>`;
        return;
    }
    ids.forEach(id => {
        const name    = userNames[id];
        const unread  = dmUnread[id] || 0;
        const hist    = dmHistory[id] || [];
        const lastMsg = hist.length ? hist[hist.length - 1] : null;
        const preview = lastMsg
            ? (lastMsg.isMe ? "You: " + lastMsg.message : lastMsg.message)
            : "Tap to chat privately";

        const item = document.createElement("div");
        item.className = "dm-item" + (unread > 0 ? " dm-item-unread" : "");
        item.onclick   = () => openDM(id);
        item.innerHTML = `
          <div class="dm-av" style="background:${avatarColor(name)}">${getInitials(name)}</div>
          <div class="dm-info">
            <div class="dm-name-row">
              <span class="dm-name">${esc(name)}</span>
              ${lastMsg ? `<span class="dm-time">${fmtTime(lastMsg.time)}</span>` : ""}
            </div>
            <div class="dm-preview ${unread > 0 ? "dm-preview-bold" : ""}">${esc(preview.substring(0, 35))}${preview.length > 35 ? "\u2026" : ""}</div>
          </div>
          ${unread > 0 ? `<span class="dm-badge">${unread > 99 ? "99+" : unread}</span>` : '<i class="fa-solid fa-chevron-right dm-arrow"></i>'}`;
        list.appendChild(item);
    });
}

function openDM(userId) {
    activeDMId = userId;
    const name = userNames[userId] || "Unknown";
    document.getElementById("dm-pane")?.classList.add("hidden");
    document.getElementById("dm-conversation")?.classList.remove("hidden");
    document.getElementById("dm-conv-name").textContent    = name;
    document.getElementById("dm-conv-avatar").textContent  = getInitials(name);
    document.getElementById("dm-conv-avatar").style.background = avatarColor(name);

    const area = document.getElementById("dm-messages");
    if (area) {
        area.innerHTML = "";
        const hist = dmHistory[userId] || [];
        if (hist.length === 0) {
            area.innerHTML = `<div class="dm-no-msgs"><i class="fa-regular fa-comment-dots"></i><p>Start the conversation with <strong>${esc(name)}</strong></p></div>`;
        } else {
            hist.forEach(m => appendDMMsg(m, m.isMe));
        }
    }
    scrollBottom("dm-messages");
    document.getElementById("dm-input")?.focus();
    switchTab("private");
    // Clear this user's unread count — like WhatsApp marking as read
    const wasUnread = dmUnread[userId] || 0;
    dmUnread[userId] = 0;
    privateUnread = Math.max(0, privateUnread - wasUnread);
    updateBadges();
    refreshDMList();   // re-render list to remove badge from this user
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

    const payload = { senderName: username, message: text, time: Date.now() };
    if (!dmHistory[activeDMId]) dmHistory[activeDMId] = [];
    dmHistory[activeDMId].push({ ...payload, isMe: true });
    document.querySelector("#dm-messages .dm-no-msgs")?.remove();
    appendDMMsg(payload, true);
}

function appendDMMsg(payload, isMe) {
    const area = document.getElementById("dm-messages");
    if (!area) return;
    const wrap = buildMsgBubble(payload, isMe, true);
    area.appendChild(wrap);
    animateIn(wrap);
    scrollBottom("dm-messages");
}

/* shared bubble builder */
function buildMsgBubble(payload, isMe, isDM) {
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (isMe ? "msg-me" : "msg-them");
    const dmClass = isDM ? " dm-bubble" : "";
    if (!isMe) {
        wrap.innerHTML = `
          <div class="msg-av" style="background:${avatarColor(payload.senderName)}">${getInitials(payload.senderName)}</div>
          <div class="msg-body">
            <div class="msg-sender">${esc(payload.senderName)}</div>
            <div class="msg-bubble${dmClass}">${esc(payload.message)}</div>
            <div class="msg-time">${fmtTime(payload.time)}</div>
          </div>`;
    } else {
        wrap.innerHTML = `
          <div class="msg-body">
            <div class="msg-bubble${dmClass}">${esc(payload.message)}</div>
            <div class="msg-time">${fmtTime(payload.time)}</div>
          </div>`;
    }
    return wrap;
}

/* ══════════════════════════════════════════════════
   BADGES / TOAST
   ══════════════════════════════════════════════════ */
function updateBadges() {
    const gb = document.getElementById("badge-group");
    const pb = document.getElementById("badge-private");
    const cu = document.getElementById("ctrl-unread");
    setB(gb, groupUnread);
    setB(pb, privateUnread);
    const total = groupUnread + privateUnread;
    if (cu) { cu.textContent = total || ""; cu.style.display = total ? "flex" : "none"; }
}
function setB(el, n) { if (el) { el.textContent = n || ""; el.style.display = n ? "" : "none"; } }

let _toastT;
function showToast(msg, type = "info") {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className   = `toast toast-${type} toast-show`;
    if (_toastT) clearTimeout(_toastT);
    _toastT = setTimeout(() => el.classList.remove("toast-show"), 3500);
}

/* ══════════════════════════════════════════════════
   FULLSCREEN / PIP / END
   ══════════════════════════════════════════════════ */
function toggleFullscreen() {
    const w = document.getElementById("mainVideoWrap");
    if (!document.fullscreenElement) w?.requestFullscreen();
    else document.exitFullscreen();
}

async function togglePiP() {
    const v = document.getElementById("mainVideo");
    try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else {
            if (document.fullscreenElement) await document.exitFullscreen();
            await v.requestPictureInPicture();
        }
    } catch(e) {}
}

function endCall() {
    if (!confirm("Leave this meeting?")) return;
    if (isSharingScreen) stopScreenShare();
    localStream?.getTracks().forEach(t => t.stop());
    Object.values(peers).forEach(p => p.close());
    if (callTimerInterval) clearInterval(callTimerInterval);
    socket.disconnect();
    window.location.href = "/";
}

/* ══════════════════════════════════════════════════
   INPUT BINDING  (mobile-safe)
   ══════════════════════════════════════════════════ */
function bindInputs() {
    /* Use both keydown AND input event for mobile compatibility */
    const gi = document.getElementById("group-input");
    const di = document.getElementById("dm-input");

    if (gi) {
        gi.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); sendGroupMessage(); } });
        /* mobile "Go" / "Send" button fires this */
        gi.addEventListener("change", () => { if (gi.value.trim()) sendGroupMessage(); });
    }
    if (di) {
        di.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); sendPrivateMessage(); } });
        di.addEventListener("change", () => { if (di.value.trim()) sendPrivateMessage(); });
    }
}

/* ══════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════ */
function esc(t = "") {
    return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function pad(n)      { return String(n).padStart(2, "0"); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }); }
function getInitials(name = "?") {
    return name.trim().split(/\s+/).map(w => w[0]).join("").substring(0, 2).toUpperCase();
}
const COLORS = ["#4f8ef7","#7c4dff","#00b894","#e17055","#fdcb6e","#a29bfe","#55efc4","#fd79a8"];
function avatarColor(name = "") {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return COLORS[Math.abs(h) % COLORS.length];
}
function scrollBottom(id) { const el = document.getElementById(id); if (el) el.scrollTop = el.scrollHeight; }
function animateIn(el) {
    el.style.opacity = "0"; el.style.transform = "translateY(8px)";
    requestAnimationFrame(() => {
        el.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        el.style.opacity = "1"; el.style.transform = "translateY(0)";
    });
}

/* ══════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════ */
init();