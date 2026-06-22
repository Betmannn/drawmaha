import { cardToString, draw, makeDeck, shuffle } from "../shared/cards";
import { compareHandRanks, evaluateHandBoard, evaluateOmahaBoard } from "../shared/evaluator";
import type {
  BoardState,
  BuyInRequest,
  Card,
  ChatMessage,
  ClientAction,
  DrawRevealPublic,
  LegalActions,
  PlayerSettlement,
  PrivateState,
  PublicRoomState,
  PublicSeat,
  ReplayEvent,
  Role,
  RoomSettings,
  ShowdownBoardResult,
  ShowdownResult,
  Street
} from "../shared/types";

const defaultSettings: RoomSettings = {
  tableName: "抓马哈 6max",
  ante: 10,
  minBuyIn: 500,
  maxBuyIn: 5000,
  thinkingTimeSeconds: 30,
  drawTimeSeconds: 30,
  settlementSeconds: 5,
  gameDurationMinutes: 0,
  rakePercent: 0,
  rakeCap: 0,
  maxPlayers: 6
};

interface SeatState {
  index: number;
  playerId: string | null;
  nickname: string | null;
  stack: number;
  buyIn: number;
  handStartStack: number;
  connected: boolean;
  folded: boolean;
  allIn: boolean;
  currentBet: number;
  totalContribution: number;
  pendingBuyIn: number;
  rakePaid: number;
  lastAction: string | null;
  acted: boolean;
  drawCount: number | null;
  hand: Card[];
  pendingDraw: { index: number; reveal: Card; discarded: Card } | null;
}

interface Participant {
  id: string;
  nickname: string;
  role: Role;
  seatIndex: number | null;
  lastSeatIndex: number | null;
}

interface HandState {
  id: string;
  deck: Card[];
  street: Street;
  board: BoardState;
  runout: BoardState;
  discards: Card[];
  currentSeat: number | null;
  currentBet: number;
  minRaise: number;
  timerEndsAt: number | null;
  riverHadBet: boolean;
  riverAggressorId: string | null;
  drawReveal: DrawRevealPublic | null;
  showdown: ShowdownResult | null;
}

export interface RoomState {
  id: string;
  hostId: string;
  settings: RoomSettings;
  paused: boolean;
  participants: Map<string, Participant>;
  seats: SeatState[];
  pendingBuyIns: BuyInRequest[];
  chat: ChatMessage[];
  replay: ReplayEvent[];
  gameStartedAt: number | null;
  rakeTotal: number;
  dealerSeat: number | null;
  hand: HandState | null;
}

function uid(prefix = ""): string {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

function roomCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += Math.floor(Math.random() * 10).toString();
  return code;
}

function createSeat(index: number): SeatState {
  return {
    index,
    playerId: null,
    nickname: null,
    stack: 0,
    buyIn: 0,
    handStartStack: 0,
    connected: false,
    folded: false,
    allIn: false,
    currentBet: 0,
    totalContribution: 0,
    pendingBuyIn: 0,
    rakePaid: 0,
    lastAction: null,
    acted: false,
    drawCount: null,
    hand: [],
    pendingDraw: null
  };
}

export class GameStore {
  rooms = new Map<string, RoomState>();

  createRoom(hostId: string, nickname: string, settings: Partial<RoomSettings>): RoomState {
    let id = roomCode();
    while (this.rooms.has(id)) id = roomCode();
    const normalizedSettings = normalizeSettings({ ...defaultSettings, ...settings });
    const room: RoomState = {
      id,
      hostId,
      settings: normalizedSettings,
      paused: false,
      participants: new Map(),
      seats: Array.from({ length: normalizedSettings.maxPlayers }, (_, index) => createSeat(index)),
      pendingBuyIns: [],
      chat: [],
      replay: [],
      gameStartedAt: null,
      rakeTotal: 0,
      dealerSeat: null,
      hand: null
    };
    room.participants.set(hostId, { id: hostId, nickname, role: "host", seatIndex: null, lastSeatIndex: null });
    this.rooms.set(id, room);
    addReplay(room, "room", `${nickname} 创建房间 ${id}`);
    return room;
  }

  getRoom(id: string): RoomState {
    const room = this.rooms.get(id.toUpperCase());
    if (!room) throw new Error("房间不存在");
    return room;
  }
}

export function joinRoom(room: RoomState, playerId: string, nickname: string, asSpectator = false): Participant {
  const existing = room.participants.get(playerId);
  if (existing) {
    existing.nickname = nickname;
    existing.role = existing.id === room.hostId ? "host" : asSpectator ? "spectator" : existing.role;
    return existing;
  }
  if ([...room.participants.values()].some((p) => p.nickname === nickname && p.id !== playerId)) {
    throw new Error("昵称已被使用");
  }
  const participant: Participant = {
    id: playerId,
    nickname,
    role: playerId === room.hostId ? "host" : asSpectator ? "spectator" : "player",
    seatIndex: null,
    lastSeatIndex: null
  };
  room.participants.set(playerId, participant);
  addReplay(room, "join", `${nickname} ${asSpectator ? "加入观战" : "加入房间"}`);
  return participant;
}

export function sit(room: RoomState, playerId: string, seatIndex: number): void {
  const participant = requireParticipant(room, playerId);
  const seat = room.seats[seatIndex];
  if (!seat) throw new Error("座位不存在");
  if (seat.playerId && seat.playerId !== playerId) throw new Error("座位已有人");
  if (participant.role === "spectator") participant.role = playerId === room.hostId ? "host" : "player";
  for (const other of room.seats) {
    if (other.playerId === playerId) {
      other.playerId = null;
      other.nickname = null;
      other.connected = false;
    }
  }
  seat.playerId = playerId;
  seat.nickname = participant.nickname;
  seat.connected = true;
  if (room.hand && room.hand.street !== "settled" && seat.hand.length === 0) {
    seat.folded = true;
    seat.allIn = false;
    seat.currentBet = 0;
    seat.totalContribution = 0;
    seat.lastAction = "等待下一手";
    seat.acted = true;
    seat.drawCount = null;
    seat.pendingDraw = null;
  }
  participant.seatIndex = seatIndex;
  participant.lastSeatIndex = seatIndex;
  addReplay(room, "seat", `${participant.nickname} 坐下 ${seatIndex + 1} 号位`);
}

