import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import Peer from "simple-peer";
import "./AudioCallRecorder.css";

const socket = io("https://f227-2409-40d2-114e-ed08-b090-7954-96d0-6a9.ngrok-free.app"); // Ensure this is your current ngrok URL

const AudioCallRecorder = () => {
  const myVideo = useRef();
  const userVideo = useRef();
  const connectionRef = useRef(null); // Initialize with null
  const mediaStream = useRef(null); // Initialize with null
  const recorderRef = useRef(null); // Initialize with null
  const [recording, setRecording] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [peerInitialized, setPeerInitialized] = useState(false); // New state to track peer setup

  // This effect handles signaling
  useEffect(() => {
    socket.on("signal", ({ from, signal }) => {
      console.log(`Received signal from: ${from}`);
      if (connectionRef.current && connectionRef.current.remoteId === from) {
        // If the peer connection for this 'from' user is already established, just signal
        connectionRef.current.signal(signal);
      } else {
        // This case handles a signal arriving before a peer is fully set up,
        // or a signal from a new, unexpected peer.
        // It implies that `setupPeer` should have been called by `user-joined` or `initiate-call`
        // before signals start flowing. If a signal arrives and connectionRef.current is null
        // or not for the correct remoteId, there might be a timing issue.
        console.warn(`Signal received from ${from} but no active peer connection or mismatched peerId.`);
        // To be safer, you might want to buffer signals and apply them once the peer is ready,
        // or re-evaluate the sequence of events that leads to peer creation.
        // For now, if the peer isn't ready, this signal might be dropped, which is
        // what likely causes the "sometimes it works" issue.
        // A more robust solution might involve:
        // 1. Storing incoming signals in a queue if `connectionRef.current` is null.
        // 2. Applying buffered signals once `connectionRef.current` is set up.
      }
    });

    // Cleanup on unmount or re-render
    return () => {
      socket.off("signal");
      socket.off("user-joined");
      socket.off("initiate-call");
      if (connectionRef.current) {
        connectionRef.current.destroy();
        connectionRef.current = null;
      }
      if (mediaStream.current) {
        mediaStream.current.getTracks().forEach(track => track.stop());
        mediaStream.current = null;
      }
    };
  }, []);

  const handleJoinRoom = async () => {
    if (!roomId) return;
    setJoined(true); // Set joined immediately to show video elements

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mediaStream.current = stream;

      if (myVideo.current) {
        myVideo.current.srcObject = stream;
        myVideo.current.muted = true;
        myVideo.current.setAttribute("playsinline", true);
        await myVideo.current.play().catch((e) => console.warn("Local video play failed:", e));
      }

      socket.emit("join-room", roomId);

      socket.on("user-joined", ({ from }) => {
        console.log("👋 A user was already in the room. You are the initiator.");
        setupPeer(true, from, mediaStream.current);
      });

      socket.on("initiate-call", ({ from }) => {
        console.log("📞 Another user is joining. You are the receiver.");
        setupPeer(false, from, mediaStream.current);
      });

    } catch (err) {
      alert("Error accessing webcam/mic: " + err.message);
      console.error(err);
      setJoined(false); // Reset joined state if media access fails
    }
  };

  const setupPeer = (initiator, targetId, stream) => {
    // If a peer connection already exists, destroy it before creating a new one
    if (connectionRef.current) {
      console.log("Destroying existing peer connection for new setup.");
      connectionRef.current.destroy();
      connectionRef.current = null; // Clear the ref
    }

    console.log(`🔗 Setting up peer connection. Initiator: ${initiator}, Target: ${targetId}`);
    const peer = new Peer({ initiator, trickle: false, stream });

    peer.on("signal", (data) => {
      console.log("📤 Sending signal", data);
      socket.emit("signal", { to: targetId, from: socket.id, signal: data });
    });

    peer.on("stream", (remoteStream) => {
      console.log("📺 Received remote stream", remoteStream);
      if (userVideo.current) {
        userVideo.current.srcObject = remoteStream;
        userVideo.current.setAttribute("playsinline", true);
        userVideo.current.play().catch((e) => console.warn("Remote video play failed:", e));
      }
    });

    peer.on("connect", () => {
      console.log("🟢 Peer connected");
    });

    peer.on("close", () => {
      console.log("🔴 Peer closed");
      // Handle peer disconnection (e.g., clear userVideo, notify user)
    });

    peer.on("error", (err) => {
      console.error("❌ Peer error:", err);
      // Handle peer errors
    });

    connectionRef.current = peer;
    connectionRef.current.remoteId = targetId; // Store the ID of the remote peer
    setPeerInitialized(true); // Indicate that the peer has been set up
  };

  const startRecording = () => {
    if (!mediaStream.current) {
      console.error("Cannot start recording: No media stream available.");
      return;
    }
    const audioOnlyStream = new MediaStream(mediaStream.current.getAudioTracks());
    const recorder = new MediaRecorder(audioOnlyStream);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        const formData = new FormData();
        formData.append("audio", e.data);
        // Old:
        // formData.append("userId", socket.id);
        // formData.append("roomId", roomId);
        // fetch("http://localhost:5000/upload", { ... });

        // New:
        // const uploadUrl = `http://localhost:5000/upload?roomId=<span class="math-inline">\{encodeURIComponent\(roomId\)\}&userId\=</span>{encodeURIComponent(socket.id)}`;
        const uploadUrl = 'http://localhost:5000/upload' +
                  '?roomId=' + encodeURIComponent(roomId) +
                  '&userId=' + encodeURIComponent(socket.id);
        fetch(uploadUrl, {
            method: "POST",
            body: formData,
        })
          .then(response => response.json())
          .then(data => console.log("Upload success:", data))
          .catch(error => console.error("Upload error:", error));
      }
    };

    recorder.start(5000);
    recorderRef.current = recorder;
    setRecording(true);
  };

  const stopRecording = () => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      setRecording(false);
    }
  };

  return (
    <div className="call-container">
      <h1>🎙 Riverside Clone MVP</h1>

      {!joined ? (
        <div className="room-join">
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Enter Room ID"
          />
          <button onClick={handleJoinRoom}>Join Room</button>
        </div>
      ) : (
        <>
          <div className="videos">
            <div>
              <h4>You</h4>
              {/* Added playsInline */}
              <video ref={myVideo} autoPlay muted playsInline className="video-box" />
            </div>
            <div>
              <h4>Guest</h4>
              {/* Added playsInline */}
              <video ref={userVideo} autoPlay playsInline className="video-box" />
            </div>
          </div>

          <div className="controls">
            {!recording ? (
              <button className="record-btn" onClick={startRecording}>
                🎙 Start Audio Recording
              </button>
            ) : (
              <button className="stop-btn" onClick={stopRecording}>
                🛑 Stop Recording
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default AudioCallRecorder;