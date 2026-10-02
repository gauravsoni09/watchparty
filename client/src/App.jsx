import { useState, useRef, useEffect } from "react";
import { io } from "socket.io-client";

const SERVER_URL = "http://localhost:3000";

// Keep one client across Vite hot updates so old managers do not keep reconnecting.
const socket = globalThis.__watchPartySocket || io(SERVER_URL, {
  transports: ["websocket", "polling"],
  autoConnect: true
});
globalThis.__watchPartySocket = socket;

// -----------------------------------------------------
// Decorative sprocket-hole strip — a nod to film stock,
// used as a structural divider rather than a generic rule.
// -----------------------------------------------------
function Sprockets({ className = "" }) {
  return (
    <div className={`flex gap-2 overflow-hidden ${className}`} aria-hidden="true">
      {Array.from({ length: 24 }).map((_, i) => (
        <span key={i} className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-[var(--border)]" />
      ))}
    </div>
  );
}

function App() {
  // =====================================================
  // THEME STATE
  // =====================================================
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "dark";
    return localStorage.getItem("watch-together-theme") || "dark";
  });

  useEffect(() => {
    try {
      localStorage.setItem("watch-together-theme", theme);
    } catch {
      // ignore storage failures (private browsing, etc.)
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  // =====================================================
  // LANDING PAGE STATE
  // =====================================================
  const [name, setName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(socket.connected);

  // =====================================================
  // ROOM & MEDIA STATE
  // =====================================================
  const [room, setRoom] = useState(null);
  const [videoURL, setVideoURL] = useState("");
  const [videoName, setVideoName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [removingVideo, setRemovingVideo] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  // =====================================================
  // CHAT STATE
  // =====================================================
  const [messages, setMessages] = useState([]);
  const [chatMessage, setChatMessage] = useState("");

  // =====================================================
  // MEMBERS & ROOM CODE STATE
  // =====================================================
  const [members, setMembers] = useState([]);
  const [hostId, setHostId] = useState(null);
  const [showMembers, setShowMembers] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // =====================================================
  // REFS
  // =====================================================
  const videoRef = useRef(null);
  const createNameRef = useRef(null);
  const joinNameRef = useRef(null);
  const roomCodeRef = useRef(null);
  const chatInputRef = useRef(null);
  const chatBottomRef = useRef(null);

  // Flag to suppress echoing native video events back to the server
  const isRemoteSync = useRef(false);

  // Kept in sync with `room` state so the "connect" handler below (set
  // up once, on mount) always sees the current room, not a stale one.
  const roomRef = useRef(null);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // The host's private token, used to reclaim host status after a
  // reconnect — see "resume-room" below. Guests never get one.
  const hostTokenRef = useRef(null);

  // =====================================================
  // SOCKET CONNECTION LIFECYCLE
  // =====================================================
  useEffect(() => {
    function handleConnect() {
      setConnected(true);
      setError("");

      // A fresh socket connection means a brand-new socket.id — wifi
      // blip, backgrounded tab, dev-server hot reload, etc. If we
      // already believe we're in a room, re-register this connection
      // with the server (and reclaim host status if we have the token)
      // rather than silently losing upload/playback permissions.
      const activeRoom = roomRef.current;
      if (!activeRoom) return;

      socket.emit(
        "resume-room",
        {
          roomId: activeRoom.roomId,
          name: activeRoom.name,
          hostToken: hostTokenRef.current
        },
        (res) => {
          if (!res?.ok) {
            setRoom(null);
            setError(res?.error || "Lost connection to the room.");
            return;
          }

          if (res.isHost && res.hostToken) {
            hostTokenRef.current = res.hostToken;
          }

          setRoom((prev) =>
            prev && prev.roomId === res.roomId ? { ...prev, isHost: res.isHost } : prev
          );
          setMembers(res.members || []);
          setHostId(res.hostId ?? null);
          setVideoURL(res.videoUrl || "");
          setVideoName(res.videoName || "");
        }
      );
    }

    function handleDisconnect() {
      setConnected(false);
      setRemovingVideo(false);
    }

    function handleConnectError(err) {
      console.error("Socket error:", err);
      setConnected(false);
      setError("Cannot connect to server. Ensure the backend is running.");
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
    };
  }, []);

  // =====================================================
  // AUTO-SCROLL CHAT
  // =====================================================
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // =====================================================
  // INCOMING SYNC & ROOM LISTENERS
  // =====================================================
  useEffect(() => {
    function handlePlay(data) {
      const video = videoRef.current;
      if (!video) return;

      isRemoteSync.current = true;
      if (typeof data.currentTime === "number") {
        if (Math.abs(video.currentTime - data.currentTime) > 0.3) {
          video.currentTime = data.currentTime;
        }
      }

      video
        .play()
        .then(() => setAutoplayBlocked(false))
        .catch(() => setAutoplayBlocked(true))
        .finally(() => {
          setTimeout(() => {
            isRemoteSync.current = false;
          }, 150);
        });
    }

    function handlePause(data) {
      const video = videoRef.current;
      if (!video) return;

      isRemoteSync.current = true;
      if (typeof data.currentTime === "number") {
        video.currentTime = data.currentTime;
      }
      video.pause();

      setTimeout(() => {
        isRemoteSync.current = false;
      }, 150);
    }

    function handleSeek(data) {
      const video = videoRef.current;
      if (!video) return;

      isRemoteSync.current = true;
      if (typeof data.currentTime === "number") {
        video.currentTime = data.currentTime;
      }

      setTimeout(() => {
        isRemoteSync.current = false;
      }, 150);
    }

    function handleVideoReady(data) {
      setVideoName(data.videoName || "");
      setVideoURL(data.videoUrl || "");
    }

    function handleVideoRemoved() {
      setVideoURL("");
      setVideoName("");
      setAutoplayBlocked(false);
    }

    function handleSyncState(data) {
      setVideoURL(data.videoUrl || "");
      setVideoName(data.videoName || "");

      const video = videoRef.current;
      if (!video || !data.playback) return;

      isRemoteSync.current = true;
      if (typeof data.playback.currentTime === "number") {
        video.currentTime = data.playback.currentTime;
      }

      if (data.playback.playing) {
        video
          .play()
          .then(() => setAutoplayBlocked(false))
          .catch(() => setAutoplayBlocked(true));
      } else {
        video.pause();
      }

      setTimeout(() => {
        isRemoteSync.current = false;
      }, 150);
    }

    function handleChatMessage(data) {
      setMessages((prev) => [...prev, { name: data.name, message: data.message }]);
    }

    function handleHostChanged(data) {
      setHostId(data.socketId);
      setRoom((prev) => (prev ? { ...prev, isHost: data.socketId === socket.id } : prev));
    }

    function handleHostToken(data) {
      if (data?.hostToken) {
        hostTokenRef.current = data.hostToken;
      }
    }

    function handleMemberJoined(data) {
      setMembers((prev) =>
        prev.some((m) => m.socketId === data.socketId)
          ? prev
          : [...prev, { name: data.name, socketId: data.socketId }]
      );
    }

    function handleMemberLeft(data) {
      setMembers((prev) => prev.filter((m) => m.socketId !== data.socketId));
    }

    function handleKicked(data) {
      setRoom(null);
      setVideoURL("");
      setVideoName("");
      setMessages([]);
      setMembers([]);
      setHostId(null);
      setShowMembers(false);
      hostTokenRef.current = null;
      setError(data?.reason || "You were removed from the room by the host.");
    }

    socket.on("play", handlePlay);
    socket.on("pause", handlePause);
    socket.on("seek", handleSeek);
    socket.on("video-ready", handleVideoReady);
    socket.on("video-removed", handleVideoRemoved);
    socket.on("sync-state", handleSyncState);
    socket.on("chat-message", handleChatMessage);
    socket.on("host-changed", handleHostChanged);
    socket.on("host-token", handleHostToken);
    socket.on("member-joined", handleMemberJoined);
    socket.on("member-left", handleMemberLeft);
    socket.on("kicked", handleKicked);

    return () => {
      socket.off("play", handlePlay);
      socket.off("pause", handlePause);
      socket.off("seek", handleSeek);
      socket.off("video-ready", handleVideoReady);
      socket.off("video-removed", handleVideoRemoved);
      socket.off("sync-state", handleSyncState);
      socket.off("chat-message", handleChatMessage);
      socket.off("host-changed", handleHostChanged);
      socket.off("host-token", handleHostToken);
      socket.off("member-joined", handleMemberJoined);
      socket.off("member-left", handleMemberLeft);
      socket.off("kicked", handleKicked);
    };
  }, []);

  // Request sync when entering a room
  useEffect(() => {
    if (!room) return;
    socket.emit("request-sync", { roomId: room.roomId });
  }, [room]);

  // =====================================================
  // ROOM CREATION & JOINING
  // =====================================================
  function createRoom() {
    setError("");
    const cleanName = name.trim();

    if (!cleanName) {
      setError("Please enter your name.");
      createNameRef.current?.focus();
      return;
    }

    if (!socket.connected) {
      setError("Server is not connected. Make sure the backend is active.");
      return;
    }

    socket.emit("create-room", { name: cleanName }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "Could not create room.");
        return;
      }
      hostTokenRef.current = res.hostToken || null;
      setRoom({ roomId: res.roomId, isHost: true, name: cleanName });
      setMembers(res.members || []);
      setHostId(res.hostId ?? null);
      setVideoURL(res.videoUrl || "");
      setVideoName(res.videoName || "");
      setMessages([]);
    });
  }

  function joinRoom(e) {
    e.preventDefault();
    setError("");
    const cleanName = joinName.trim();
    const code = roomCode.trim().toUpperCase();

    if (!cleanName) {
      setError("Please enter your name.");
      joinNameRef.current?.focus();
      return;
    }

    if (code.length !== 6) {
      setError("Room code must be 6 characters.");
      roomCodeRef.current?.focus();
      return;
    }

    if (!socket.connected) {
      setError("Server is not connected. Make sure the backend is active.");
      return;
    }

    socket.emit("enter-room", { roomId: code, name: cleanName, asHost: false }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "Could not join room.");
        return;
      }
      hostTokenRef.current = null;
      setRoom({ roomId: res.roomId, isHost: false, name: cleanName });
      setMembers(res.members || []);
      setHostId(res.hostId ?? null);
      setVideoURL(res.videoUrl || "");
      setVideoName(res.videoName || "");
      setMessages([]);
    });
  }

  // =====================================================
  // VIDEO UPLOAD HANDLER
  // =====================================================
  function removeVideo() {
    if (!room?.isHost || !videoURL || uploading || removingVideo) return;

    setError("");
    setRemovingVideo(true);
    socket.emit("remove-video", { roomId: room.roomId }, (res) => {
      setRemovingVideo(false);
      if (!res?.ok) {
        setError(res?.error || "Could not remove the video.");
      }
    });
  }

  async function selectVideo(e) {
    if (!room?.isHost) return;
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("video/")) {
      setError("Please select a valid video file.");
      return;
    }

    setError("");
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("video", file);
      formData.append("roomId", room.roomId);
      formData.append("socketId", socket.id);
      formData.append("hostToken", hostTokenRef.current || "");

      const response = await fetch(`${SERVER_URL}/api/upload-video`, {
        method: "POST",
        body: formData
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Video upload failed.");
      }

      setVideoURL(data.videoUrl);
      setVideoName(data.videoName);
    } catch (err) {
      setError(err.message || "Video upload failed.");
    } finally {
      setUploading(false);
    }
  }

  // =====================================================
  // PLAYBACK CONTROLS (HOST ONLY)
  // =====================================================
  function handlePlay() {
    if (!room?.isHost || isRemoteSync.current || !videoRef.current) return;
    socket.emit("play", { roomId: room.roomId, currentTime: videoRef.current.currentTime });
  }

  function handlePause() {
    if (!room?.isHost || isRemoteSync.current || !videoRef.current) return;
    socket.emit("pause", { roomId: room.roomId, currentTime: videoRef.current.currentTime });
  }

  function handleSeek() {
    if (!room?.isHost || isRemoteSync.current || !videoRef.current) return;
    socket.emit("seek", { roomId: room.roomId, currentTime: videoRef.current.currentTime });
  }

  function skipBackward() {
    if (!room?.isHost || !videoRef.current) return;
    const newTime = Math.max(0, videoRef.current.currentTime - 10);
    videoRef.current.currentTime = newTime;
    socket.emit("seek", { roomId: room.roomId, currentTime: newTime });
  }

  function skipForward() {
    if (!room?.isHost || !videoRef.current) return;
    const duration = Number.isFinite(videoRef.current.duration)
      ? videoRef.current.duration
      : videoRef.current.currentTime + 10;
    const newTime = Math.min(duration, videoRef.current.currentTime + 10);
    videoRef.current.currentTime = newTime;
    socket.emit("seek", { roomId: room.roomId, currentTime: newTime });
  }

  function togglePlayPause() {
    if (!room?.isHost || !videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(console.error);
    } else {
      videoRef.current.pause();
    }
  }

  function enterFullscreen() {
    if (videoRef.current?.requestFullscreen) {
      videoRef.current.requestFullscreen();
    }
  }

  function handleAutoplayUnlock() {
    if (!videoRef.current) return;
    videoRef.current
      .play()
      .then(() => setAutoplayBlocked(false))
      .catch(console.error);
  }

  // =====================================================
  // CHAT HANDLER
  // =====================================================
  function sendChatMessage(e) {
    e.preventDefault();
    const message = chatMessage.trim();
    if (!message || !room) return;

    socket.emit("chat-message", { roomId: room.roomId, name: room.name, message });
    setChatMessage("");
    chatInputRef.current?.focus();
  }

  // =====================================================
  // ROOM CODE & MEMBERS
  // =====================================================
  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.roomId);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      setError("Could not copy the room code — copy it manually instead.");
    }
  }

  function kickMember(targetSocketId) {
    if (!room?.isHost || !targetSocketId) return;
    socket.emit("kick-member", { roomId: room.roomId, targetSocketId }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "Could not remove that member.");
      }
    });
  }

  // Shared font import + color tokens. In a real build, move the @import
  // into index.html <link> tags for performance — kept inline here so the
  // component is drop-in runnable. Two full palettes live behind a
  // [data-theme] attribute so every class in the markup below just
  // references a CSS variable and never a raw hex value.
  const fontStyles = (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600;700&display=swap');
      .font-display { font-family: 'Libre Baskerville', 'Times New Roman', Georgia, serif; }
      .font-body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }

      .wt-app {
        -webkit-text-size-adjust: 100%;
        padding-top: env(safe-area-inset-top, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      @media (max-width: 380px) {
        .wt-app { font-size: 15px; }
      }

      .wt-app[data-theme="dark"] {
        --bg: #0D0B0A;
        --surface: #18140F;
        --surface-muted: #211B15;
        --border: #35302A;
        --divider: rgba(53, 48, 42, 0.6);
        --text: #F3E9D8;
        --text-soft: #DED2C2;
        --text-muted: #9C9086;
        --text-faint: #665e56;
        --accent: #D9A75B;
        --accent-hover: #e3b673;
        --accent-contrast: #18140F;
        --accent-badge-bg: rgba(217, 167, 91, 0.1);
        --accent-badge-border: rgba(217, 167, 91, 0.4);
        --danger-border: rgba(122, 46, 46, 0.5);
        --danger-bg: rgba(122, 46, 46, 0.15);
        --danger-text: #E7B3B3;
        --online: #7FA37F;
        --status-off: #B0453B;
        color-scheme: dark;
      }

      .wt-app[data-theme="light"] {
        --bg: #F1E8D6;
        --surface: #FBF5E7;
        --surface-muted: #EDE2C9;
        --border: #D9C9A3;
        --divider: rgba(199, 178, 138, 0.6);
        --text: #2A2117;
        --text-soft: #3D3122;
        --text-muted: #6E6047;
        --text-faint: #A0937A;
        --accent: #9A3B2E;
        --accent-hover: #B24C3D;
        --accent-contrast: #F8EFDD;
        --accent-badge-bg: rgba(154, 59, 46, 0.08);
        --accent-badge-border: rgba(154, 59, 46, 0.35);
        --danger-border: rgba(154, 59, 46, 0.4);
        --danger-bg: rgba(154, 59, 46, 0.1);
        --danger-text: #7A2A1F;
        --online: #4E7A4F;
        --status-off: #9A3B2E;
        color-scheme: light;
      }
    `}</style>
  );

  // =====================================================
  // ROOM VIEW
  // =====================================================
  if (room) {
    return (
      <div className="wt-app font-body min-h-screen w-full overflow-x-hidden bg-[var(--bg)] text-[var(--text)] transition-colors duration-300" data-theme={theme}>
        {fontStyles}
        <div className="max-w-7xl mx-auto px-4 py-5 sm:px-6 sm:py-8 md:px-10">
          {/* TOP HEADER */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-5 sm:mb-6">
            <div>
              <p className="text-[11px] tracking-wide text-[var(--text-muted)]">Now screening</p>
              <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight">Watch Together</h1>
            </div>

            <div className="flex items-center justify-between sm:justify-end gap-3">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                className="h-11 w-11 shrink-0 border border-[var(--border)] bg-[var(--surface)] rounded-sm flex items-center justify-center text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
              >
                {theme === "dark" ? "☀" : "☾"}
              </button>

              <button
                type="button"
                onClick={() => setShowMembers((s) => !s)}
                aria-expanded={showMembers}
                title="See who's in the room"
                className={`h-11 shrink-0 border rounded-sm flex items-center gap-2 px-4 text-sm font-medium transition ${
                  showMembers
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-badge-bg)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                }`}
              >
                <span aria-hidden="true">☺</span>
                <span>{members.length}</span>
              </button>

              <button
                type="button"
                onClick={copyRoomCode}
                title="Copy room code"
                className="group border border-[var(--border)] bg-[var(--surface)] rounded-sm px-5 py-2.5 text-right hover:border-[var(--accent)] transition"
              >
                <p className="text-[10px] tracking-wide text-[var(--text-muted)] flex items-center justify-end gap-1.5">
                  Room code
                  <span className="text-[var(--text-faint)] group-hover:text-[var(--accent)] transition">
                    {codeCopied ? "copied ✓" : "copy ⧉"}
                  </span>
                </p>
                <p className="font-display text-lg sm:text-xl font-bold tracking-[0.15em] sm:tracking-[0.2em] text-[var(--accent)]">
                  {room.roomId}
                </p>
              </button>
            </div>
          </div>

          {/* MEMBERS PANEL */}
          {showMembers && (
            <div className="border border-[var(--border)] bg-[var(--surface)] rounded-sm mb-5 sm:mb-6 divide-y divide-[var(--divider)] overflow-hidden">
              {members.length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--text-muted)]">
                  Just you in here so far.
                </p>
              ) : (
                members.map((m) => (
                  <div
                    key={m.socketId}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {m.socketId === hostId && (
                        <span title="Host" className="text-[var(--accent)] shrink-0">
                          ♛
                        </span>
                      )}
                      <span className="truncate text-sm font-medium">
                        {m.name}
                        {m.socketId === socket.id && (
                          <span className="text-[var(--text-faint)] font-normal"> (you)</span>
                        )}
                      </span>
                    </div>

                    {room.isHost && m.socketId !== socket.id && (
                      <button
                        type="button"
                        onClick={() => kickMember(m.socketId)}
                        className="shrink-0 text-xs font-semibold text-[var(--danger-text)] border border-[var(--danger-border)] rounded-sm px-3 py-1.5 hover:bg-[var(--danger-bg)] transition"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          <Sprockets className="mb-6" />

          {/* USER INFO BAR */}
          <div className="border border-[var(--border)] bg-[var(--surface)] rounded-sm px-5 py-3.5 mb-6 flex items-center justify-between flex-wrap gap-3">
            <p className="text-[var(--text-muted)] text-sm">
              Watching as <span className="text-[var(--text)] font-medium">{room.name}</span>
            </p>
            <span
              className={`px-3 py-1 rounded-sm text-xs font-medium border ${
                room.isHost
                  ? "border-[var(--accent-badge-border)] bg-[var(--accent-badge-bg)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-muted)]"
              }`}
            >
              {room.isHost ? "Host" : "Guest"}
            </span>
          </div>

          {/* CONNECTION ALERTS */}
          {!connected && (
            <div className="border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] rounded-sm px-4 py-3 mb-4 text-sm">
              Connection lost. Reconnecting to the server…
            </div>
          )}

          {error && (
            <div className="border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] rounded-sm px-4 py-3 mb-4 text-sm">
              {error}
            </div>
          )}

          {/* MAIN ROOM CONTENT */}
          <div className="grid gap-5 sm:gap-6 items-start lg:grid-cols-[1fr_340px]">
            {/* VIDEO PLAYER CONTAINER */}
            <div className="border border-[var(--border)] bg-[var(--surface)] rounded-sm overflow-hidden">
              <div className="relative bg-black aspect-video w-full flex items-center justify-center">
                {videoURL ? (
                  <>
                    <video
                      ref={videoRef}
                      src={videoURL}
                      controls={room.isHost}
                      className="w-full h-full object-contain"
                      onPlay={handlePlay}
                      onPause={handlePause}
                      onSeeked={handleSeek}
                    />
                    {autoplayBlocked && !room.isHost && (
                      <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-6 text-center z-10">
                        <p className="font-display text-base sm:text-lg font-bold mb-2">
                          The host has started the film
                        </p>
                        <p className="text-sm text-[var(--text-muted)] mb-5 max-w-sm">
                          Your browser needs a tap before it will play sound and video.
                        </p>
                        <button
                          onClick={handleAutoplayUnlock}
                          className="bg-[var(--accent)] text-[var(--accent-contrast)] font-semibold px-6 py-2.5 rounded-sm hover:bg-[var(--accent-hover)] transition"
                        >
                          Sync &amp; play
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center px-6">
                    <Sprockets className="mb-6 justify-center" />
                    <h2 className="font-display text-xl sm:text-2xl font-bold">
                      {room.isHost ? "Select a film to begin" : "Waiting on the host"}
                    </h2>
                    <p className="text-[var(--text-muted)] mt-2 text-sm max-w-xs mx-auto">
                      {room.isHost
                        ? "Upload a video below to open tonight's screening."
                        : "Playback will start here the moment the host uploads something."}
                    </p>
                  </div>
                )}
              </div>

              {/* VIDEO STATUS BAR */}
              <div className="p-5 border-t border-[var(--border)] flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[11px] text-[var(--text-muted)]">Currently playing</p>
                  <p className="font-medium mt-1 max-w-md truncate">
                    {videoName || "Nothing queued yet"}
                  </p>
                </div>

                {room.isHost && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <label
                      htmlFor="video-file"
                      className={`inline-block font-semibold px-5 py-2.5 rounded-sm transition text-sm ${
                        uploading || removingVideo
                          ? "bg-[var(--surface-muted)] text-[var(--text-faint)] cursor-not-allowed"
                          : "bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] cursor-pointer"
                      }`}
                    >
                      {uploading ? "Uploading…" : "Upload video"}
                    </label>
                    <input
                      id="video-file"
                      type="file"
                      accept="video/*"
                      className="hidden"
                      disabled={uploading || removingVideo}
                      onChange={selectVideo}
                    />
                    {videoURL && (
                      <button
                        type="button"
                        onClick={removeVideo}
                        disabled={uploading || removingVideo}
                        className="border border-[var(--danger-border)] px-4 py-2.5 rounded-sm text-sm font-medium text-[var(--danger-text)] hover:border-[var(--status-off)] disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        {removingVideo ? "Removing…" : "Remove video"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* HOST QUICK CONTROLS */}
              {room.isHost && videoURL && !uploading && (
                <div className="px-5 pb-5 flex items-center gap-2.5 flex-wrap border-t border-[var(--divider)] pt-4">
                  <button
                    onClick={skipBackward}
                    className="border border-[var(--border)] px-4 py-2 rounded-sm text-sm font-medium hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
                  >
                    ⟲ 10s
                  </button>
                  <button
                    onClick={togglePlayPause}
                    className="bg-[var(--accent)] text-[var(--accent-contrast)] px-6 py-2 rounded-sm text-sm font-semibold hover:bg-[var(--accent-hover)] transition"
                  >
                    Play / Pause
                  </button>
                  <button
                    onClick={skipForward}
                    className="border border-[var(--border)] px-4 py-2 rounded-sm text-sm font-medium hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
                  >
                    10s ⟳
                  </button>
                </div>
              )}

              {/* PARTICIPANT CONTROLS */}
              {!room.isHost && videoURL && (
                <div className="px-5 pb-5 border-t border-[var(--divider)] pt-4">
                  <button
                    onClick={enterFullscreen}
                    className="border border-[var(--border)] px-5 py-2.5 rounded-sm text-sm font-medium hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
                  >
                    ⛶ Fullscreen
                  </button>
                </div>
              )}
            </div>

            {/* LIVE CHAT BOX */}
            <div className="border border-[var(--border)] bg-[var(--surface)] rounded-sm overflow-hidden flex flex-col h-[420px] sm:h-[480px] lg:h-[560px]">
              <div className="px-5 py-4 border-b border-[var(--border)]">
                <h2 className="font-display text-lg font-bold">Live chat</h2>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[var(--bg)]">
                {messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-[var(--text-faint)] text-sm text-center px-6">
                    No messages yet — say something before the lights go down.
                  </div>
                ) : (
                  messages.map((item, idx) => (
                    <div key={idx} className="bg-[var(--surface)] border border-[var(--divider)] rounded-sm px-4 py-2.5">
                      <p className="text-xs font-semibold text-[var(--accent)]">{item.name}</p>
                      <p className="text-[var(--text-soft)] text-sm mt-0.5 break-words">{item.message}</p>
                    </div>
                  ))
                )}
                <div ref={chatBottomRef} />
              </div>

              <form onSubmit={sendChatMessage} className="p-3 border-t border-[var(--border)] flex gap-2">
                <input
                  ref={chatInputRef}
                  type="text"
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  placeholder="Type a message…"
                  className="min-w-0 flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-sm px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)] transition placeholder:text-[var(--text-faint)]"
                />
                <button
                  type="submit"
                  className="bg-[var(--accent)] text-[var(--accent-contrast)] font-semibold px-4 py-2.5 rounded-sm hover:bg-[var(--accent-hover)] text-sm transition"
                >
                  Send
                </button>
              </form>
            </div>
          </div>

          {/* FOOTER */}
          <footer className="mt-12 pt-6 border-t border-[var(--border)] text-center text-xs text-[var(--text-faint)]">
            Watch Together — made by <span className="text-[var(--text-muted)]">Gaurav Soni</span>
          </footer>
        </div>
      </div>
    );
  }

  // =====================================================
  // LANDING PAGE VIEW
  // =====================================================
  return (
    <div className="wt-app font-body min-h-screen w-full overflow-x-hidden bg-[var(--bg)] text-[var(--text)] transition-colors duration-300" data-theme={theme}>
      {fontStyles}

      <header className="max-w-6xl mx-auto px-4 py-5 sm:px-6 sm:py-7 md:px-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-sm bg-[var(--accent)] text-[var(--accent-contrast)] flex items-center justify-center font-display font-bold text-lg">
            W
          </div>
          <div>
            <p className="font-display font-bold text-base leading-none">Watch Together</p>
            <p className="text-[11px] text-[var(--text-muted)] mt-1 hidden sm:block">A private room for one film, two remotes</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[var(--online)]" : "bg-[var(--status-off)]"}`}
            />
            {connected ? "Server online" : "Server offline"}
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            className="h-10 w-10 shrink-0 border border-[var(--border)] bg-[var(--surface)] rounded-sm flex items-center justify-center text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10">
        <section className="pt-10 pb-10 sm:pt-16 sm:pb-14 max-w-2xl">
          <p className="text-[var(--accent)] text-xs tracking-wide mb-4 sm:mb-5">A synced screening room</p>
          <h2 className="font-display text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.1] sm:leading-[1.05] tracking-tight">
            Same film. Same moment.
            <br />
            Different couches.
          </h2>
          <p className="mt-5 sm:mt-6 text-[var(--text-muted)] text-sm sm:text-base leading-relaxed max-w-lg">
            Open a room, upload something from your own library, and hand out a six-letter code.
            Play, pause, and seek stay perfectly in step for everyone who joins — plus a chat
            running alongside the screen for the commentary.
          </p>
        </section>

        <Sprockets className="mb-8 sm:mb-10" />

        <section className="grid gap-5 sm:gap-6 pb-10 sm:pb-16 md:grid-cols-2">
          {/* CREATE ROOM CARD */}
          <div className="border border-[var(--border)] bg-[var(--surface)] rounded-sm p-6 sm:p-8">
            <p className="text-[11px] text-[var(--text-muted)] mb-2">01 — Start a screening</p>
            <h3 className="font-display text-xl sm:text-2xl font-bold">Create a room</h3>
            <p className="text-[var(--text-muted)] mt-2 text-sm leading-relaxed">
              You'll hold the remote — playback, seeking, and the video itself are all yours to
              control.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
              }}
              className="mt-6"
            >
              <label className="block text-xs text-[var(--text-muted)] mb-2">Your name</label>
              <input
                ref={createNameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Kanu"
                maxLength={24}
                className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-sm px-4 py-3 text-sm outline-none focus:border-[var(--accent)] transition placeholder:text-[var(--text-faint)]"
              />
              <button
                type="button"
                onClick={createRoom}
                className="w-full mt-5 bg-[var(--accent)] text-[var(--accent-contrast)] font-semibold py-3 rounded-sm hover:bg-[var(--accent-hover)] transition cursor-pointer text-sm"
              >
                Create room
              </button>
            </form>
          </div>

          {/* JOIN ROOM CARD */}
          <div className="border border-[var(--border)] bg-[var(--surface)] rounded-sm p-6 sm:p-8">
            <p className="text-[11px] text-[var(--text-muted)] mb-2">02 — Join a friend</p>
            <h3 className="font-display text-xl sm:text-2xl font-bold">Enter a room</h3>
            <p className="text-[var(--text-muted)] mt-2 text-sm leading-relaxed">
              Ask your host for their six-character code and drop in — the film will already be
              waiting.
            </p>

            <form onSubmit={joinRoom} className="mt-6">
              <label className="block text-xs text-[var(--text-muted)] mb-2">Your name</label>
              <input
                ref={joinNameRef}
                type="text"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="e.g. Gaurav"
                maxLength={24}
                className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-sm px-4 py-3 text-sm outline-none focus:border-[var(--accent)] transition placeholder:text-[var(--text-faint)]"
              />

              <label className="block text-xs text-[var(--text-muted)] mt-4 mb-2">Room code</label>
              <input
                ref={roomCodeRef}
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
                className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-sm px-4 py-3 text-sm uppercase tracking-[0.2em] outline-none focus:border-[var(--accent)] transition placeholder:text-[var(--text-faint)] placeholder:tracking-[0.2em]"
              />

              <button
                type="submit"
                disabled={!connected}
                className="w-full mt-5 border border-[var(--border)] py-3 rounded-sm font-semibold text-sm hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text)] transition"
              >
                {connected ? "Join room" : "Connecting to server…"}
              </button>
            </form>
          </div>
        </section>

        {error && (
          <div className="border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] rounded-sm px-4 py-3 mb-10 text-sm max-w-2xl">
            {error}
          </div>
        )}

        <footer className="border-t border-[var(--border)] py-8 text-center text-xs text-[var(--text-faint)]">
          Watch Together — made by <span className="text-[var(--text-muted)]">Gaurav Soni</span>
        </footer>
      </main>
    </div>
  );
}

export default App;