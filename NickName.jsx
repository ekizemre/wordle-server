import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

function NickNamePage() {
  const [nickname, setNickname] = useState("");
  const [kategori, setKategori] = useState("");
  const navigate = useNavigate();

  const basla = () => {
    if (nickname.trim().length < 3)
      return alert("Lütfen en az 3 harfli bir takma ad girin.");
    if (!kategori) return alert("Lütfen bir kategori seçin.");

    navigate(`/game/${kategori}?nickname=${nickname}`);
  };

  return (
    <div style={{ padding: "40px", color: "#fff", textAlign: "center" }}>
      <h2>Nicknamenizi ve Kategorinizi Seçin</h2>

      <input
        type="text"
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        placeholder="Nickname"
        style={{
          fontSize: "18px",
          padding: "10px",
          marginBottom: "20px",
          textTransform: "lowercase",
        }}
      />
      <br />
      <select
        value={kategori}
        onChange={(e) => setKategori(e.target.value)}
        style={{ fontSize: "18px", padding: "10px" }}
      >
        <option value="">-- Kategori Seçin --</option>
        <option value="yiyecekler">Yiyecekler</option>
        <option value="hayvanlar">Hayvanlar</option>
        <option value="ülkeler">Ülkeler</option>
        <option value="teknoloji">Teknoloji</option>
      </select>
      <br /> <br />
      <button
        onClick={basla}
        style={{
          fontSize: "18px",
          padding: "10px 20px",
          backgroundColor: "#61dafb",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
        }}
      >
        Oyuna Başla
      </button>
    </div>
  );
}

export default NickNamePage;
