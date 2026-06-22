import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  act,
  approveBuyIn,
  autoTimeout,
  drawRevealDecision,
  drawSelect,
  GameStore,
  hostStand,
  joinRoom,
  pauseGame,
  privateState,
  publicState,
  rejectBuyIn,
  resumeGame,
  requestBuyIn,
  sendChat,
  sit,
  sitRandom,
  stand,
  startHand,
  transferHost,
  updateSettings
} from "./game";
import type { ClientAction, RoomSettings } from "../shared/types";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
const store = new GameStore();
const autoNextHandTimers = new Map<string, ReturnType<typeof setTimeout>>();

app.use(express.json());
app.get("/api/health", (_req, res) => res.json({ ok: true }));

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

type Ack<T = unknown> = (response: { ok: true; data?: T } | { ok: false; error: string }) => void;

function ok<T>(ack?: Ack<T>, data?: T): void {
  ack?.({ ok: true, data });
}

function fail(ack: Ack | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ack?.({ ok: false, error: message });
}

async function broadcastRoom(roomId: string): Promise<void> {
  const room = store.rooms.get(roomId);
  if (!room) return;
  const sockets = await io.in(roomId).fetchSockets();
  for (const socket of sockets) {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) continue;
    socket.emit("roomState", publicState(room, playerId));
    const privatePayload = privateState(room, playerId);
    if (privatePayload) socket.emit("privateState", privatePayload);
  }
}

async function broadcastRoomAndSchedule(roomId: string): Promise<void> {
  await broadcastRoom(roomId);
  scheduleAutoNextHand(roomId);
}

function cancelAutoNextHand(roomId: string): void {
  const timer = autoNextHandTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  autoNextHandTimers.delete(roomId);
}

function scheduleAutoNextHand(roomId: string): void {
  const room = store.rooms.get(roomId);
  if (!room || room.paused || room.hand?.street !== "settled") return;
  if (autoNextHandTimers.has(roomId)) return;
  if (room.seats.filter((seat) => seat.playerId && seat.stack > 0).length < 2) return;

  const settledHandId = room.hand.id;
  const delayMs = (room.settings.settlementSeconds ?? 5) * 1000;
  const timer = setTimeout(async () => {
    autoNextHandTimers.delete(roomId);
    const currentRoom = store.rooms.get(roomId);
    if (!currentRoom || currentRoom.paused || currentRoom.hand?.street !== "settled" || currentRoom.hand.id !== settledHandId) return;
    if (currentRoom.seats.filter((seat) => seat.playerId && seat.stack > 0).length < 2) return;
    try {
      startHand(currentRoom, currentRoom.hostId);
      await broadcastRoom(currentRoom.id);
    } catch {
      await broadcastRoom(roomId);
    }
  }, delayMs);
  autoNextHandTimers.set(roomId, timer);
}

io.on("connection", (socket) => {
  socket.on("createRoom", async (payload: { playerId: string; nickname: string; settings?: Partial<RoomSettings> }, ack?: Ack) => {
    try {
      socket.data.playerId = payload.playerId;
      const room = store.createRoom(payload.playerId, payload.nickname, payload.settings ?? {});
      await socket.join(room.id);
      ok(ack, { roomId: room.id });
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("joinRoom", async (payload: { roomId: string; playerId: string; nickname: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      socket.data.playerId = payload.playerId;
      joinRoom(room, payload.playerId, payload.nickname, false);
      await socket.join(room.id);
      ok(ack, { roomId: room.id });
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("joinSpectator", async (payload: { roomId: string; playerId: string; nickname: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      socket.data.playerId = payload.playerId;
      joinRoom(room, payload.playerId, payload.nickname, true);
      await socket.join(room.id);
      ok(ack, { roomId: room.id });
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("sit", async (payload: { roomId: string; playerId: string; seatIndex: number }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      sit(room, payload.playerId, payload.seatIndex);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("sitRandom", async (payload: { roomId: string; playerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      const seatIndex = sitRandom(room, payload.playerId);
      ok(ack, { seatIndex });
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("stand", async (payload: { roomId: string; playerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      stand(room, payload.playerId);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("hostStand", async (payload: { roomId: string; playerId: string; targetPlayerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      hostStand(room, payload.playerId, payload.targetPlayerId);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("transferHost", async (payload: { roomId: string; playerId: string; targetPlayerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      transferHost(room, payload.playerId, payload.targetPlayerId);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("buyIn", async (payload: { roomId: string; playerId: string; amount: number }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      requestBuyIn(room, payload.playerId, payload.amount);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("approveBuyIn", async (payload: { roomId: string; playerId: string; requestId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      approveBuyIn(room, payload.playerId, payload.requestId);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("rejectBuyIn", async (payload: { roomId: string; playerId: string; requestId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      rejectBuyIn(room, payload.playerId, payload.requestId);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("updateSettings", async (payload: { roomId: string; playerId: string; settings: Partial<RoomSettings> }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      updateSettings(room, payload.playerId, payload.settings);
      if (room.hand?.street === "settled") cancelAutoNextHand(room.id);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("hostStartHand", async (payload: { roomId: string; playerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      cancelAutoNextHand(room.id);
      startHand(room, payload.playerId);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("hostPauseGame", async (payload: { roomId: string; playerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      pauseGame(room, payload.playerId);
      cancelAutoNextHand(room.id);
      io.to(room.id).emit("gamePaused");
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("hostResumeGame", async (payload: { roomId: string; playerId: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      resumeGame(room, payload.playerId);
      io.to(room.id).emit("gameResumed");
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("sendChat", async (payload: { roomId: string; playerId: string; text: string }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      const message = sendChat(room, payload.playerId, payload.text);
      io.to(room.id).emit("chatMessage", message);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("act", async (payload: { roomId: string; playerId: string; action: ClientAction }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      act(room, payload.playerId, payload.action);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("drawSelect", async (payload: { roomId: string; playerId: string; indices: number[] }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      const reveal = drawSelect(room, payload.playerId, payload.indices);
      if (reveal) socket.emit("drawReveal", reveal);
      ok(ack, { reveal });
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("drawRevealDecision", async (payload: { roomId: string; playerId: string; accept: boolean }, ack?: Ack) => {
    try {
      const room = store.getRoom(payload.roomId);
      drawRevealDecision(room, payload.playerId, payload.accept);
      ok(ack);
      await broadcastRoomAndSchedule(room.id);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("leaveRoom", async (payload: { roomId: string }, ack?: Ack) => {
    try {
      await socket.leave(payload.roomId);
      ok(ack);
      await broadcastRoomAndSchedule(payload.roomId);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on("disconnect", async () => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) return;
    for (const room of store.rooms.values()) {
      const participant = room.participants.get(playerId);
      if (!participant) continue;
      if (participant.seatIndex !== null) room.seats[participant.seatIndex].connected = false;
      await broadcastRoomAndSchedule(room.id);
    }
  });
});

setInterval(async () => {
  for (const room of store.rooms.values()) {
    const before = room.hand?.currentSeat;
    autoTimeout(room);
    if (before !== room.hand?.currentSeat) await broadcastRoomAndSchedule(room.id);
  }
}, 500);

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => {
  console.log(`抓马哈 server listening on http://localhost:${port}`);
});
