const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const kelimeler = {
  HAYVANLAR: ["kedi", "köpek", "aslan", "balık", "fares"],
  YIYECEKLER: ["elma", "erik", "armut", "muz", "üzüm"],
  RENKLER: ["mavi", "sarı", "beyaz", "siyah", "yeşil"],
};

const rooms = {};
const waitingPlayers = {};
const rematchRequests = {};

function makeBotPlayer() {
  return { id: `bot_${Date.now()}`, nickname: "BOT", isBot: true };
}

function isBotPlayer(p) {
  return p && p.isBot === true;
}

function pickBotGuess(room) {
  const list = kelimeler[room.kategori];
  return list[Math.floor(Math.random() * list.length)];
}

function getRenkler(kelime, dogruKelime) {
  const renkler = Array(5).fill("absent");
  const dogru = dogruKelime.split("");
  const tahmin = kelime.split("");

  for (let i = 0; i < 5; i++) {
    if (tahmin[i] === dogru[i]) {
      renkler[i] = "correct";
      dogru[i] = null;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (renkler[i] === "correct") continue;
    const index = dogru.indexOf(tahmin[i]);
    if (index !== -1) {
      renkler[i] = "present";
      dogru[index] = null;
    }
  }

  return renkler;
}

function findRoomByPlayerId(id) {
  return Object.entries(rooms).find(([_, room]) =>
    room.players.some((p) => p.id === id)
  )?.[0];
}

function processGuess({ socketId, tahmin, odaKodu }) {
  const roomKey = odaKodu || findRoomByPlayerId(socketId);
  if (!roomKey) return;

  const room = rooms[roomKey];
  if (!room || room.players.length < 2) return;

  const current = room.players[room.turnIndex];
  const other = room.players[1 - room.turnIndex];

  if (current.id !== socketId) return;

  const renkler = getRenkler(tahmin, room.kelime);
  io.to(roomKey).emit("opponent_guess", tahmin, renkler);

  if (tahmin === room.kelime) {
    if (isBotPlayer(current)) {
      if (!isBotPlayer(other)) io.to(other.id).emit("game_result", "Kaybettiniz 😢");
    } else {
      io.to(current.id).emit("game_result", "Kazandınız 🎉");
      if (!isBotPlayer(other)) io.to(other.id).emit("game_result", "Kaybettiniz 😢");
    }
    return;
  }

  room.turnIndex = 1 - room.turnIndex;

  const nowCurrent = room.players[room.turnIndex];
  const nowOther = room.players[1 - room.turnIndex];

  if (!isBotPlayer(nowCurrent)) io.to(nowCurrent.id).emit("your_turn", true);
  if (!isBotPlayer(nowOther)) io.to(nowOther.id).emit("your_turn", false);

  if (isBotPlayer(nowCurrent)) {
    setTimeout(() => {
      const r = rooms[roomKey];
      if (!r) return;
      const cur = r.players[r.turnIndex];
      if (!isBotPlayer(cur)) return;
      const botTahmin = pickBotGuess(r);
      processGuess({ socketId: cur.id, tahmin: botTahmin, odaKodu: roomKey });
    }, 900);
  }
}

io.on("connection", (socket) => {
  socket.on("join_game", ({ kategori, nickname }) => {
    if (!kategori || !nickname) return;

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler[upperKategori]) return;

    if (!waitingPlayers[upperKategori]) waitingPlayers[upperKategori] = [];
    const queue = waitingPlayers[upperKategori];

    if (queue.some((p) => p.id === socket.id)) return;

    if (queue.length > 0) {
      const rakip = queue.shift();
      if (rakip.id === socket.id) return;

      const odaKodu = Math.random().toString(36).substring(2, 7);
      const kelime =
        kelimeler[upperKategori][
          Math.floor(Math.random() * kelimeler[upperKategori].length)
        ];

      rooms[odaKodu] = {
        kategori: upperKategori,
        kelime,
        turnIndex: 0,
        players: [
          { id: rakip.id, nickname: rakip.nickname },
          { id: socket.id, nickname },
        ],
      };

      socket.join(odaKodu);
      io.sockets.sockets.get(rakip.id)?.join(odaKodu);

      const [p1, p2] = rooms[odaKodu].players;

      io.to(p1.id).emit("match_found", kelime);
      io.to(p2.id).emit("match_found", kelime);

      io.to(p1.id).emit("your_turn", true);
      io.to(p2.id).emit("your_turn", false);

      io.to(p1.id).emit("nickname_info", { sen: p1.nickname, rakip: p2.nickname });
      io.to(p2.id).emit("nickname_info", { sen: p2.nickname, rakip: p1.nickname });
    } else {
      queue.push({ id: socket.id, nickname });
    }
  });

  socket.on("join_game_with_code", ({ odaKodu, kategori, nickname }) => {
    if (!odaKodu || !kategori || !nickname) return;

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler[upperKategori]) return;

    if (!rooms[odaKodu]) {
      rooms[odaKodu] = {
        kategori: upperKategori,
        kelime: kelimeler[upperKategori][Math.floor(Math.random() * kelimeler[upperKategori].length)],
        turnIndex: 0,
        players: [{ id: socket.id, nickname }],
      };
      socket.join(odaKodu);
      return;
    }

    if (rooms[odaKodu].players.length >= 2) {
      socket.emit("error", "Oda dolu.");
      return;
    }

    if (rooms[odaKodu].players.some((p) => p.id === socket.id)) return;

    rooms[odaKodu].players.push({ id: socket.id, nickname });
    socket.join(odaKodu);

    const [p1, p2] = rooms[odaKodu].players;
    const kelime = rooms[odaKodu].kelime;

    io.to(p1.id).emit("match_found", kelime);
    io.to(p2.id).emit("match_found", kelime);

    io.to(p1.id).emit("your_turn", true);
    io.to(p2.id).emit("your_turn", false);

    io.to(p1.id).emit("nickname_info", { sen: p1.nickname, rakip: p2.nickname });
    io.to(p2.id).emit("nickname_info", { sen: p2.nickname, rakip: p1.nickname });
  });

  socket.on("play_vs_bot", ({ kategori, nickname }) => {
    if (!kategori || !nickname) return;

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler[upperKategori]) return;

    const odaKodu = Math.random().toString(36).substring(2, 7);
    const kelime =
      kelimeler[upperKategori][
        Math.floor(Math.random() * kelimeler[upperKategori].length)
      ];
    const bot = makeBotPlayer();

    rooms[odaKodu] = {
      kategori: upperKategori,
      kelime,
      turnIndex: 0,
      players: [{ id: socket.id, nickname, isBot: false }, bot],
    };

    socket.join(odaKodu);

    socket.emit("match_found", kelime);
    socket.emit("your_turn", true);
    socket.emit("nickname_info", { sen: nickname, rakip: "BOT" });
  });

  socket.on("guess", ({ tahmin, odaKodu }) => {
    processGuess({ socketId: socket.id, tahmin, odaKodu });
  });

  socket.on("rematch_request", () => {
    const odaKodu = findRoomByPlayerId(socket.id);
    if (!odaKodu) return;

    const room = rooms[odaKodu];
    if (!room) return;

    const rakip = room.players.find((p) => p.id !== socket.id);

    if (rakip && isBotPlayer(rakip)) {
      room.kelime =
        kelimeler[room.kategori][
          Math.floor(Math.random() * kelimeler[room.kategori].length)
        ];
      room.turnIndex = 0;

      socket.emit("match_found", room.kelime);
      socket.emit("your_turn", true);
      socket.emit("nickname_info", { sen: room.players[0].nickname, rakip: "BOT" });
      return;
    }

    rematchRequests[socket.id] = odaKodu;
    if (rakip) io.to(rakip.id).emit("rematch_request");
  });

  socket.on("rematch_response", (cevap) => {
    const odaKodu = rematchRequests[socket.id];
    if (!odaKodu) return;

    const room = rooms[odaKodu];
    if (!room) return;

    const rakip = room.players.find((p) => p.id !== socket.id);
    if (rakip) io.to(rakip.id).emit("rematch_response", cevap);

    if (cevap === "yes") {
      room.kelime =
        kelimeler[room.kategori][
          Math.floor(Math.random() * kelimeler[room.kategori].length)
        ];
      room.turnIndex = 0;

      const [p1, p2] = room.players;

      io.to(p1.id).emit("match_found", room.kelime);
      io.to(p2.id).emit("match_found", room.kelime);

      io.to(p1.id).emit("your_turn", true);
      io.to(p2.id).emit("your_turn", false);

      io.to(p1.id).emit("nickname_info", { sen: p1.nickname, rakip: p2.nickname });
      io.to(p2.id).emit("nickname_info", { sen: p2.nickname, rakip: p1.nickname });
    }

    delete rematchRequests[socket.id];
  });

  socket.on("disconnect", () => {
    for (const kategori in waitingPlayers) {
      waitingPlayers[kategori] = waitingPlayers[kategori].filter(
        (p) => p.id !== socket.id
      );
    }

    const odaKodu = findRoomByPlayerId(socket.id);
    if (odaKodu) {
      const room = rooms[odaKodu];
      const kalan = room.players.find((p) => p.id !== socket.id);
      if (kalan && !isBotPlayer(kalan)) io.to(kalan.id).emit("opponent_left");
      delete rooms[odaKodu];
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
