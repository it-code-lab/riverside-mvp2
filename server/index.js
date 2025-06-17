const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded, if needed for other routes

// Define the base directory for uploads
const uploadDir = path.join(__dirname, "..", "uploads");

// Ensure the base upload directory exists
if (!fs.existsSync(uploadDir)) {
    console.log(`Creating base upload directory: ${uploadDir}`);
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Retrieve roomId and userId from req.query as they are sent as URL parameters
    // Using default 'unknown-room' and 'unknown-user' if not provided
    const roomId = req.query.roomId || "unknown-room";
    const userId = req.query.userId || "unknown-user";

    const userName = req.query.userName || "unknown-user";

    // Construct the full path using path.join for OS compatibility
    const folder = path.join(uploadDir, roomId, userName);
    
    console.log(`[Multer Destination] Attempting to create folder: ${folder}`);
    // Ensure the specific user/room directory exists recursively
    try {
      fs.mkdirSync(folder, { recursive: true });
      cb(null, folder);
    } catch (err) {
      console.error(`[Multer Destination ERROR] Failed to create directory ${folder}:`, err);
      // Pass the error to Multer, which will then pass it to the route handler
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `audio-${timestamp}.webm`);
  },
});

const upload = multer({ storage });

app.post("/upload", upload.single("audio"), (req, res) => {
  // Use req.query for logging userId and roomId, as they are passed in the URL
  const loggedRoomId = req.query.roomId || 'unknown-room';
  const loggedUserId = req.query.userId || 'unknown-user';
  const loggedUserName = req.query.userName || "unknown-user";

  // Check if a file was actually processed by multer
  if (req.file) {
    console.log(`[UPLOAD SUCCESS] User ${loggedUserId} uploaded to ${req.file.path} in room ${loggedRoomId}`);
    res.json({ 
        status: "ok", 
        file: req.file.filename, 
        path: req.file.path,
        roomId: loggedRoomId,
        userId: loggedUserId
    });
  } else {
    // This block runs if multer failed to process the file (e.g., due to destination error)
    console.error(`[UPLOAD FAILED] No file processed. Room ID: ${loggedRoomId}, User ID: ${loggedUserId}. Error: ${req.multerError ? req.multerError.message : 'Unknown Multer error'}`);
    res.status(500).json({ 
        status: "error", 
        message: "File upload failed or no file received.",
        error: req.multerError ? req.multerError.message : 'Unknown error',
        roomId: loggedRoomId,
        userId: loggedUserId
    });
  }
});

const rooms = {}; // Map socket.id to roomId for easier lookup on disconnect

io.on("connection", (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  socket.on("join-room", (roomId) => {
    // Leave any previously joined room
    if (rooms[socket.id]) {
      console.log(`⬅️ ${socket.id} leaving previous room ${rooms[socket.id]}`);
      socket.leave(rooms[socket.id]);
    }

    socket.join(roomId);
    console.log(`📥 ${socket.id} joined room ${roomId}`);
    rooms[socket.id] = roomId; // Store the room ID for this socket

    const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    console.log(`👥 Clients in ${roomId}:`, clientsInRoom);

    // Signaling logic for 1:1 call setup
    if (clientsInRoom.length === 2) {
      const [user1, user2] = clientsInRoom;
      console.log(`🔄 Pairing ${user1} ↔ ${user2}`);
      // If user2 just joined and user1 was already there:
      // Tell user2 (the new user) to initiate a call to user1 (the existing user)
      io.to(user2).emit("user-joined", { from: user1 });
      // Tell user1 (the existing user) that user2 is joining, so user1 acts as receiver
      io.to(user1).emit("initiate-call", { from: user2 });
    } else if (clientsInRoom.length > 2) {
        // Handle more than two clients gracefully (e.g., ignore or implement multi-party logic)
        console.warn(`Room ${roomId} has more than 2 clients. Current logic supports 1:1 calls.`);
    }
  });

  socket.on("signal", ({ to, from, signal }) => {
    console.log(`📡 Signal relayed from ${from} to ${to}`);
    // Relay the signal to the target socket
    io.to(to).emit("signal", { from, signal });
  });

  socket.on("disconnect", () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
    const roomId = rooms[socket.id];
    if (roomId) {
      console.log(`🚪 ${socket.id} leaving room ${roomId} on disconnect.`);
      io.to(roomId).emit("stop-recording"); // broadcast to everyone in the room
      delete rooms[socket.id]; // Remove from our custom room tracking

        // 🔁 Trigger merging after slight delay (to let final chunks upload)
        setTimeout(() => {
            const { exec } = require("child_process");
            const mergeScript = path.join(__dirname, "..", "mergeRecordings.js");

            const cmd = `node "${mergeScript}" "${roomId}"`;

            console.log(`🛠️ Running merge script: ${cmd}`);
            exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Merge script error: ${error.message}`);
                return;
            }
            if (stderr) console.warn(`⚠️ Merge stderr: ${stderr}`);
            console.log(`✅ Merge completed:\n${stdout}`);
            });
        }, 8000); // wait 8 seconds to ensure last chunk uploads

    }
  });

  socket.on("end-session", ({ roomId }) => {
  console.log(`📢 Ending session for room: ${roomId}`);
  io.to(roomId).emit("stop-recording"); // broadcast to everyone in the room
});

});

server.listen(5000, () => console.log("✅ Server running on http://localhost:5000"));

// Serve static files from the client's build directory
const clientBuildPath = path.join(__dirname, "..", "client", "build");
// Check if client build path exists before serving static files
if (fs.existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));

    // For any other GET request, serve the client's index.html
    app.get("*", (req, res) => {
        res.sendFile(path.join(clientBuildPath, "index.html"));
    });
} else {
    console.warn("⚠️ Client build directory not found. Please run 'npm run build' or 'yarn build' in your client directory.");
    app.get("/", (req, res) => {
        res.send("<h1>Server is running!</h1><p>Client build not found. Please build your React app.</p>");
    });
}
