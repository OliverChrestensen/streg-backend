console.log("Backend server file loaded");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(
  cors({
    origin: ["https://streg-frontend.vercel.app", "http://localhost:3000"],
    credentials: true,
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://streg-frontend.vercel.app", "http://localhost:3000"],
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

function createLobby(boardSize = 20) {
  const code = generateLobbyCode();
  lobbies.set(code, {
    players: new Map(),
    numbers: Array.from({ length: boardSize }, (_, i) => i + 1),
    currentTurn: null,
    gameStarted: false,
    winners: [],
    boardSize: boardSize,
    nextRoundPlayers: new Map(), // For replay logic
  });
  return code;
}

function getPlayersWithIds(playersMap) {
  return Array.from(playersMap.entries()).map(([id, player]) => ({ ...player, id }));
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);
  socket.lobbyCode = null;

  socket.on("createLobby", ({ boardSize }) => {
    console.log("Creating lobby with board size:", boardSize);
    const code = createLobby(boardSize);
    console.log(`Lobby created with code: ${code} for socket: ${socket.id}`);
    socket.emit("lobbyCreated", code);
  });

  socket.on("joinLobby", ({ code, playerName }) => {
    const lobby = lobbies.get(code);
    if (!lobby) {
      socket.emit("error", "Lobby not found");
      return;
    }
    if (lobby.players.size >= 12) {
      socket.emit("error", "Game is full");
      return;
    }
    lobby.players.set(socket.id, {
      name: playerName,
      selectedNumber: null,
      isEliminated: false,
      placement: null,
    });
    socket.playerName = playerName;
    socket.lobbyCode = code;
    io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
    socket.emit("playerList", getPlayersWithIds(lobby.players));
    socket.emit("lobbyJoined", { boardSize: lobby.boardSize });
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
    io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
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
    // Collect all players to be eliminated this round
    const toEliminate = [];
    lobby.players.forEach((player, id) => {
      if (player.selectedNumber === number && !player.isEliminated) {
        toEliminate.push({ player, id });
      }
    });
    // Count how many are already eliminated before this round
    const alreadyEliminated = Array.from(lobby.players.values()).filter(
      (p) => p.isEliminated
    ).length;
    // Placement for this round is highest available
    const placement = alreadyEliminated + 1;
    // Eliminate them and assign placement
    toEliminate.forEach(({ player, id }) => {
      player.isEliminated = true;
      player.placement = placement;
      io.to(code).emit("playerEliminated", {
        playerName: player.name,
        number: player.selectedNumber,
        placement: player.placement,
        totalPlayers: lobby.players.size,
      });
      io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
      io.to(id).emit("youWon", {
        placement: player.placement,
        totalPlayers: lobby.players.size,
        number: player.selectedNumber,
      });
    });
    // Now calculate remaining players
    const remainingPlayers = Array.from(lobby.players.values()).filter(
      (p) => !p.isEliminated
    );
    // New rule: if all remaining players have the same selectedNumber, end the game and assign them all last place
    if (
      remainingPlayers.length > 1 &&
      remainingPlayers.every(p => p.selectedNumber === remainingPlayers[0].selectedNumber)
    ) {
      const lastPlace = lobby.players.size;
      remainingPlayers.forEach(p => {
        p.placement = lastPlace;
        p.isEliminated = true;
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
      lobby.numbers = Array.from({ length: lobby.boardSize }, (_, i) => i + 1);
      lobby.currentTurn = null;
      lobby.players.clear();
      lobby.winners = [];
      return;
    }
    // If only one player is left, they are the loser and get last place
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
      lobby.numbers = Array.from({ length: lobby.boardSize }, (_, i) => i + 1);
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

    // Check for duplicate numbers
    const selectedNumbers = Array.from(lobby.players.values())
      .map(player => player.selectedNumber)
      .filter(number => number !== null);
    // Only reset if all players have picked and all numbers are the same
    if (
      selectedNumbers.length === lobby.players.size &&
      selectedNumbers.every(n => n === selectedNumbers[0])
    ) {
      lobby.players.forEach(player => { player.selectedNumber = null; });
      io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
      io.to(code).emit("resetNumbers");
      return;
    }

    lobby.gameStarted = true;
    // Randomly select a starting player
    const playerIds = Array.from(lobby.players.keys());
    const randomIndex = Math.floor(Math.random() * playerIds.length);
    lobby.currentTurn = playerIds[randomIndex];
    // Emit gameStarted to all in the lobby
    io.to(code).emit("gameStarted", {
      currentTurn: lobby.currentTurn,
      currentPlayerName: lobby.players.get(lobby.currentTurn).name,
      numbers: lobby.numbers,
    });
  });

  socket.on("replayGame", () => {
    const code = socket.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    // Reset lobby state but keep players and code
    lobby.numbers = Array.from({ length: lobby.boardSize }, (_, i) => i + 1);
    lobby.currentTurn = null;
    lobby.gameStarted = false;
    lobby.winners = [];
    // Reset player states
    lobby.players.forEach(player => {
      player.selectedNumber = null;
      player.isEliminated = false;
      player.placement = null;
    });
    io.to(code).emit("lobbyReset", {
      boardSize: lobby.boardSize,
      players: getPlayersWithIds(lobby.players),
      numbers: lobby.numbers,
    });
    io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
  });

  socket.on("playerReadyForReplay", () => {
    const code = socket.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    // Always reset player state when rejoining for a new round, keep name from socket
    const name = socket.playerName || `Player${lobby.players.size + 1}`;
    lobby.players.set(socket.id, {
      name,
      selectedNumber: null,
      isEliminated: false,
      placement: null,
    });
    // Broadcast updated player list
    io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
    // Send lobbyReset to this player so they see the lobby/number selection
    socket.emit("lobbyReset", {
      boardSize: lobby.boardSize,
      players: getPlayersWithIds(lobby.players),
      numbers: Array.from({ length: lobby.boardSize }, (_, i) => i + 1),
    });
  });

  socket.on("leaveLobby", () => {
    const code = socket.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    lobby.players.delete(socket.id);
    lobby.nextRoundPlayers?.delete(socket.id);
    socket.leave(code);
    socket.lobbyCode = null;
    io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
    if (lobby.players.size === 0 && (!lobby.nextRoundPlayers || lobby.nextRoundPlayers.size === 0)) {
      lobbies.delete(code);
    }
  });

  socket.on("disconnect", () => {
    const code = socket.lobbyCode;
    if (code) {
      const lobby = lobbies.get(code);
      if (lobby) {
        lobby.players.delete(socket.id);
        lobby.nextRoundPlayers?.delete(socket.id);
        io.to(code).emit("playerList", getPlayersWithIds(lobby.players));
        if (lobby.players.size === 0 && (!lobby.nextRoundPlayers || lobby.nextRoundPlayers.size === 0)) {
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