export function sitRandom(room: RoomState, playerId: string): number {
  const participant = requireParticipant(room, playerId);
  if (participant.seatIndex !== null) return participant.seatIndex;
  const preferred = participant.lastSeatIndex !== null ? room.seats[participant.lastSeatIndex] : null;
  if (preferred && !preferred.playerId) {
    sit(room, playerId, preferred.index);
    return preferred.index;
  }
  const openSeats = room.seats.filter((seat) => !seat.playerId);
  if (!openSeats.length) throw new Error("座位已满");
  const seat = openSeats[Math.floor(Math.random() * openSeats.length)];
  sit(room, playerId, seat.index);
  return seat.index;
}

export function stand(room: RoomState, playerId: string): void {
  const participant = requireParticipant(room, playerId);
  if (room.hostId === playerId && hasOtherHostCandidates(room, playerId)) throw new Error("房主离桌前请先转交房主身份");
  if (participant.seatIndex !== null) {
    const seat = room.seats[participant.seatIndex];
    const wasCurrent = room.hand?.currentSeat === seat.index;
    if (room.hand && room.hand.street !== "settled" && !seat.folded) {
      seat.folded = true;
      seat.lastAction = "leave/fold";
      addReplay(room, "stand", `${participant.nickname} 离桌并弃牌`);
    } else {
      addReplay(room, "stand", `${participant.nickname} 离桌`);
    }
    seat.playerId = null;
    seat.nickname = null;
    seat.connected = false;
    participant.seatIndex = null;
    if (room.hand && room.hand.street !== "settled" && wasCurrent) advanceAfterAction(room);
  }
  participant.role = participant.id === room.hostId ? "host" : "spectator";
}

export function hostStand(room: RoomState, hostId: string, targetPlayerId: string): void {
  requireHost(room, hostId);
  if (hostId === targetPlayerId) throw new Error("房主请使用离桌按钮");
  if (room.hand && room.hand.street !== "settled") throw new Error("牌局进行中不能让玩家起立");
  stand(room, targetPlayerId);
}

export function transferHost(room: RoomState, playerId: string, targetPlayerId: string): void {
  requireHost(room, playerId);
  const target = requireParticipant(room, targetPlayerId);
  if (target.id === playerId) throw new Error("已经是房主");
  if (target.role === "spectator") throw new Error("只能转交给玩家");
  const oldHost = requireParticipant(room, playerId);
  room.hostId = target.id;
  oldHost.role = oldHost.seatIndex === null ? "spectator" : "player";
  target.role = "host";
  addReplay(room, "host", `${oldHost.nickname} 将房主转交给 ${target.nickname}`);
}

export function buyIn(room: RoomState, playerId: string, amount: number): void {
  const participant = requireParticipant(room, playerId);
  validateBuyIn(room, participant, amount);
  const seat = room.seats[participant.seatIndex!];
  const cleanAmount = Math.floor(amount);
  seat.buyIn += cleanAmount;
  if (room.hand && room.hand.street !== "settled") {
    seat.pendingBuyIn += cleanAmount;
    addReplay(room, "buyIn", `${participant.nickname} 买入 ${cleanAmount}，下局生效`);
  } else {
    seat.stack += cleanAmount;
    addReplay(room, "buyIn", `${participant.nickname} 买入 ${cleanAmount}`);
  }
}

export function requestBuyIn(room: RoomState, playerId: string, amount: number): BuyInRequest | null {
  const participant = requireParticipant(room, playerId);
  if (playerId === room.hostId) {
    buyIn(room, playerId, amount);
    return null;
  }
  validateBuyIn(room, participant, amount);
  const existing = room.pendingBuyIns.find((request) => request.playerId === playerId);
  if (existing) {
    existing.amount = Math.floor(amount);
    existing.at = Date.now();
    addReplay(room, "buyInRequest", `${participant.nickname} 更新带入申请 ${existing.amount}`);
    return existing;
  }
  const request: BuyInRequest = {
    id: uid("bi_"),
    playerId,
    nickname: participant.nickname,
    amount: Math.floor(amount),
    at: Date.now()
  };
  room.pendingBuyIns.push(request);
  addReplay(room, "buyInRequest", `${participant.nickname} 申请带入 ${request.amount}`);
  return request;
}

export function approveBuyIn(room: RoomState, playerId: string, requestId: string): void {
  requireHost(room, playerId);
  const index = room.pendingBuyIns.findIndex((request) => request.id === requestId);
  if (index < 0) throw new Error("带入申请不存在");
  const [request] = room.pendingBuyIns.splice(index, 1);
  buyIn(room, request.playerId, request.amount);
  addReplay(room, "buyInApproved", `房主通过 ${request.nickname} 带入 ${request.amount}`);
}

export function rejectBuyIn(room: RoomState, playerId: string, requestId: string): void {
  requireHost(room, playerId);
  const index = room.pendingBuyIns.findIndex((request) => request.id === requestId);
  if (index < 0) throw new Error("带入申请不存在");
  const [request] = room.pendingBuyIns.splice(index, 1);
  addReplay(room, "buyInRejected", `房主拒绝 ${request.nickname} 带入 ${request.amount}`);
}

function validateBuyIn(room: RoomState, participant: Participant, amount: number): void {
  if (participant.seatIndex === null) throw new Error("请先入座");
  const cleanAmount = Math.floor(amount);
  if (cleanAmount < room.settings.minBuyIn || cleanAmount > room.settings.maxBuyIn) throw new Error("买入超出房间限制");
}

