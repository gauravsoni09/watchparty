require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

const app = express();

app.use(cors());

app.get("/", (req, res) => {
  res.send("Watch Party Server is running!");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});


// ======================================================
// CLOUDINARY CONFIG
// ======================================================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

console.log("Cloudinary credentials loaded:", {
  cloud_name: Boolean(process.env.CLOUDINARY_CLOUD_NAME),
  api_key: Boolean(process.env.CLOUDINARY_API_KEY),
  api_secret: Boolean(process.env.CLOUDINARY_API_SECRET)
});


// ======================================================
// CLOUDINARY UPLOAD
// ======================================================

function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    const config = cloudinary.config();

    console.log("Cloudinary config loaded:", {
      cloud_name: Boolean(config.cloud_name),
      api_key: Boolean(config.api_key),
      api_secret: Boolean(config.api_secret)
    });

    const uploadStream =
      cloudinary.uploader.upload_chunked_stream(
        {
          ...options,
          chunk_size: 20 * 1024 * 1024
        },
        (error, result) => {

          if (error) {
            return reject(error);
          }

          resolve(result);
        }
      );

    streamifier
      .createReadStream(buffer)
      .pipe(uploadStream);
  });
}


// ======================================================
// DELETE VIDEO FROM CLOUDINARY
// ======================================================

async function deleteFromCloudinary(
  publicId,
  assetId,
  versionId
) {

  if (!publicId) return;

  try {

    if (assetId && versionId) {

      const backupResult =
        await cloudinary.api.delete_backed_up_assets(
          assetId,
          [versionId]
        );

      console.log(
        "Cloudinary backup delete result:",
        backupResult
      );
    }

    const result =
      await cloudinary.uploader.destroy(
        publicId,
        {
          resource_type: "video",
          type: "upload",
          invalidate: true
        }
      );

    console.log(
      "Cloudinary delete result:",
      {
        publicId,
        result: result.result
      }
    );

  } catch (error) {

    console.error(
      "Cloudinary delete failed:",
      error.message
    );

  }
}


// ======================================================
// MULTER
// ======================================================

const upload = multer({

  storage: multer.memoryStorage(),

  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {

    if (
      file.mimetype &&
      file.mimetype.startsWith("video/")
    ) {

      cb(null, true);

    } else {

      cb(
        new Error(
          "Only video files are allowed."
        )
      );

    }
  }
});


// ======================================================
// ROOMS
// ======================================================

const rooms = new Map();


// ======================================================
// GENERATE ROOM CODE
// ======================================================

function generateRoomCode() {

  const characters =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 6; i++) {

    code +=
      characters[
        Math.floor(
          Math.random() * characters.length
        )
      ];
  }

  return code;
}


// ======================================================
// GENERATE UNIQUE ROOM CODE
// ======================================================

function generateUniqueRoomCode() {

  let roomId;

  do {

    roomId = generateRoomCode();

  } while (rooms.has(roomId));

  return roomId;
}


// ======================================================
// CREATE ROOM
// ======================================================

function createRoom(socket, name) {

  const roomId =
    generateUniqueRoomCode();

  const room = {

    adminId: socket.id,

    hostToken: crypto
      .randomBytes(16)
      .toString("hex"),

    videoName: "",

    videoUrl: "",

    videoFile: "",

    videoAssetId: "",

    videoVersionId: "",

    playback: {

      playing: false,

      currentTime: 0
    },

    members: new Map()
  };

  rooms.set(roomId, room);

  socket.join(roomId);

  room.members.set(socket.id, {

    name: name,

    socketId: socket.id
  });

  socket.roomId = roomId;

  console.log(
    "Room created:",
    roomId
  );

  console.log(
    `${name} joined room ${roomId}`
  );

  return {

    ok: true,

    roomId: roomId,

    isHost: true,

    hostToken:
      room.hostToken,

    hostId:
      room.adminId,

    videoName:
      room.videoName,

    videoUrl:
      room.videoUrl,

    playback:
      room.playback,

    members: Array.from(
      room.members.values()
    )
  };
}


// ======================================================
// UPLOAD VIDEO
// ======================================================

