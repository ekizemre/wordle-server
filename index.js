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
  HAYVANLAR: ["aslan", "köpek", "tilki", "zebra", "geyik"],
  YIYECEKLER: ["armut", "biber", "ekmek", "limon", "helva"],
  RENKLER: ["beyaz", "siyah", "yeşil", "morun"],
};

const WORD_LEN = 5;

function normalize(w) {
  return (w || "").toString().trim().toLowerCase();
}

function isValidWord(w) {
  return normalize(w).length === WORD_LEN;
}

const kelimeler5 = Object.fromEntries(
  Object.entries(kelimeler).map(([kat, arr]) => [
    kat,
    (arr || []).map(normalize).filter(isValidWord),
  ])
);

function pickRandomWord(kategoriKey) {
  const list = kelimeler5[kategoriKey] || [];
  if (list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

const rooms = {};
const waitingPlayers = {};
const rematchRequests = {};
const playerRoom = {};

function makeBotPlayer() {
  return { id: `bot_${Date.now()}`, nickname: "BOT", isBot: true };
}

function isBotPlayer(p) {
  return p && p.isBot === true;
}

function removeFromQueues(socketId) {
  for (const kategori in waitingPlayers) {
    waitingPlayers[kategori] = waitingPlayers[kategori].filter((p) => p.id !== socketId);
  }
}

function cleanupPlayer(socketId) {
  removeFromQueues(socketId);

  const oldRoomKey = playerRoom[socketId];
  if (!oldRoomKey) return;

  const room = rooms[oldRoomKey];
  if (room) {
    const other = room.players.find((p) => p.id !== socketId);
    if (other && !isBotPlayer(other)) {
      io.to(other.id).emit("opponent_left");
      delete playerRoom[other.id];
    }
    delete rooms[oldRoomKey];
  }

  delete playerRoom[socketId];
}

function pickBotGuess(room) {
  const list = kelimeler5[room.kategori] || [];
  if (list.length === 0) return "-----";
  return list[Math.floor(Math.random() * list.length)];
}

function getRenkler(kelime, dogruKelime) {
  const guess = normalize(kelime);
  const target = normalize(dogruKelime);

  if (guess.length !== WORD_LEN || target.length !== WORD_LEN) {
    return Array(WORD_LEN).fill("absent");
  }

  const renkler = Array(WORD_LEN).fill("absent");
  const dogru = target.split("");
  const tahmin = guess.split("");

  for (let i = 0; i < WORD_LEN; i++) {
    if (tahmin[i] === dogru[i]) {
      renkler[i] = "correct";
      dogru[i] = null;
    }
  }

  for (let i = 0; i < WORD_LEN; i++) {
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
  return playerRoom[id] || null;
}

function processGuess({ socketId, tahmin, odaKodu }) {
  const t = normalize(tahmin);
  if (t.length !== WORD_LEN) return;

  const roomKey = odaKodu || findRoomByPlayerId(socketId);
  if (!roomKey) return;

  const room = rooms[roomKey];
  if (!room || room.players.length < 2) return;

  const current = room.players[room.turnIndex];
  const other = room.players[1 - room.turnIndex];

  if (current.id !== socketId) return;

  const renkler = getRenkler(t, room.kelime);
  io.to(roomKey).emit("opponent_guess", t, renkler);

  if (t === room.kelime) {
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

    cleanupPlayer(socket.id);

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler5[upperKategori] || kelimeler5[upperKategori].length === 0) return;

    if (!waitingPlayers[upperKategori]) waitingPlayers[upperKategori] = [];
    const queue = waitingPlayers[upperKategori];

    if (queue.some((p) => p.id === socket.id)) return;

    if (queue.length > 0) {
      const rakip = queue.shift();
      if (rakip.id === socket.id) return;

      cleanupPlayer(rakip.id);

      const odaKodu = Math.random().toString(36).substring(2, 7);
      const kelime = pickRandomWord(upperKategori);
      if (!kelime) return;

      rooms[odaKodu] = {
        kategori: upperKategori,
        kelime,
        turnIndex: 0,
        players: [
          { id: rakip.id, nickname: rakip.nickname },
          { id: socket.id, nickname },
        ],
      };

      playerRoom[rakip.id] = odaKodu;
      playerRoom[socket.id] = odaKodu;

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

    cleanupPlayer(socket.id);

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler5[upperKategori] || kelimeler5[upperKategori].length === 0) return;

    if (!rooms[odaKodu]) {
      const kelime = pickRandomWord(upperKategori);
      if (!kelime) return;

      rooms[odaKodu] = {
        kategori: upperKategori,
        kelime,
        turnIndex: 0,
        players: [{ id: socket.id, nickname }],
      };

      playerRoom[socket.id] = odaKodu;
      socket.join(odaKodu);
      return;
    }

    if (rooms[odaKodu].players.length >= 2) {
      socket.emit("error", "Oda dolu.");
      return;
    }

    if (rooms[odaKodu].players.some((p) => p.id === socket.id)) return;

    rooms[odaKodu].players.push({ id: socket.id, nickname });
    playerRoom[socket.id] = odaKodu;

    const [p1, p2] = rooms[odaKodu].players;
    playerRoom[p1.id] = odaKodu;

    socket.join(odaKodu);
    io.sockets.sockets.get(p1.id)?.join(odaKodu);

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

    cleanupPlayer(socket.id);

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler5[upperKategori] || kelimeler5[upperKategori].length === 0) return;

    const odaKodu = Math.random().toString(36).substring(2, 7);
    const kelime = pickRandomWord(upperKategori);
    if (!kelime) return;

    const bot = makeBotPlayer();

    rooms[odaKodu] = {
      kategori: upperKategori,
      kelime,
      turnIndex: 0,
      players: [{ id: socket.id, nickname, isBot: false }, bot],
    };

    playerRoom[socket.id] = odaKodu;

    socket.join(odaKodu);

    socket.emit("match_found", kelime);
    socket.emit("your_turn", true);
    socket.emit("nickname_info", { sen: nickname, rakip: "BOT" });
  });

  socket.on("guess", ({ tahmin, odaKodu }) => {
    const t = normalize(tahmin);
    if (t.length !== WORD_LEN) return;

    processGuess({ socketId: socket.id, tahmin: t, odaKodu });
  });

  socket.on("rematch_request", () => {
    const odaKodu = findRoomByPlayerId(socket.id);
    if (!odaKodu) return;

    const room = rooms[odaKodu];
    if (!room) return;

    const rakip = room.players.find((p) => p.id !== socket.id);

    if (rakip && isBotPlayer(rakip)) {
      const yeni = pickRandomWord(room.kategori);
      if (!yeni) return;

      room.kelime = yeni;
      room.turnIndex = 0;

      socket.emit("match_found", room.kelime);
      socket.emit("your_turn", true);
      socket.emit("nickname_info", { sen: room.players[0].nickname, rakip: "BOT" });
      return;
    }

    rematchRequests[socket.id] = odaKodu;
    if (rakip && !isBotPlayer(rakip)) io.to(rakip.id).emit("rematch_request");
  });

  socket.on("rematch_response", (cevap) => {
    const odaKodu = rematchRequests[socket.id];
    if (!odaKodu) return;

    const room = rooms[odaKodu];
    if (!room) return;

    const rakip = room.players.find((p) => p.id !== socket.id);
    if (rakip && !isBotPlayer(rakip)) io.to(rakip.id).emit("rematch_response", cevap);

    if (cevap === "yes") {
      const yeni = pickRandomWord(room.kategori);
      if (!yeni) return;

      room.kelime = yeni;
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
    removeFromQueues(socket.id);

    const odaKodu = findRoomByPlayerId(socket.id);
    delete playerRoom[socket.id];

    if (odaKodu) {
      const room = rooms[odaKodu];
      if (room) {
        const kalan = room.players.find((p) => p.id !== socket.id);
        if (kalan && !isBotPlayer(kalan)) {
          io.to(kalan.id).emit("opponent_left");
          delete playerRoom[kalan.id];
        }
      }
      delete rooms[odaKodu];
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