export function updateSettings(room: RoomState, playerId: string, settings: Partial<RoomSettings>): void {
  requireHost(room, playerId);
  const next = normalizeSettings({ ...room.settings, ...settings });
  if (room.hand && room.hand.street !== "settled") {
    room.settings.thinkingTimeSeconds = next.thinkingTimeSeconds;
    room.settings.drawTimeSeconds = next.drawTimeSeconds;
    room.settings.settlementSeconds = next.settlementSeconds;
    room.settings.gameDurationMinutes = next.gameDurationMinutes;
    if (room.hand.currentSeat !== null && !room.paused) resetTimer(room);
    addReplay(room, "settings", `房主更新计时：下注 ${room.settings.thinkingTimeSeconds}s / 换牌 ${room.settings.drawTimeSeconds}s / 结算 ${room.settings.settlementSeconds}s / 时长 ${room.settings.gameDurationMinutes || "不限"}${room.settings.gameDurationMinutes ? "分钟" : ""}`);
    return;
  }
  resizeSeats(room, next.maxPlayers);
  room.settings = next;
}

function sanitizeTableName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 24) || defaultSettings.tableName;
}

function normalizeSettings(settings: Partial<RoomSettings>): RoomSettings {
  return {
    ...defaultSettings,
    ...settings,
    tableName: sanitizeTableName(settings.tableName ?? defaultSettings.tableName),
    ante: Math.max(0, Math.floor(settings.ante ?? defaultSettings.ante)),
    minBuyIn: Math.max(1, Math.floor(settings.minBuyIn ?? defaultSettings.minBuyIn)),
    maxBuyIn: Math.max(1, Math.floor(settings.maxBuyIn ?? defaultSettings.maxBuyIn)),
    thinkingTimeSeconds: Math.max(5, Math.floor(settings.thinkingTimeSeconds ?? defaultSettings.thinkingTimeSeconds)),
    drawTimeSeconds: Math.max(5, Math.floor(settings.drawTimeSeconds ?? settings.thinkingTimeSeconds ?? defaultSettings.drawTimeSeconds)),
    settlementSeconds: normalizeSettlementSeconds(settings.settlementSeconds ?? defaultSettings.settlementSeconds),
    gameDurationMinutes: Math.max(0, Math.floor(settings.gameDurationMinutes ?? defaultSettings.gameDurationMinutes)),
    rakePercent: Math.min(100, Math.max(0, Number(settings.rakePercent ?? defaultSettings.rakePercent))),
    rakeCap: Math.max(0, Math.floor(settings.rakeCap ?? defaultSettings.rakeCap)),
    maxPlayers: Math.min(6, Math.max(2, Math.floor(settings.maxPlayers ?? defaultSettings.maxPlayers)))
  };
}

function normalizeSettlementSeconds(value: number): number {
  const seconds = Math.floor(Number(value));
  return [3, 5, 10].includes(seconds) ? seconds : defaultSettings.settlementSeconds;
}

function resizeSeats(room: RoomState, maxPlayers: number): void {
  if (maxPlayers === room.seats.length) return;
  if (maxPlayers < room.seats.length) {
    const occupiedRemovedSeat = room.seats.slice(maxPlayers).find((seat) => seat.playerId);
    if (occupiedRemovedSeat) throw new Error("缩小人数前请先让高号座位玩家起立");
    room.seats = room.seats.slice(0, maxPlayers);
    for (const participant of room.participants.values()) {
      if (participant.seatIndex !== null && participant.seatIndex >= maxPlayers) participant.seatIndex = null;
    }
    return;
  }
  for (let index = room.seats.length; index < maxPlayers; index += 1) {
    room.seats.push(createSeat(index));
  }
}

function gameEndsAt(room: RoomState): number | null {
  if (!room.gameStartedAt || room.settings.gameDurationMinutes <= 0) return null;
  return room.gameStartedAt + room.settings.gameDurationMinutes * 60_000;
}

function isGameTimeExpired(room: RoomState): boolean {
  const endsAt = gameEndsAt(room);
  return endsAt !== null && Date.now() >= endsAt;
}

export function startHand(room: RoomState, playerId: string): void {
  requireHost(room, playerId);
  if (room.hand && room.hand.street !== "settled") throw new Error("当前手牌尚未结束");
  if (isGameTimeExpired(room)) throw new Error("游戏时长已结束");
  if (!room.gameStartedAt) room.gameStartedAt = Date.now();
  applyPendingBuyIns(room);
  const active = room.seats.filter((seat) => seat.playerId && seat.stack > 0);
  if (active.length < 2) throw new Error("至少需要 2 名有筹码玩家");
  room.dealerSeat = nextDealerSeat(room, active);

  const deck = shuffle(makeDeck());
  const board: BoardState = { top: [], bottom: [] };
  for (const seat of room.seats) {
    seat.handStartStack = seat.playerId ? seat.stack : 0;
    seat.folded = !seat.playerId || seat.stack <= 0;
    seat.allIn = false;
    seat.currentBet = 0;
    seat.totalContribution = 0;
    seat.lastAction = null;
    seat.acted = false;
    seat.drawCount = null;
    seat.pendingDraw = null;
    seat.hand = [];
    if (!seat.folded) {
      postChips(seat, Math.min(room.settings.ante, seat.stack));
      for (let i = 0; i < 5; i += 1) seat.hand.push(draw(deck));
    }
  }
  for (let i = 0; i < 3; i += 1) {
    board.top.push(draw(deck));
    board.bottom.push(draw(deck));
  }
  const runout: BoardState = { top: [], bottom: [] };
  for (let i = 0; i < 2; i += 1) {
    runout.top.push(draw(deck));
    runout.bottom.push(draw(deck));
  }

  room.paused = false;
  room.hand = {
    id: uid("h_"),
    deck,
    street: "flopBet",
    board,
    runout,
    discards: [],
    currentSeat: null,
    currentBet: 0,
    minRaise: 1,
    timerEndsAt: null,
    riverHadBet: false,
    riverAggressorId: null,
    drawReveal: null,
    showdown: null
  };
  addReplay(room, "handStarted", `新一手开始，ante ${room.settings.ante}`, {
    handId: room.hand.id,
    board: room.hand.board,
    pot: totalPot(room),
    dealerSeat: room.dealerSeat
  });
  beginBettingRound(room, "flopBet");
}

