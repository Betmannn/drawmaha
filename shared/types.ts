export type Suit = "s" | "h" | "d" | "c";
export type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "T"
  | "J"
  | "Q"
  | "K"
  | "A";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export interface RoomSettings {
  tableName: string;
  ante: number;
  minBuyIn: number;
  maxBuyIn: number;
  thinkingTimeSeconds: number;
  drawTimeSeconds: number;
  settlementSeconds: number;
  gameDurationMinutes: number;
  rakePercent: number;
  rakeCap: number;
  maxPlayers: number;
}

export type Role = "host" | "player" | "spectator";
export type Street = "idle" | "flopBet" | "flopDraw" | "turnBet" | "turnDraw" | "riverBet" | "settled";

export interface PublicSeat {
  index: number;
  playerId: string | null;
  nickname: string | null;
  stack: number;
  buyIn: number;
  connected: boolean;
  folded: boolean;
  allIn: boolean;
  currentBet: number;
  totalContribution: number;
  pendingBuyIn: number;
  rakePaid: number;
  lastAction: string | null;
  drawCount: number | null;
  cards?: (Card | "back")[];
}

export interface PrivateState {
  playerId: string;
  hand: Card[];
  actionRequired: boolean;
  drawRequired: boolean;
  pendingDrawReveal: Card | null;
  legalActions: LegalActions | null;
}

export interface LegalActions {
  toCall: number;
  minBet: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  stack: number;
  canCheck: boolean;
  canRaise: boolean;
  canFold: boolean;
}

export interface BoardState {
  top: Card[];
  bottom: Card[];
}

export interface ChatMessage {
  id: string;
  playerId: string;
  nickname: string;
  role: Role;
  text: string;
  at: number;
}

export interface BuyInRequest {
  id: string;
  playerId: string;
  nickname: string;
  amount: number;
  at: number;
}

export interface ReplayEvent {
  id: string;
  at: number;
  type: string;
  message: string;
  payload?: unknown;
}

export interface ShowdownBoardResult {
  board: "top" | "bottom" | "hand";
  winners: string[];
  descriptions: Record<string, string>;
}

export interface PlayerSettlement {
  playerId: string;
  nickname: string;
  startStack: number;
  contribution: number;
  awarded: number;
  endStack: number;
  net: number;
  rakePaid: number;
  points: number;
  folded: boolean;
}

export interface ShowdownResult {
  boards: ShowdownBoardResult[];
  points: Record<string, number>;
  potAwards: Array<{ amount: number; rake: number; winners: string[] }>;
  playerResults: PlayerSettlement[];
  rakeTotal: number;
  noShowdown: boolean;
  shownPlayerIds: string[];
  showOrder: string[];
  winnerIds: string[];
}

export interface DrawRevealPublic {
  playerId: string;
  nickname: string;
  card: Card;
  status: "pending";
}

export interface PublicRoomState {
  roomId: string;
  hostId: string;
  settings: RoomSettings;
  paused: boolean;
  street: Street;
  board: BoardState;
  pot: number;
  handId: string | null;
  gameStartedAt: number | null;
  gameEndsAt: number | null;
  rakeTotal: number;
  dealerSeat: number | null;
  currentSeat: number | null;
  timerEndsAt: number | null;
  drawReveal: DrawRevealPublic | null;
  seats: PublicSeat[];
  pendingBuyIns: BuyInRequest[];
  chat: ChatMessage[];
  replay: ReplayEvent[];
  showdown: ShowdownResult | null;
  viewerRole: Role;
  viewerId: string;
}

export type ClientAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "bet"; amount: number }
  | { type: "raise"; amount: number }
  | { type: "all-in" };