app.post(
  "/api/upload-video",
  upload.single("video"),

  async (req, res) => {

    try {

      const {
        roomId,
        socketId
      } = req.body;


      // ------------------------------
      // ROOM ID CHECK
      // ------------------------------

      if (!roomId) {

        return res.status(400).json({

          ok: false,

          error:
            "Room ID is required."
        });
      }


      // ------------------------------
      // FIND ROOM
      // ------------------------------

      const room =
        rooms.get(roomId);

      if (!room) {

        return res.status(404).json({

          ok: false,

          error:
            "Room does not exist."
        });
      }


      // ------------------------------
      // HOST CHECK
      // ------------------------------

      if (
        room.adminId !== socketId
      ) {

        return res.status(403).json({

          ok: false,

          error:
            "Only the host can upload a video."
        });
      }


      // ------------------------------
      // FILE CHECK
      // ------------------------------

      if (!req.file) {

        return res.status(400).json({

          ok: false,

          error:
            "No video file was uploaded."
        });
      }


      // ------------------------------
      // PREVIOUS VIDEO
      // ------------------------------

      const previousPublicId =
        room.videoFile;

      const previousAssetId =
        room.videoAssetId;

      const previousVersionId =
        room.videoVersionId;


      // ------------------------------
      // UNIQUE FILE NAME
      // ------------------------------

      const uniqueSuffix =
        crypto
          .randomBytes(8)
          .toString("hex");


      console.log(
        "Starting Cloudinary upload..."
      );


      // ------------------------------
      // CLOUDINARY UPLOAD
      // ------------------------------

      const result =
        await uploadBufferToCloudinary(
          req.file.buffer,
          {

            resource_type: "video",

            folder:
              `watch-party/${roomId}`,

            public_id:
              `${Date.now()}-${uniqueSuffix}`,

            overwrite: false
          }
        );


      console.log(
        "Cloudinary upload successful."
      );


      // ------------------------------
      // DELETE OLD VIDEO
      // ------------------------------

      await deleteFromCloudinary(
        previousPublicId,
        previousAssetId,
        previousVersionId
      );


      // ------------------------------
      // SAVE VIDEO DATA
      // ------------------------------

      room.videoFile =
        result.public_id;

      room.videoAssetId =
        result.asset_id;

      room.videoVersionId =
        result.version_id;

      room.videoName =
        req.file.originalname;

      room.videoUrl =
        result.secure_url;


      // ------------------------------
      // TELL EVERYONE
      // ------------------------------

      io.to(roomId).emit(
        "video-ready",
        {

          videoName:
            room.videoName,

          videoUrl:
            room.videoUrl
        }
      );


      console.log(
        `Video uploaded for room ${roomId}: ${room.videoName}`
      );


      return res.json({

        ok: true,

        videoName:
          room.videoName,

        videoUrl:
          room.videoUrl
      });

    } catch (error) {

      console.error(
        "Upload error:",
        error
      );

      return res.status(500).json({

        ok: false,

        error:
          "Video upload failed."
      });
    }
  }
);


// ======================================================
// SOCKET CONNECTION
// ======================================================