function applyPendingBuyIns(room: RoomState): void {
  for (const seat of room.seats) {
    if (seat.pendingBuyIn > 0) {
      seat.stack += seat.pendingBuyIn;
      addReplay(room, "buyInApplied", `${seat.nickname ?? "玩家"} 下局积分 ${seat.pendingBuyIn} 已生效`);
      seat.pendingBuyIn = 0;
    }
  }
}

export function pauseGame(room: RoomState, playerId: string): void {
  requireHost(room, playerId);
  room.paused = true;
  if (room.hand) room.hand.timerEndsAt = null;
  addReplay(room, "pause", "房主暂停游戏");
}

export function resumeGame(room: RoomState, playerId: string): void {
  requireHost(room, playerId);
  room.paused = false;
  if (room.hand && room.hand.currentSeat !== null) resetTimer(room);
  addReplay(room, "resume", "房主继续游戏");
}

export function sendChat(room: RoomState, playerId: string, text: string): ChatMessage {
  const participant = requireParticipant(room, playerId);
  const cleanText = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!cleanText) throw new Error("消息不能为空");
  const message: ChatMessage = {
    id: uid("m_"),
    playerId,
    nickname: participant.nickname,
    role: participant.role,
    text: cleanText,
    at: Date.now()
  };
  room.chat.push(message);
  room.chat = room.chat.slice(-100);
  return message;
}

export function act(room: RoomState, playerId: string, action: ClientAction): void {
  const seat = requireActionSeat(room, playerId);
  const hand = requireHand(room);
  if (room.paused) throw new Error("游戏已暂停");
  if (!hand.street.endsWith("Bet")) throw new Error("当前不是下注阶段");
  const legal = legalActions(room, seat);
  const toCall = legal.toCall;

  if (action.type === "fold") {
    seat.folded = true;
    seat.lastAction = "fold";
  } else if (action.type === "check") {
    if (!legal.canCheck) throw new Error("不能 check");
    seat.lastAction = "check";
    seat.acted = true;
  } else if (action.type === "call") {
    callAmount(seat, toCall);
    seat.lastAction = toCall > 0 ? `call ${toCall}` : "check";
    seat.acted = true;
  } else if (action.type === "bet" || action.type === "raise") {
    const target = Math.floor(action.amount);
    if (target < legal.minRaiseTo || target > legal.maxRaiseTo) throw new Error("下注尺度不合法");
    const wasAggressive = target > hand.currentBet;
    putToBet(room, seat, target);
    hand.minRaise = Math.max(1, target - hand.currentBet);
    hand.currentBet = target;
    room.seats.forEach((other) => {
      if (!other.folded && !other.allIn) other.acted = other.index === seat.index;
    });
    seat.lastAction = action.type === "bet" ? `bet ${target}` : `raise ${target}`;
    if (wasAggressive) markRiverAggressor(hand, seat, target);
  } else if (action.type === "all-in") {
    const target = Math.min(seat.currentBet + seat.stack, legal.maxRaiseTo);
    const wasAggressive = target > hand.currentBet;
    putToBet(room, seat, target);
    if (target > hand.currentBet) {
      hand.minRaise = Math.max(hand.minRaise, target - hand.currentBet);
      hand.currentBet = target;
      room.seats.forEach((other) => {
        if (!other.folded && !other.allIn) other.acted = other.index === seat.index;
      });
    } else {
      seat.acted = true;
    }
    seat.lastAction = `all-in ${target}`;
    if (wasAggressive) markRiverAggressor(hand, seat, target);
  }

  addReplay(room, "act", `${seat.nickname} ${seat.lastAction}`, {
    playerId: seat.playerId,
    seatIndex: seat.index,
    action,
    currentBet: seat.currentBet,
    totalContribution: seat.totalContribution,
    pot: totalPot(room),
    street: hand.street
  });
  advanceAfterAction(room);
}

export function drawSelect(room: RoomState, playerId: string, indices: number[]): Card | null {
  const seat = requireDrawSeat(room, playerId);
  const hand = requireHand(room);
  if (room.paused) throw new Error("游戏已暂停");
  const unique = Array.from(new Set(indices)).sort((a, b) => b - a);
  if (unique.length > 3 || unique.some((index) => index < 0 || index > 4)) throw new Error("最多换 0-3 张");
  seat.drawCount = unique.length;
  seat.lastAction = `draw ${unique.length}`;
  addReplay(room, "draw", `${seat.nickname} 换 ${unique.length} 张`, {
    playerId: seat.playerId,
    seatIndex: seat.index,
    count: unique.length,
    street: hand.street
  });

  if (unique.length === 0) {
    seat.acted = true;
    advanceAfterDraw(room);
    return null;
  }
  if (unique.length === 1) {
    const index = unique[0];
    const discarded = seat.hand[index];
    const reveal = drawReplacement(hand, [discarded]);
    seat.pendingDraw = { index, reveal, discarded };
    seat.lastAction = "决定明牌";
    hand.drawReveal = { playerId: seat.playerId!, nickname: seat.nickname ?? "玩家", card: reveal, status: "pending" };
    addReplay(room, "drawRevealShown", `${seat.nickname} 换一张明牌 ${cardToString(reveal)}，等待决定是否要第一张明牌`, hand.drawReveal);
    return reveal;
  }
  const discarded = unique.map((index) => seat.hand[index]);
  for (const index of unique) seat.hand[index] = drawReplacement(hand, discarded);
  hand.discards.push(...discarded);
  seat.acted = true;
  advanceAfterDraw(room);
  return null;
}

