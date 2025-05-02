console.log("Backend server file loaded");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Game state
const gameState = {
  players: new Map(), // Map of socket.id to player data
  numbers: Array.from({ length: 20 }, (_, i) => i + 1), // Numbers 1-20
  currentTurn: null,
  gameStarted: false,
  winners: [], // Array to store winners in order
};

console.log("Initial numbers array:", gameState.numbers);

// Game lobbies
const lobbies = new Map(); // code -> lobbyState

function generateLobbyCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function createLobby() {
  const code = generateLobbyCode();
  lobbies.set(code, {
    players: new Map(),
    numbers: Array.from({ length: 20 }, (_, i) => i + 1),
    currentTurn: null,
    gameStarted: false,
    winners: [],
  });
  return code;
}

io.on("connection", (socket) => {
  socket.lobbyCode = null;

  socket.on("createLobby", () => {
    const code = createLobby();
    console.log(`Lobby created with code: ${code} for socket: ${socket.id}`);
    socket.emit("lobbyCreated", code);
  });

  socket.on("joinLobby", ({ code, playerName }) => {
    const lobby = lobbies.get(code);
    if (!lobby) {
      socket.emit("error", "Lobby not found");
      return;
    }
    if (lobby.players.size >= 4) {
      socket.emit("error", "Game is full");
      return;
    }
    lobby.players.set(socket.id, {
      name: playerName,
      selectedNumber: null,
      isEliminated: false,
      placement: null,
    });
    socket.lobbyCode = code;
    io.to(code).emit("playerList", Array.from(lobby.players.values()));
    socket.join(code);
  });

  socket.on("joinGame", (playerName) => {
    // Deprecated: use joinLobby instead
    socket.emit("error", "Use joinLobby with a code");
  });

  socket.on("selectNumber", (number) => {
    const code = socket.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    let player = lobby.players.get(socket.id);
    if (!player) return;
    player.selectedNumber = number;
    io.to(code).emit("playerList", Array.from(lobby.players.values()));
  });

  socket.on("eliminateNumber", (number) => {
    const code = socket.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby || !lobby.gameStarted || lobby.currentTurn !== socket.id) return;
    const player = lobby.players.get(socket.id);
    if (player && player.selectedNumber === number) {
      socket.emit("error", "You can't eliminate your own secret number!");
      return;
    }
    const index = lobby.numbers.indexOf(number);
    if (index === -1) return;
    lobby.numbers.splice(index, 1);
    lobby.players.forEach((player, id) => {
      if (player.selectedNumber === number && !player.isEliminated) {
        player.isEliminated = true;
        const eliminatedPlayers = Array.from(lobby.players.values()).filter(
          (p) => p.isEliminated
        ).length;
        player.placement = eliminatedPlayers;
        io.to(code).emit("playerEliminated", {
          playerName: player.name,
          number: player.selectedNumber,
          placement: player.placement,
          totalPlayers: lobby.players.size,
        });
        io.to(code).emit("playerList", Array.from(lobby.players.values()));
        io.to(id).emit("youWon", {
          placement: player.placement,
          totalPlayers: lobby.players.size,
          number: player.selectedNumber,
        });
      }
    });
    const remainingPlayers = Array.from(lobby.players.values()).filter(
      (p) => !p.isEliminated
    );
    if (remainingPlayers.length === 1) {
      const loser = remainingPlayers[0];
      loser.placement = lobby.players.size;
      io.to(remainingPlayers[0].id).emit("youLost", {
        placement: lobby.players.size,
        totalPlayers: lobby.players.size,
        number: loser.selectedNumber,
      });
      io.to(code).emit("gameOver", {
        placements: Array.from(lobby.players.values())
          .sort((a, b) => (a.placement || 999) - (b.placement || 999))
          .map((p) => ({
            name: p.name,
            number: p.selectedNumber,
            placement: p.placement,
          })),
      });
      lobby.gameStarted = false;
      lobby.numbers = Array.from({ length: 20 }, (_, i) => i + 1);
      lobby.currentTurn = null;
      lobby.players.clear();
      lobby.winners = [];
      return;
    }
    const playerIds = Array.from(lobby.players.keys());
    let currentIndex = playerIds.indexOf(socket.id);
    let nextPlayer;
    do {
      currentIndex = (currentIndex + 1) % playerIds.length;
      nextPlayer = lobby.players.get(playerIds[currentIndex]);
    } while (nextPlayer.isEliminated);
    lobby.currentTurn = playerIds[currentIndex];
    io.to(code).emit("numberEliminated", {
      number,
      remainingNumbers: lobby.numbers,
      currentTurn: lobby.currentTurn,
      currentPlayerName: lobby.players.get(lobby.currentTurn).name,
    });
  });

  socket.on("startGame", () => {
    const code = socket.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    // Only the party leader (first player) can start the game
    const firstPlayerId = Array.from(lobby.players.keys())[0];
    if (socket.id !== firstPlayerId) return;
    if (lobby.players.size < 2) {
      socket.emit("error", "At least 2 players required to start the game.");
      return;
    }
    lobby.gameStarted = true;
    lobby.currentTurn = firstPlayerId;
    // Emit gameStarted to all in the lobby
    io.to(code).emit("gameStarted", {
      currentTurn: lobby.currentTurn,
      currentPlayerName: lobby.players.get(lobby.currentTurn).name,
      numbers: lobby.numbers,
    });
  });

  socket.on("disconnect", () => {
    const code = socket.lobbyCode;
    if (code) {
      const lobby = lobbies.get(code);
      if (lobby) {
        lobby.players.delete(socket.id);
        io.to(code).emit("playerList", Array.from(lobby.players.values()));
        if (lobby.players.size === 0) {
          lobbies.delete(code);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
