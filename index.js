const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const kelimeler = {
  HAYVANLAR: ["kedi", "köpek", "aslan", "balık", "fares"],
  YIYECEKLER: ["elma", "erik", "armut", "muz", "üzüm"],
  RENKLER: ["mavi", "sarı", "beyaz", "siyah", "yeşil"],
};

const rooms = {}; // odaKodu -> { players: [], kelime, turnIndex, kategori }
const waitingPlayers = {}; // kategori -> [ { id, nickname } ]
const rematchRequests = {}; // socket.id -> odaKodu

io.on("connection", (socket) => {
  console.log("🔌 Yeni bağlantı:", socket.id);

  // ✅ GÜNCELLENMİŞ join_game EVENTİ
  socket.on("join_game", ({ kategori, nickname }) => {
    if (!kategori || !nickname) return;

    const upperKategori = kategori.toUpperCase();
    if (!kelimeler[upperKategori]) return;

    if (!waitingPlayers[upperKategori]) waitingPlayers[upperKategori] = [];
    const queue = waitingPlayers[upperKategori];

    // Aynı kişi zaten kuyrukta mı?
    if (queue.some(p => p.id === socket.id)) {
      console.log(`⚠️ ${nickname} zaten kuyrukta (${socket.id})`);
      return;
    }

    if (queue.length > 0) {
      const rakip = queue[0];

      if (rakip.id === socket.id) {
        console.log("⛔ Aynı oyuncu ile eşleşme engellendi.");
        return;
      }

      queue.shift();

      const odaKodu = Math.random().toString(36).substring(2, 7);
      const kelime = kelimeler[upperKategori][Math.floor(Math.random() * kelimeler[upperKategori].length)];

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

      console.log(`✅ Eşleşme: ${p1.nickname} vs ${p2.nickname} | ${odaKodu}`);
    } else {
      queue.push({ id: socket.id, nickname });
      console.log(`⏳ Kuyruğa alındı: ${nickname}`);
    }
  });

  socket.on("join_game_with_code", ({ odaKodu, kategori, nickname }) => {
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
      console.log(`🔐 Oda oluşturuldu: ${odaKodu} - ${nickname}`);
    } else if (rooms[odaKodu].players.length === 1) {
      const mevcutMu = rooms[odaKodu].players.find(p => p.id === socket.id);
      if (mevcutMu) return;

      rooms[odaKodu].players.push({ id: socket.id, nickname });
      socket.join(odaKodu);

      const rakip = rooms[odaKodu].players[0];
      const rakipSocket = io.sockets.sockets.get(rakip.id);

      if (!rakipSocket) {
        console.log("❌ Rakip bağlantısı artık yok, eşleşme iptal.");
        socket.emit("error", "Rakip bağlantısı kesildi.");
        delete rooms[odaKodu];
        return;
      }

      rakipSocket.join(odaKodu);

      const [p1, p2] = rooms[odaKodu].players;
      const kelime = rooms[odaKodu].kelime;

      io.to(p1.id).emit("match_found", kelime);
      io.to(p2.id).emit("match_found", kelime);

      io.to(p1.id).emit("your_turn", true);
      io.to(p2.id).emit("your_turn", false);

      io.to(p1.id).emit("nickname_info", { sen: p1.nickname, rakip: p2.nickname });
      io.to(p2.id).emit("nickname_info", { sen: p2.nickname, rakip: p1.nickname });

      console.log(`✅ Oda eşleşti: ${p1.nickname} vs ${p2.nickname} | ${odaKodu}`);
    } else {
      socket.emit("error", "Oda dolu.");
    }
  });

  socket.on("guess", ({ tahmin, kategori, odaKodu }) => {
    const roomKey = odaKodu || findRoomByPlayerId(socket.id);
    if (!roomKey) return;
    const room = rooms[roomKey];
    if (!room || room.players.length < 2) return;

    const current = room.players[room.turnIndex];
    const other = room.players[1 - room.turnIndex];
    const renkler = getRenkler(tahmin, room.kelime);

    io.to(current.id).emit("opponent_guess", tahmin, renkler);
    io.to(other.id).emit("opponent_guess", tahmin, renkler);

    if (tahmin === room.kelime) {
      io.to(current.id).emit("game_result", "Kazandınız 🎉");
      io.to(other.id).emit("game_result", "Kaybettiniz 😢");
      return;
    }

    room.turnIndex = 1 - room.turnIndex;
    io.to(room.players[room.turnIndex].id).emit("your_turn", true);
    io.to(room.players[1 - room.turnIndex].id).emit("your_turn", false);
  });

  socket.on("rematch_request", () => {
    const odaKodu = findRoomByPlayerId(socket.id);
    if (!odaKodu) return;

    rematchRequests[socket.id] = odaKodu;
    const room = rooms[odaKodu];
    const rakip = room.players.find((p) => p.id !== socket.id);
    if (rakip) {
      io.to(rakip.id).emit("rematch_request");
    }
  });

  socket.on("rematch_response", (cevap) => {
    const odaKodu = rematchRequests[socket.id];
    if (!odaKodu) return;

    const room = rooms[odaKodu];
    if (!room) return;

    const rakip = room.players.find((p) => p.id !== socket.id);
    if (rakip) {
      io.to(rakip.id).emit("rematch_response", cevap);
    }

    if (cevap === "yes") {
      const kelime = kelimeler[room.kategori][Math.floor(Math.random() * kelimeler[room.kategori].length)];
      room.kelime = kelime;
      room.turnIndex = 0;

      io.to(odaKodu).emit("match_found", kelime);
      const [p1, p2] = room.players;
      io.to(p1.id).emit("your_turn", true);
      io.to(p2.id).emit("your_turn", false);

      io.to(p1.id).emit("nickname_info", { sen: p1.nickname, rakip: p2.nickname });
      io.to(p2.id).emit("nickname_info", { sen: p2.nickname, rakip: p1.nickname });
    }

    delete rematchRequests[socket.id];
  });

  socket.on("disconnect", () => {
    console.log("⛔ Bağlantı koptu:", socket.id);
    for (const kategori in waitingPlayers) {
      waitingPlayers[kategori] = waitingPlayers[kategori].filter((p) => p.id !== socket.id);
    }

    const odaKodu = findRoomByPlayerId(socket.id);
    if (odaKodu) {
      const room = rooms[odaKodu];
      const kalanOyuncu = room.players.find((p) => p.id !== socket.id);
      if (kalanOyuncu) {
        io.to(kalanOyuncu.id).emit("opponent_left");
      }
      delete rooms[odaKodu];
    }
  });

  function findRoomByPlayerId(id) {
    return Object.entries(rooms).find(([_, room]) =>
      room.players.some((p) => p.id === id)
    )?.[0];
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
});

server.listen(3001, () => {
  console.log("🚀 Sunucu çalışıyor http://localhost:3001");
});