export function drawRevealDecision(room: RoomState, playerId: string, accept: boolean): void {
  const seat = requireDrawSeat(room, playerId);
  const hand = requireHand(room);
  if (!seat.pendingDraw) throw new Error("没有待确认明牌");
  const { index, reveal, discarded } = seat.pendingDraw;
  if (accept) {
    seat.hand[index] = reveal;
    hand.discards.push(discarded);
  } else {
    seat.hand[index] = drawReplacement(hand, [discarded, reveal]);
    hand.discards.push(discarded, reveal);
  }
  seat.pendingDraw = null;
  hand.drawReveal = null;
  seat.lastAction = accept ? "要第一张" : "不要第一张";
  seat.acted = true;
  addReplay(room, "drawReveal", `${seat.nickname} ${accept ? "要了第一张明牌" : "不要第一张明牌，改拿暗牌"}`, {
    playerId: seat.playerId,
    nickname: seat.nickname,
    accept,
    reveal,
    discarded
  });
  advanceAfterDraw(room);
}

function drawReplacement(hand: HandState, excluded: Card[]): Card {
  if (hand.deck.length === 0) reshuffleDiscardsIntoDeck(hand, excluded);
  return draw(hand.deck);
}

function reshuffleDiscardsIntoDeck(hand: HandState, excluded: Card[]): void {
  const blocked = new Set(excluded.map(cardToString));
  const reusable = hand.discards.filter((card) => !blocked.has(cardToString(card)));
  if (reusable.length === 0) throw new Error("牌堆和可用弃牌都不够换牌");
  hand.discards = hand.discards.filter((card) => blocked.has(cardToString(card)));
  hand.deck.push(...shuffle(reusable));
}

function drawRunout(hand: HandState, board: keyof BoardState): Card {
  const card = hand.runout[board].shift();
  if (!card) throw new Error("预发公共牌不足");
  return card;
}

export function autoTimeout(room: RoomState): void {
  const hand = room.hand;
  if (!hand || room.paused || hand.currentSeat === null || !hand.timerEndsAt || Date.now() < hand.timerEndsAt) return;
  const seat = room.seats[hand.currentSeat];
  if (hand.street.endsWith("Bet")) {
    const legal = legalActions(room, seat);
    act(room, seat.playerId!, legal.canCheck ? { type: "check" } : { type: "fold" });
  } else if (hand.street.endsWith("Draw")) {
    if (seat.pendingDraw) drawRevealDecision(room, seat.playerId!, false);
    else drawSelect(room, seat.playerId!, []);
  }
}

export function publicState(room: RoomState, viewerId: string): PublicRoomState {
  const participant = room.participants.get(viewerId);
  const viewerRole = participant?.role ?? "spectator";
  return {
    roomId: room.id,
    hostId: room.hostId,
    settings: room.settings,
    paused: room.paused,
    street: room.hand?.street ?? "idle",
    board: room.hand?.board ?? { top: [], bottom: [] },
    pot: totalPot(room),
    handId: room.hand?.id ?? null,
    gameStartedAt: room.gameStartedAt,
    gameEndsAt: gameEndsAt(room),
    rakeTotal: room.rakeTotal,
    dealerSeat: room.dealerSeat,
    currentSeat: room.hand?.currentSeat ?? null,
    timerEndsAt: room.hand?.timerEndsAt ?? null,
    drawReveal: room.hand?.drawReveal ?? null,
    seats: room.seats.map((seat) => publicSeat(room, seat, viewerId)),
    pendingBuyIns: room.pendingBuyIns,
    chat: room.chat,
    replay: room.replay,
    showdown: room.hand?.showdown ?? null,
    viewerRole,
    viewerId
  };
}

export function privateState(room: RoomState, playerId: string): PrivateState | null {
  const participant = room.participants.get(playerId);
  if (!participant || participant.seatIndex === null) return null;
  const seat = room.seats[participant.seatIndex];
  if (!seat.playerId || seat.hand.length === 0) return null;
  return {
    playerId,
    hand: seat.hand,
    actionRequired: room.hand?.currentSeat === seat.index && !!room.hand.street.endsWith("Bet"),
    drawRequired: room.hand?.currentSeat === seat.index && !!room.hand.street.endsWith("Draw"),
    pendingDrawReveal: seat.pendingDraw?.reveal ?? null,
    legalActions: room.hand?.currentSeat === seat.index && room.hand.street.endsWith("Bet") ? legalActions(room, seat) : null
  };
}

function publicSeat(room: RoomState, seat: SeatState, viewerId: string): PublicSeat {
  const isViewer = seat.playerId === viewerId;
  const shownIds = room.hand?.showdown?.shownPlayerIds ?? [];
  const showCards = isViewer || (!!seat.playerId && shownIds.includes(seat.playerId));
  return {
    index: seat.index,
    playerId: seat.playerId,
    nickname: seat.nickname,
    stack: seat.stack,
    buyIn: seat.buyIn,
    connected: seat.connected,
    folded: seat.folded,
    allIn: seat.allIn,
    currentBet: seat.currentBet,
    totalContribution: seat.totalContribution,
    pendingBuyIn: seat.pendingBuyIn,
    rakePaid: seat.rakePaid,
    lastAction: seat.lastAction,
    drawCount: seat.drawCount,
    cards: seat.hand.length ? showCards ? seat.hand : seat.hand.map(() => "back" as const) : undefined
  };
}