io.on(
  "connection",
  (socket) => {

    console.log(
      "User connected:",
      socket.id
    );


    // ==================================================
    // CREATE ROOM
    // ==================================================

    socket.on(
      "create-room",
      (data, callback) => {

        const name =
          data?.name?.trim();

        if (!name) {

          callback({

            ok: false,

            error:
              "Name is required."
          });

          return;
        }

        const result =
          createRoom(
            socket,
            name
          );

        callback(result);
      }
    );


    // ==================================================
    // ENTER ROOM
    // ==================================================

    socket.on(
      "enter-room",
      (data, callback) => {

        const roomId =
          data?.roomId
            ?.trim()
            .toUpperCase();

        const name =
          data?.name?.trim();


        if (
          !roomId ||
          !name
        ) {

          callback({

            ok: false,

            error:
              "Room ID and name are required."
          });

          return;
        }


        const room =
          rooms.get(roomId);


        if (!room) {

          callback({

            ok: false,

            error:
              "Room does not exist."
          });

          return;
        }


        socket.join(roomId);


        room.members.set(
          socket.id,
          {

            name: name,

            socketId:
              socket.id
          }
        );


        socket.roomId =
          roomId;


        callback({

          ok: true,

          roomId: roomId,

          isHost:
            room.adminId ===
            socket.id,

          hostId:
            room.adminId,

          videoName:
            room.videoName,

          videoUrl:
            room.videoUrl,

          playback:
            room.playback,

          members:
            Array.from(
              room.members.values()
            )
        });


        socket.to(roomId).emit(
          "member-joined",
          {

            name: name,

            socketId:
              socket.id
          }
        );


        console.log(
          `${name} joined room ${roomId}`
        );
      }
    );


    // ==================================================
    // RESUME ROOM
    // ==================================================

    socket.on(
      "resume-room",
      (data, callback) => {

        const roomId =
          data?.roomId
            ?.trim()
            .toUpperCase();

        const name =
          data?.name?.trim();

        const hostToken =
          data?.hostToken;


        if (
          !roomId ||
          !name
        ) {

          callback?.({

            ok: false,

            error:
              "Room ID and name are required."
          });

          return;
        }


        const room =
          rooms.get(roomId);


        if (!room) {

          callback?.({

            ok: false,

            error:
              "Room does not exist."
          });

          return;
        }


        socket.join(roomId);


        room.members.set(
          socket.id,
          {

            name: name,

            socketId:
              socket.id
          }
        );


        socket.roomId =
          roomId;


        const reclaimsHost =
          hostToken &&
          room.hostToken ===
            hostToken;


        if (reclaimsHost) {

          room.adminId =
            socket.id;
        }


        const isHost =
          room.adminId ===
          socket.id;


        callback?.({

          ok: true,

          roomId: roomId,

          isHost: isHost,

          hostToken: isHost
            ? room.hostToken
            : undefined,

          hostId:
            room.adminId,

          videoName:
            room.videoName,

          videoUrl:
            room.videoUrl,

          playback:
            room.playback,

          members:
            Array.from(
              room.members.values()
            )
        });


        if (reclaimsHost) {

          io.to(roomId).emit(
            "host-changed",
            {

              socketId:
                socket.id
            }
          );
        }


        console.log(
          `${name} resumed room ${roomId}${
            isHost
              ? " as host"
              : ""
          }`
        );
      }
    );


    // ==================================================
    // VIDEO SELECTED
    // ==================================================

    socket.on(
      "video-selected",
      (data) => {

        const roomId =
          socket.roomId;

        const room =
          rooms.get(roomId);

        if (!room) return;


        // Only host
        if (
          room.adminId !==
          socket.id
        ) {

          return;
        }


        room.videoName =
          data.videoName;


        io.to(roomId).emit(
          "video-selected",
          {

            videoName:
              data.videoName
          }
        );
      }
    );


    // ==================================================
    // PLAY
    // ==================================================

    socket.on(
      "play",
      (data) => {

        const roomId =
          socket.roomId;

        const room =
          rooms.get(roomId);

        if (!room) return;


        // Only host
        if (
          room.adminId !==
          socket.id
        ) {

          return;
        }


        room.playback = {

          playing: true,

          currentTime:
            Number(
              data?.currentTime ||
                0
            )
        };


        socket.to(roomId).emit(
          "play",
          {

            currentTime:
              room.playback
                .currentTime
          }
        );
      }
    );


    // ==================================================
    // PAUSE
    // ==================================================

    socket.on(
      "pause",
      (data) => {

        const roomId =
          socket.roomId;

        const room =
          rooms.get(roomId);

        if (!room) return;


        // Only host
        if (
          room.adminId !==
          socket.id
        ) {

          return;
        }


        room.playback = {

          playing: false,

          currentTime:
            Number(
              data?.currentTime ||
                0
            )
        };


        socket.to(roomId).emit(
          "pause",
          {

            currentTime:
              room.playback
                .currentTime
          }
        );
      }
    );


    // ==================================================
    // SEEK
    // ==================================================

    socket.on(
      "seek",
      (data) => {

        const roomId =
          socket.roomId;

        const room =
          rooms.get(roomId);

        if (!room) return;


        // Only host
        if (
          room.adminId !==
          socket.id
        ) {

          return;
        }


        room.playback.currentTime =
          Number(
            data?.currentTime ||
              0
          );


        socket.to(roomId).emit(
          "seek",
          {

            currentTime:
              room.playback
                .currentTime
          }
        );
      }
    );


    // ==================================================
    // REQUEST SYNC
    // ==================================================

    socket.on(
      "request-sync",
      () => {

        const roomId =
          socket.roomId;

        const room =
          rooms.get(roomId);

        if (!room) return;


        socket.emit(
          "sync-state",
          {

            videoName:
              room.videoName,

            videoUrl:
              room.videoUrl,

            playback:
              room.playback
          }
        );
      }
    );


    // ==================================================
    // CHAT MESSAGE
    // ==================================================

    socket.on(
      "chat-message",
      (data) => {

        const roomId =
          socket.roomId;

        const room =
          rooms.get(roomId);

        if (!room) return;


        const member =
          room.members.get(
            socket.id
          );


        if (!member) return;


        const message =
          String(
            data?.message || ""
          ).trim();


        if (!message) return;


        io.to(roomId).emit(
          "chat-message",
          {

            name:
              member.name,

            message:
              message
          }
        );
      }
    );


    // ==================================================
    // REMOVE / KICK MEMBER
    // ==================================================

    socket.on(
      "kick-member",
      (data, callback) => {

        const roomId =
          data?.roomId;

        const targetSocketId =
          data?.targetSocketId;


        // ----------------------------------------------
        // FIND ROOM
        // ----------------------------------------------

        const room =
          rooms.get(roomId);


        if (!room) {

          callback?.({

            ok: false,

            error:
              "Room does not exist."
          });

          return;
        }


        // ----------------------------------------------
        // ONLY HOST CAN REMOVE
        // ----------------------------------------------

        if (
          room.adminId !==
          socket.id
        ) {

          callback?.({

            ok: false,

            error:
              "Only the host can remove members."
          });

          return;
        }


        // ----------------------------------------------
        // HOST CANNOT REMOVE HIMSELF
        // ----------------------------------------------

        if (
          targetSocketId ===
          socket.id
        ) {

          callback?.({

            ok: false,

            error:
              "You cannot remove yourself."
          });

          return;
        }


        // ----------------------------------------------
        // CHECK MEMBER
        // ----------------------------------------------

        if (
          !room.members.has(
            targetSocketId
          )
        ) {

          callback?.({

            ok: false,

            error:
              "Member is not in this room."
          });

          return;
        }


        // ----------------------------------------------
        // GET MEMBER INFO
        // ----------------------------------------------

        const removedMember =
          room.members.get(
            targetSocketId
          );


        // ----------------------------------------------
        // REMOVE FROM ROOM
        // ----------------------------------------------

        room.members.delete(
          targetSocketId
        );


        // ----------------------------------------------
        // FIND TARGET SOCKET
        // ----------------------------------------------

        const targetSocket =
          io.sockets.sockets.get(
            targetSocketId
          );


        if (targetSocket) {

          // Remove from Socket.IO room
          targetSocket.leave(
            roomId
          );


          // Clear room ID
          targetSocket.roomId =
            null;


          // Tell the removed user
          targetSocket.emit(
            "kicked",
            {

              reason:
                "You were removed from the room by the host."
            }
          );
        }


        // ----------------------------------------------
        // UPDATE REMAINING MEMBERS
        // ----------------------------------------------

        io.to(roomId).emit(
          "member-left",
          {

            name:
              removedMember?.name,

            socketId:
              targetSocketId
          }
        );


        // ----------------------------------------------
        // SUCCESS RESPONSE
        // ----------------------------------------------

        callback?.({

          ok: true
        });


        console.log(
          `Member ${targetSocketId} was removed from room ${roomId}`
        );
      }
    );


    // ==================================================
    // DISCONNECT
    // ==================================================

    socket.on(
      "disconnect",
      async () => {

        console.log(
          "User disconnected:",
          socket.id
        );


        const roomId =
          socket.roomId;


        if (!roomId) return;


        const room =
          rooms.get(roomId);


        if (!room) return;


        const member =
          room.members.get(
            socket.id
          );


        room.members.delete(
          socket.id
        );


        // ----------------------------------------------
        // NO MEMBERS LEFT
        // ----------------------------------------------

        if (room.members.size === 0) {

          await deleteFromCloudinary(
            room.videoFile,
            room.videoAssetId,
            room.videoVersionId
          );


          rooms.delete(
            roomId
          );


          console.log(
            "Room deleted:",
            roomId
          );


          return;
        }


        // ----------------------------------------------
        // HOST DISCONNECTED
        // ----------------------------------------------

        if (
          room.adminId ===
          socket.id
        ) {

          const nextMember =
            room.members
              .values()
              .next()
              .value;


          // --------------------------------------------
          // GIVE HOST TO NEXT MEMBER
          // --------------------------------------------

          if (nextMember) {

            room.adminId =
              nextMember.socketId;


            io.to(roomId).emit(
              "host-changed",
              {

                socketId:
                  nextMember.socketId
              }
            );

          }

        }


        // ----------------------------------------------
        // TELL OTHER MEMBERS
        // ----------------------------------------------

        io.to(roomId).emit(
          "member-left",
          {

            name:
              member?.name,

            socketId:
              socket.id
          }
        );
      }
    );
  }
);


// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (error, req, res, next) => {

    console.error(
      "Server error:",
      error.message
    );


    if (
      error instanceof
      multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res
          .status(400)
          .json({

            ok: false,

            error:
              "Video is too large. Maximum size is 2GB."
          });
      }
    }


    return res
      .status(400)
      .json({

        ok: false,

        error:
          error.message ||
          "Something went wrong."
      });
  }
);


// ======================================================
// START SERVER
// ======================================================

server.listen(
  3000,
  () => {

    console.log(
      "Server running at http://localhost:3000"
    );

  }
);