function beginBettingRound(room: RoomState, street: Street): void {
  const hand = requireHand(room);
  hand.street = street;
  hand.currentBet = 0;
  hand.minRaise = 1;
  for (const seat of room.seats) {
    seat.currentBet = 0;
    seat.acted = seat.folded || seat.allIn;
    seat.lastAction = seat.folded || seat.lastAction === "要第一张" || seat.lastAction === "不要第一张" ? seat.lastAction : null;
  }
  hand.currentSeat = nextActionSeat(room, room.dealerSeat ?? -1);
  resetTimer(room);
  if (hand.currentSeat === null) advanceStreet(room);
}

function beginDrawRound(room: RoomState, street: Street): void {
  const hand = requireHand(room);
  hand.street = street;
  for (const seat of room.seats) {
    seat.acted = seat.folded || seat.allIn;
    seat.pendingDraw = null;
    seat.drawCount = seat.folded ? seat.drawCount : null;
  }
  hand.currentSeat = nextDrawSeat(room, room.dealerSeat ?? -1);
  hand.drawReveal = null;
  resetTimer(room);
  if (hand.currentSeat === null) advanceAfterDraw(room);
}

function advanceAfterAction(room: RoomState): void {
  const hand = requireHand(room);
  if (remainingPlayers(room).length <= 1) {
    settle(room);
    return;
  }
  if (bettingComplete(room)) {
    advanceStreet(room);
    return;
  }
  hand.currentSeat = nextActionSeat(room, hand.currentSeat ?? -1);
  resetTimer(room);
}

function advanceStreet(room: RoomState): void {
  const hand = requireHand(room);
  if (hand.street === "flopBet") beginDrawRound(room, "flopDraw");
  else if (hand.street === "turnBet") beginDrawRound(room, "turnDraw");
  else if (hand.street === "riverBet") settle(room);
}

function advanceAfterDraw(room: RoomState): void {
  const hand = requireHand(room);
  const next = nextDrawSeat(room, hand.currentSeat ?? -1);
  if (next !== null) {
    hand.currentSeat = next;
    resetTimer(room);
    return;
  }
  if (hand.street === "flopDraw") {
    hand.board.top.push(drawRunout(hand, "top"));
    hand.board.bottom.push(drawRunout(hand, "bottom"));
    addReplay(room, "turn", `Turn 发出 ${cardToString(hand.board.top.at(-1)!)} / ${cardToString(hand.board.bottom.at(-1)!)}`, {
      board: hand.board,
      pot: totalPot(room)
    });
    beginBettingRound(room, "turnBet");
  } else if (hand.street === "turnDraw") {
    hand.board.top.push(drawRunout(hand, "top"));
    hand.board.bottom.push(drawRunout(hand, "bottom"));
    addReplay(room, "river", `River 发出 ${cardToString(hand.board.top.at(-1)!)} / ${cardToString(hand.board.bottom.at(-1)!)}`, {
      board: hand.board,
      pot: totalPot(room)
    });
    beginBettingRound(room, "riverBet");
  }
}

function settle(room: RoomState): void {
  const hand = requireHand(room);
  hand.street = "settled";
  hand.currentSeat = null;
  hand.timerEndsAt = null;
  const showdown = scoreShowdown(room);
  const rakeByPlayer = allocateHandRake(room, showdown.rakeTotal);
  for (const seat of room.seats) {
    if (!seat.playerId) continue;
    seat.rakePaid += rakeByPlayer.get(seat.playerId) ?? 0;
  }
  room.rakeTotal += showdown.rakeTotal;
  showdown.playerResults = buildPlayerSettlement(room, showdown, rakeByPlayer);
  hand.showdown = showdown;
  addReplay(room, "settled", "手牌结算完成", {
    ...showdown,
    board: hand.board,
    pot: totalPot(room),
    shownHands: room.seats
      .filter((seat) => seat.playerId && showdown.shownPlayerIds.includes(seat.playerId))
      .map((seat) => ({
        playerId: seat.playerId!,
        nickname: seat.nickname ?? "玩家",
        cards: seat.hand
      }))
  });
}

function allocateHandRake(room: RoomState, rakeTotal: number): Map<string, number> {
  const rakeByPlayer = new Map<string, number>();
  if (rakeTotal <= 0) return rakeByPlayer;
  const contributors = room.seats.filter((seat) => seat.playerId && seat.totalContribution > 0);
  const contributionTotal = contributors.reduce((sum, seat) => sum + seat.totalContribution, 0);
  if (contributionTotal <= 0) return rakeByPlayer;
  const shares = contributors.map((seat) => {
    const raw = (rakeTotal * seat.totalContribution) / contributionTotal;
    return {
      playerId: seat.playerId!,
      base: Math.floor(raw),
      fraction: raw - Math.floor(raw)
    };
  });
  let assigned = shares.reduce((sum, share) => sum + share.base, 0);
  for (const share of shares) rakeByPlayer.set(share.playerId, share.base);
  shares.sort((a, b) => b.fraction - a.fraction);
  for (const share of shares) {
    if (assigned >= rakeTotal) break;
    rakeByPlayer.set(share.playerId, (rakeByPlayer.get(share.playerId) ?? 0) + 1);
    assigned += 1;
  }
  return rakeByPlayer;
}

function buildPlayerSettlement(room: RoomState, showdown: ShowdownResult, rakeByPlayer: Map<string, number>): PlayerSettlement[] {
  const awardsByPlayer = new Map<string, number>();
  for (const award of showdown.potAwards) {
    const share = Math.floor(award.amount / award.winners.length);
    let remainder = award.amount - share * award.winners.length;
    for (const playerId of award.winners) {
      awardsByPlayer.set(playerId, (awardsByPlayer.get(playerId) ?? 0) + share + (remainder > 0 ? 1 : 0));
      remainder -= 1;
    }
  }
  return room.seats
    .filter((seat) => seat.playerId && (seat.handStartStack > 0 || seat.totalContribution > 0 || awardsByPlayer.has(seat.playerId)))
    .map((seat) => ({
      playerId: seat.playerId!,
      nickname: seat.nickname ?? seat.playerId!,
      startStack: seat.handStartStack,
      contribution: seat.totalContribution,
      awarded: awardsByPlayer.get(seat.playerId!) ?? 0,
      endStack: seat.stack,
      net: seat.stack - seat.handStartStack,
      rakePaid: rakeByPlayer.get(seat.playerId!) ?? 0,
      points: showdown.points[seat.playerId!] ?? 0,
      folded: seat.folded
    }));
}

function scoreShowdown(room: RoomState): ShowdownResult {
  const contenders = remainingPlayers(room);
  if (contenders.length === 1) {
    const winner = contenders[0];
    const awards = awardPots(room, [winner]);
    return {
      boards: [],
      points: { [winner.playerId!]: 3 },
      potAwards: awards,
      playerResults: [],
      rakeTotal: awards.reduce((sum, award) => sum + award.rake, 0),
      noShowdown: true,
      shownPlayerIds: [],
      showOrder: [],
      winnerIds: [winner.playerId!]
    };
  }
  const hand = requireHand(room);
  const boardResults: ShowdownBoardResult[] = [];
  const points: Record<string, number> = {};
  for (const seat of contenders) points[seat.playerId!] = 0;

  for (const boardName of ["top", "bottom"] as const) {
    const ranks = contenders.map((seat) => ({
      seat,
      rank: evaluateOmahaBoard(seat.hand, hand.board[boardName])
    }));
    const winners = bestSeats(ranks);
    for (const winner of winners) points[winner.playerId!] += 1 / winners.length;
    boardResults.push({
      board: boardName,
      winners: winners.map((seat) => seat.playerId!),
      descriptions: Object.fromEntries(ranks.map(({ seat, rank }) => [seat.playerId!, rank.description]))
    });
  }

  const handRanks = contenders.map((seat) => ({
    seat,
    rank: evaluateHandBoard(seat.hand)
  }));
  const handWinners = bestSeats(handRanks);
  for (const winner of handWinners) points[winner.playerId!] += 1 / handWinners.length;
  boardResults.push({
    board: "hand",
    winners: handWinners.map((seat) => seat.playerId!),
    descriptions: Object.fromEntries(handRanks.map(({ seat, rank }) => [seat.playerId!, rank.description]))
  });

  const potAwards = settleSidePots(room, points);
  const winnerIds = Array.from(new Set(potAwards.flatMap((award) => award.winners)));
  const { shownPlayerIds, showOrder } = showdownVisibility(room, contenders, winnerIds);
  return {
    boards: boardResults,
    points,
    potAwards,
    playerResults: [],
    rakeTotal: potAwards.reduce((sum, award) => sum + award.rake, 0),
    noShowdown: false,
    shownPlayerIds,
    showOrder,
    winnerIds
  };
}

function markRiverAggressor(hand: HandState, seat: SeatState, _target: number): void {
  if (hand.street !== "riverBet") return;
  hand.riverHadBet = true;
  hand.riverAggressorId = seat.playerId;
}

function showdownVisibility(room: RoomState, contenders: SeatState[], winnerIds: string[]): { shownPlayerIds: string[]; showOrder: string[] } {
  const hand = requireHand(room);
  const seatOrder = contenders
    .filter((seat) => seat.playerId)
    .sort((a, b) => a.index - b.index)
    .map((seat) => seat.playerId!);
  if (contenders.length >= 3 || !hand.riverHadBet) {
    return { shownPlayerIds: seatOrder, showOrder: seatOrder };
  }
  const forced = [hand.riverAggressorId, ...winnerIds].filter((id): id is string => !!id);
  const unique = Array.from(new Set(forced));
  return { shownPlayerIds: unique, showOrder: unique };
}

function bestSeats(entries: Array<{ seat: SeatState; rank: ReturnType<typeof evaluateHandBoard> }>): SeatState[] {
  let best = entries[0].rank;
  for (const entry of entries.slice(1)) {
    if (compareHandRanks(entry.rank, best) > 0) best = entry.rank;
  }
  return entries.filter((entry) => compareHandRanks(entry.rank, best) === 0).map((entry) => entry.seat);
}

function settleSidePots(room: RoomState, points: Record<string, number>): Array<{ amount: number; rake: number; winners: string[] }> {
  const awards: Array<{ amount: number; rake: number; winners: string[] }> = [];
  const contributors = room.seats.filter((seat) => seat.totalContribution > 0);
  const levels = Array.from(new Set(contributors.map((seat) => seat.totalContribution))).sort((a, b) => a - b);
  let previous = 0;
  let rakeTaken = 0;
  for (const level of levels) {
    const potSeats = contributors.filter((seat) => seat.totalContribution >= level);
    const gross = (level - previous) * potSeats.length;
    const eligible = potSeats.filter((seat) => !seat.folded && seat.playerId);
    if (gross <= 0 || eligible.length === 0) {
      previous = level;
      continue;
    }
    const rake = rakeForPot(room, gross, rakeTaken);
    rakeTaken += rake;
    const amount = gross - rake;
    const maxPoints = Math.max(...eligible.map((seat) => points[seat.playerId!] ?? 0));
    const winners = eligible.filter((seat) => (points[seat.playerId!] ?? 0) === maxPoints);
    splitAward(amount, winners);
    awards.push({ amount, rake, winners: winners.map((seat) => seat.playerId!) });
    previous = level;
  }
  return awards;
}

function awardPots(room: RoomState, winners: SeatState[]): Array<{ amount: number; rake: number; winners: string[] }> {
  const gross = totalPot(room);
  const rake = rakeForPot(room, gross, 0);
  const amount = gross - rake;
  splitAward(amount, winners);
  return [{ amount, rake, winners: winners.map((seat) => seat.playerId!) }];
}

function rakeForPot(room: RoomState, amount: number, alreadyTaken: number): number {
  if (room.settings.rakePercent <= 0 || amount <= 0) return 0;
  const byPercent = Math.floor(amount * (room.settings.rakePercent / 100));
  if (room.settings.rakeCap <= 0) return Math.min(amount, byPercent);
  const capLeft = Math.max(0, room.settings.rakeCap - alreadyTaken);
  return Math.min(amount, byPercent, capLeft);
}

function splitAward(amount: number, winners: SeatState[]): void {
  const share = Math.floor(amount / winners.length);
  let remainder = amount - share * winners.length;
  for (const winner of winners) {
    winner.stack += share + (remainder > 0 ? 1 : 0);
    remainder -= 1;
  }
}

function legalActions(room: RoomState, seat: SeatState): LegalActions {
  const hand = requireHand(room);
  const toCall = Math.max(0, hand.currentBet - seat.currentBet);
  const maxTarget = Math.min(seat.currentBet + seat.stack, hand.currentBet + totalPot(room) + toCall);
  const minTarget = hand.currentBet === 0 ? Math.min(seat.stack, 1) : hand.currentBet + hand.minRaise;
  return {
    toCall,
    minBet: hand.currentBet === 0 ? 1 : 0,
    minRaiseTo: Math.min(maxTarget, minTarget),
    maxRaiseTo: Math.max(seat.currentBet, maxTarget),
    stack: seat.stack,
    canCheck: toCall === 0,
    canRaise: seat.stack > toCall && maxTarget > hand.currentBet,
    canFold: true
  };
}

function hasOtherHostCandidates(room: RoomState, playerId: string): boolean {
  return room.seats.some((seat) => seat.playerId && seat.playerId !== playerId);
}

function bettingComplete(room: RoomState): boolean {
  const open = room.seats.filter((seat) => !seat.folded && !seat.allIn);
  if (open.length <= 1) return true;
  return open.every((seat) => seat.acted && seat.currentBet === requireHand(room).currentBet);
}

function nextDealerSeat(room: RoomState, activeSeats: SeatState[]): number {
  const activeIndexes = new Set(activeSeats.map((seat) => seat.index));
  if (room.dealerSeat === null || !activeIndexes.has(room.dealerSeat)) return activeSeats[0].index;
  for (let offset = 1; offset <= room.seats.length; offset += 1) {
    const index = (room.dealerSeat + offset) % room.seats.length;
    if (activeIndexes.has(index)) return index;
  }
  return activeSeats[0].index;
}

function nextActionSeat(room: RoomState, from: number): number | null {
  for (let offset = 1; offset <= room.seats.length; offset += 1) {
    const index = (from + offset + room.seats.length) % room.seats.length;
    const seat = room.seats[index];
    if (!seat.folded && !seat.allIn && seat.playerId) return index;
  }
  return null;
}

function nextDrawSeat(room: RoomState, from: number): number | null {
  for (let offset = 1; offset <= room.seats.length; offset += 1) {
    const index = (from + offset + room.seats.length) % room.seats.length;
    const seat = room.seats[index];
    if (!seat.folded && !seat.allIn && seat.playerId && !seat.acted) return index;
  }
  return null;
}

function remainingPlayers(room: RoomState): SeatState[] {
  return room.seats.filter((seat) => seat.playerId && !seat.folded);
}

function totalPot(room: RoomState): number {
  return room.seats.reduce((sum, seat) => sum + seat.totalContribution, 0);
}

function postChips(seat: SeatState, amount: number): void {
  const paid = Math.min(amount, seat.stack);
  seat.stack -= paid;
  seat.currentBet += paid;
  seat.totalContribution += paid;
  if (seat.stack === 0) seat.allIn = true;
}

function callAmount(seat: SeatState, amount: number): void {
  postChips(seat, amount);
}

function putToBet(room: RoomState, seat: SeatState, target: number): void {
  const delta = Math.max(0, target - seat.currentBet);
  postChips(seat, delta);
}

function resetTimer(room: RoomState): void {
  if (!room.hand || room.paused || room.hand.currentSeat === null) return;
  const seconds = room.hand.street.endsWith("Draw") ? room.settings.drawTimeSeconds : room.settings.thinkingTimeSeconds;
  room.hand.timerEndsAt = Date.now() + seconds * 1000;
}

function requireParticipant(room: RoomState, playerId: string): Participant {
  const participant = room.participants.get(playerId);
  if (!participant) throw new Error("请先加入房间");
  return participant;
}

function requireHost(room: RoomState, playerId: string): void {
  if (room.hostId !== playerId) throw new Error("只有房主可以操作");
}

function requireHand(room: RoomState): HandState {
  if (!room.hand) throw new Error("还没有开始手牌");
  return room.hand;
}

function requireActionSeat(room: RoomState, playerId: string): SeatState {
  const hand = requireHand(room);
  const participant = requireParticipant(room, playerId);
  if (participant.seatIndex === null || hand.currentSeat !== participant.seatIndex) throw new Error("还没轮到你行动");
  return room.seats[participant.seatIndex];
}

function requireDrawSeat(room: RoomState, playerId: string): SeatState {
  const hand = requireHand(room);
  const participant = requireParticipant(room, playerId);
  if (participant.seatIndex === null || hand.currentSeat !== participant.seatIndex) throw new Error("还没轮到你换牌");
  if (!hand.street.endsWith("Draw")) throw new Error("当前不是换牌阶段");
  return room.seats[participant.seatIndex];
}

function addReplay(room: RoomState, type: string, message: string, payload?: unknown): ReplayEvent {
  const event = { id: uid("e_"), at: Date.now(), type, message, payload };
  room.replay.push(event);
  return event;
}
