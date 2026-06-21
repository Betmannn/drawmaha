import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { Fragment } from "react";
import { io, Socket } from "socket.io-client";
import { Armchair, Eye, History, MessageSquare, Pause, Play, Send, Settings, Trophy, X } from "lucide-react";
import type { Card, ChatMessage, ClientAction, PlayerSettlement, PrivateState, PublicRoomState, RoomSettings } from "../shared/types";
import { cardToString, suitSymbol } from "../shared/cards";
import { evaluateHandBoard, evaluateOmahaCurrent } from "../shared/evaluator";

type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
type UtilityPanel = "settings" | "score" | "chat" | "replay" | null;

const socket: Socket = io();

const defaultSettings: RoomSettings = {
  maxPlayers: 6,
  tableName: "抓马哈 6max",
  ante: 10,
  minBuyIn: 500,
  maxBuyIn: 5000,
  thinkingTimeSeconds: 30,
  gameDurationMinutes: 0,
  rakePercent: 0,
  rakeCap: 0
};

function getPlayerId(): string {
  const existing = localStorage.getItem("zhuamaha.playerId");
  if (existing) return existing;
  const next = `p_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  localStorage.setItem("zhuamaha.playerId", next);
  return next;
}

const playerId = getPlayerId();

function emit<T>(event: string, payload: unknown): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (ack: Ack<T>) => {
      if (!ack?.ok) reject(new Error(ack?.error ?? "操作失败"));
      else resolve(ack.data);
    });
  });
}

export function App() {
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [privateState, setPrivateState] = useState<PrivateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createNickname, setCreateNickname] = useState(localStorage.getItem("zhuamaha.nickname") ?? "");
  const [joinNickname, setJoinNickname] = useState(localStorage.getItem("zhuamaha.nickname") ?? "");
  const [roomIdInput, setRoomIdInput] = useState("");
  const [settings, setSettings] = useState<RoomSettings>(defaultSettings);
  const [openPanel, setOpenPanel] = useState<UtilityPanel>(null);
  const [closedShowdownKey, setClosedShowdownKey] = useState<string | null>(null);
  const [seenChat, setSeenChat] = useState<{ roomId: string | null; count: number }>({ roomId: null, count: 0 });

  useEffect(() => {
    socket.on("roomState", setRoom);
    socket.on("privateState", setPrivateState);
    socket.on("connect", () => setError(null));
    socket.on("disconnect", () => setError("连接已断开，正在等待重连"));
    socket.on("chatMessage", (_message: ChatMessage) => undefined);
    return () => {
      socket.off("roomState");
      socket.off("privateState");
      socket.off("connect");
      socket.off("disconnect");
      socket.off("chatMessage");
    };
  }, []);

  useEffect(() => {
    if (!room) return;
    setSeenChat((current) => {
      const count = room.chat.length;
      if (current.roomId !== room.roomId) return { roomId: room.roomId, count };
      if (openPanel === "chat" && current.count !== count) return { roomId: room.roomId, count };
      return current;
    });
  }, [room?.roomId, room?.chat.length, openPanel]);

  async function run<T>(fn: () => Promise<T>) {
    try {
      setError(null);
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createRoom() {
    if (!createNickname.trim()) return setError("请输入开房昵称");
    localStorage.setItem("zhuamaha.nickname", createNickname.trim());
    const result = await run(() =>
      emit<{ roomId: string }>("createRoom", { playerId, nickname: createNickname.trim(), settings })
    );
    if (result?.roomId) setRoomIdInput(result.roomId);
  }

  async function join(asSpectator: boolean) {
    if (!joinNickname.trim()) return setError("请输入加入昵称");
    if (!roomIdInput.trim()) return setError("请输入房间码");
    localStorage.setItem("zhuamaha.nickname", joinNickname.trim());
    await run(() =>
      emit(asSpectator ? "joinSpectator" : "joinRoom", {
        roomId: roomIdInput.trim().toUpperCase(),
        playerId,
        nickname: joinNickname.trim()
      })
    );
  }

  if (!room) {
    return (
      <main className="lobby">
        <div className="lobbyGrid">
          <section className="lobbyPanel">
            <div>
              <p className="eyebrow">Create</p>
              <h1>开房</h1>
              <p className="subtle">创建 6max 抓马哈房间，设置 ante、买入范围和思考时间。</p>
            </div>
            <label>
              昵称
              <input value={createNickname} onChange={(event) => setCreateNickname(event.target.value)} placeholder="开房昵称" />
            </label>
            <div className="settingsGrid">
              <label className="wideField">
                牌局名称
                <input value={settings.tableName} onChange={(e) => setSettings({ ...settings, tableName: e.target.value })} placeholder="例如 周末抓马哈" />
              </label>
              <label>
                Ante
                <input type="number" value={settings.ante} onChange={(e) => setSettings({ ...settings, ante: Number(e.target.value) })} />
              </label>
              <label>
                最小买入
                <input type="number" value={settings.minBuyIn} onChange={(e) => setSettings({ ...settings, minBuyIn: Number(e.target.value) })} />
              </label>
              <label>
                最大买入
                <input type="number" value={settings.maxBuyIn} onChange={(e) => setSettings({ ...settings, maxBuyIn: Number(e.target.value) })} />
              </label>
              <label>
                思考秒数
                <input type="number" value={settings.thinkingTimeSeconds} onChange={(e) => setSettings({ ...settings, thinkingTimeSeconds: Number(e.target.value) })} />
              </label>
              <label>
                游戏分钟
                <input type="number" value={settings.gameDurationMinutes} onChange={(e) => setSettings({ ...settings, gameDurationMinutes: Number(e.target.value) })} />
              </label>
              <label>
                抽水 %
                <input type="number" value={settings.rakePercent} onChange={(e) => setSettings({ ...settings, rakePercent: Number(e.target.value) })} />
              </label>
              <label>
                抽水 Cap
                <input type="number" value={settings.rakeCap} onChange={(e) => setSettings({ ...settings, rakeCap: Number(e.target.value) })} />
              </label>
            </div>
            <button className="primary" onClick={createRoom}>
              创建房间
            </button>
          </section>

          <section className="lobbyPanel joinPanel">
            <div>
              <p className="eyebrow">Join</p>
              <h1>加入房间</h1>
              <p className="subtle">输入房间码加入牌桌，或以观战身份进入。</p>
            </div>
            <label>
              昵称
              <input value={joinNickname} onChange={(event) => setJoinNickname(event.target.value)} placeholder="加入昵称" />
            </label>
            <label>
              房间码
              <input value={roomIdInput} onChange={(event) => setRoomIdInput(event.target.value.toUpperCase())} placeholder="例如 ABC12" />
            </label>
            <div className="joinRow">
              <button className="primary" onClick={() => join(false)}>加入</button>
              <button onClick={() => join(true)}>观战</button>
            </div>
          </section>
          {error && <p className="error lobbyError">{error}</p>}
        </div>
      </main>
    );
  }

  const hasUnreadChat = seenChat.roomId === room.roomId && room.chat.length > seenChat.count && openPanel !== "chat";

  return (
    <main className="appShell">
      <Header room={room} error={error} />
      <UtilityDock room={room} openPanel={openPanel} setOpenPanel={setOpenPanel} hasUnreadChat={hasUnreadChat} />
      <PokerTable room={room} privateState={privateState} run={run} />
      <ActionPanel room={room} privateState={privateState} run={run} />
      <UtilityModal panel={openPanel} setPanel={setOpenPanel}>
        {openPanel === "settings" && <HostPanel room={room} settings={settings} setSettings={setSettings} run={run} />}
        {openPanel === "score" && <Scoreboard room={room} />}
        {openPanel === "chat" && <Chat room={room} run={run} />}
        {openPanel === "replay" && <Replay room={room} />}
      </UtilityModal>
      <ShowdownModal room={room} closedKey={closedShowdownKey} setClosedKey={setClosedShowdownKey} />
      {privateState?.pendingDrawReveal && <DrawRevealModal room={room} card={privateState.pendingDrawReveal} run={run} />}
    </main>
  );
}

function Header({ room, error }: { room: PublicRoomState; error: string | null }) {
  const { secondsLeft } = useTimer(room);
  const gameRemaining = useGameRemaining(room);
  return (
    <header className="topBar">
      <div>
        <p className="eyebrow">房间 {room.roomId}</p>
        <h2>{room.settings.tableName}</h2>
        <p className="tableMeta">6max · Ante {room.settings.ante} · 买入 {room.settings.minBuyIn}-{room.settings.maxBuyIn} · 时长 {room.settings.gameDurationMinutes || "不限"}{room.settings.gameDurationMinutes ? "分钟" : ""} · 抽水 {room.settings.rakePercent}% / Cap {room.settings.rakeCap} · {streetLabel(room.street)} · Pot {room.pot}</p>
      </div>
      <div className="statusPills">
        <span>{room.viewerRole === "spectator" ? "观战" : room.viewerId === room.hostId ? "房主" : "玩家"}</span>
        <span>{room.paused ? "已暂停" : "进行中"}</span>
        {gameRemaining && <span className={gameRemaining.expired ? "danger" : ""}>{gameRemaining.label}</span>}
        {secondsLeft !== null && <span className={secondsLeft <= 5 ? "danger" : ""}>思考 {secondsLeft}s</span>}
        {error && <span className="danger">{error}</span>}
      </div>
    </header>
  );
}

function UtilityDock({
  room,
  openPanel,
  setOpenPanel,
  hasUnreadChat
}: {
  room: PublicRoomState;
  openPanel: UtilityPanel;
  setOpenPanel: (panel: UtilityPanel) => void;
  hasUnreadChat: boolean;
}) {
  const hasPendingBuyIns = room.viewerId === room.hostId && room.pendingBuyIns.length > 0;
  const buttons: Array<{ panel: Exclude<UtilityPanel, null>; label: string; icon: ReactNode }> = [
    { panel: "settings", label: "房间", icon: <Settings size={16} /> },
    { panel: "score", label: "积分", icon: <Trophy size={16} /> },
    { panel: "chat", label: "聊天", icon: <MessageSquare size={16} /> },
    { panel: "replay", label: "回放", icon: <History size={16} /> }
  ];
  return (
    <nav className="utilityDock">
      {buttons.map((button) => (
        <button
          key={button.panel}
          aria-label={button.label}
          className={`${openPanel === button.panel ? "activeTool" : ""} ${(button.panel === "settings" && hasPendingBuyIns) || (button.panel === "chat" && hasUnreadChat) ? "hasAlert" : ""}`}
          onClick={() => setOpenPanel(openPanel === button.panel ? null : button.panel)}
        >
          {button.icon}
          <span>{button.label}</span>
        </button>
      ))}
    </nav>
  );
}

function PokerTable({ room, privateState, run }: { room: PublicRoomState; privateState: PrivateState | null; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const { secondsLeft, progress } = useTimer(room);
  const seats = useMemo(() => rotateSeats(room), [room]);
  const [startBannerHand, setStartBannerHand] = useState<string | null>(null);
  useEffect(() => {
    if (!room.handId || room.street === "settled") return;
    setStartBannerHand(room.handId);
    const timer = window.setTimeout(() => setStartBannerHand(null), 1600);
    return () => window.clearTimeout(timer);
  }, [room.handId]);
  return (
    <section className={`felt ${startBannerHand ? "dealing" : ""}`}>
      {startBannerHand && <div className="startBanner">游戏开始</div>}
      <div className="board">
        <BoardRow title="Board A" cards={room.board.top} />
        <div className="pot">POT {room.pot}</div>
        <BoardRow title="Board B" cards={room.board.bottom} />
      </div>
      {room.drawReveal && <PublicDrawReveal room={room} />}
      <DrawDecisionNotice room={room} />
      {room.paused && <div className="pauseOverlay">房主已暂停游戏</div>}
      {seats.map(({ seat, position }) => (
        <SeatView
          key={seat.index}
          room={room}
          seat={seat}
          privateState={privateState}
          className={`seat seat${position}`}
          run={run}
          secondsLeft={room.currentSeat === seat.index ? secondsLeft : null}
          timerProgress={room.currentSeat === seat.index ? progress : 0}
        />
      ))}
    </section>
  );
}

function SeatView({
  room,
  seat,
  privateState,
  className,
  run,
  secondsLeft,
  timerProgress
}: {
  room: PublicRoomState;
  seat: PublicRoomState["seats"][number];
  privateState: PrivateState | null;
  className: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  secondsLeft: number | null;
  timerProgress: number;
}) {
  const isSelf = seat.playerId === room.viewerId;
  const isWinner = !!seat.playerId && !!room.showdown?.winnerIds.includes(seat.playerId);
  const hideSelfSeatCards = isSelf && (privateState?.actionRequired || privateState?.drawRequired);
  const cards = hideSelfSeatCards ? undefined : isSelf && privateState?.hand.length ? privateState.hand : seat.cards;
  const isDealer = room.dealerSeat === seat.index;
  return (
    <div className={`${className} ${isDealer ? "dealerSeat" : ""} ${room.currentSeat === seat.index ? "active" : ""} ${seat.folded ? "folded" : ""} ${isWinner ? "winnerSeat" : ""}`}>
      {seat.playerId ? (
        <>
          {isDealer && <div className="dealerButton">D</div>}
          <div className="seatTop">
            <div className="avatarBlock">
              <div
                className={`avatarRing ${room.currentSeat === seat.index ? "ticking" : ""}`}
                style={{ "--timer-progress": `${Math.round(timerProgress * 360)}deg` } as CSSProperties}
              >
                {seat.nickname?.slice(0, 1).toUpperCase()}
              </div>
              <strong>{seat.nickname}</strong>
            </div>
            <span>{seat.stack}</span>
          </div>
          {isWinner && <div className="winBadge">WIN</div>}
          {secondsLeft !== null && <div className="seatTimer">{secondsLeft}s</div>}
          {seat.currentBet > 0 && <div className="chipStack">{seat.currentBet}</div>}
          {cards?.length ? (
            <div className="miniCards">
              {cards.map((card, i) => <CardView key={i} card={card} small />)}
            </div>
          ) : (
            <div className="miniCardsHidden">行动中</div>
          )}
          <div className="seatMeta">
            <span>{seat.currentBet ? `下注 ${seat.currentBet}` : seat.lastAction ?? "等待"}</span>
            {seat.drawCount !== null && <span>换 {seat.drawCount}</span>}
          </div>
        </>
      ) : (
        <div className="emptySeat">空位</div>
      )}
    </div>
  );
}

function BoardRow({ title, cards }: { title: string; cards: Card[] }) {
  return (
    <div className="boardRow">
      <div className="cards boardCards">
        <span className="boardLabel">{title}</span>
        {Array.from({ length: 5 }, (_, index) => <CardView key={index} card={cards[index] ?? "back"} board />)}
      </div>
    </div>
  );
}

function PublicDrawReveal({ room }: { room: PublicRoomState }) {
  if (!room.drawReveal) return null;
  return (
    <div className="publicDrawReveal">
      <span>{room.drawReveal.nickname} 换一张：是否要第一张明牌？</span>
      <CardView card={room.drawReveal.card} small />
    </div>
  );
}

function DrawDecisionNotice({ room }: { room: PublicRoomState }) {
  const latest = useMemo(() => {
    for (let index = room.replay.length - 1; index >= 0; index -= 1) {
      const event = room.replay[index];
      if (event.type === "drawReveal") return event;
    }
    return null;
  }, [room.replay]);
  const [visibleId, setVisibleId] = useState<string | null>(null);
  useEffect(() => {
    if (!latest) return;
    const payload = latest.payload as { playerId?: string } | undefined;
    if (payload?.playerId === room.viewerId) return;
    if (Date.now() - latest.at > 6000) return;
    setVisibleId(latest.id);
    const timer = window.setTimeout(() => setVisibleId(null), 3600);
    return () => window.clearTimeout(timer);
  }, [latest?.id, latest?.at, latest?.payload, room.viewerId]);
  if (!latest || visibleId !== latest.id) return null;
  return <div className="drawDecisionNotice">{latest.message}</div>;
}

function CardView({ card, small = false, board = false, selected = false, onClick }: { card: Card | "back"; small?: boolean; board?: boolean; selected?: boolean; onClick?: () => void }) {
  const red = card !== "back" && (card.suit === "h" || card.suit === "d");
  return (
    <button className={`card ${card === "back" ? "backCard" : ""} ${small ? "smallCard" : ""} ${board ? "boardCard" : ""} ${red ? "red" : ""} ${selected ? "selected" : ""}`} onClick={onClick} disabled={!onClick}>
      {card === "back" ? (
        <span className="cardBack">✦</span>
      ) : (
        <>
          <span className="cardRank">{card.rank}</span>
          <span className="cardSuit">{suitSymbol(card.suit)}</span>
        </>
      )}
    </button>
  );
}

function ActionPanel({ room, privateState, run }: { room: PublicRoomState; privateState: PrivateState | null; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [amount, setAmount] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const legal = privateState?.legalActions;
  const mySeat = room.seats.find((seat) => seat.playerId === room.viewerId);

  useEffect(() => {
    setSelected([]);
    setAmount(legal?.minRaiseTo ?? 0);
  }, [room.street, room.currentSeat, legal?.minRaiseTo]);

  if (room.viewerRole === "spectator") {
    return (
      <section className="actionPanel mutedPanel">
        <Eye size={18} /> 观战模式不会显示未摊牌手牌，也不能行动。
      </section>
    );
  }

  if (!mySeat) {
    return (
      <section className="actionPanel centerAction">
        <button className="primary" onClick={() => run(() => emit("sitRandom", { roomId: room.roomId, playerId }))}>
          <Armchair size={16} /> 随机入座 / 回原座
        </button>
      </section>
    );
  }

  if (privateState?.drawRequired) {
    return (
      <section className="actionPanel">
        <h3>选择要换的牌（0-3 张）</h3>
        <div className="handCards">
          {privateState.hand.map((card, index) => (
            <CardView
              key={`${cardToString(card)}-${index}`}
              card={card}
              selected={selected.includes(index)}
              onClick={() =>
                setSelected((current) =>
                  current.includes(index) ? current.filter((item) => item !== index) : current.length < 3 ? [...current, index] : current
                )
              }
            />
          ))}
        </div>
        <BoardStrengths room={room} privateState={privateState} />
        <div className="buttonRow">
          <button onClick={() => run(() => emit("drawSelect", { roomId: room.roomId, playerId, indices: selected }))}>
            换所选 {selected.length} 张
          </button>
          <button onClick={() => run(() => emit("drawSelect", { roomId: room.roomId, playerId, indices: [] }))}>不换</button>
        </div>
      </section>
    );
  }

  if (!privateState?.actionRequired || !legal) {
    return (
      <section className="actionPanel mutedPanel">
        {privateState?.hand?.length ? (
          <>
            <div className="handCards">{privateState.hand.map((card, index) => <CardView key={index} card={card} />)}</div>
            <BoardStrengths room={room} privateState={privateState} />
          </>
        ) : (
          <>
            <span>等待游戏开始</span>
            <BuyInControl room={room} run={run} />
          </>
        )}
      </section>
    );
  }

  const sendAction = (action: ClientAction) => run(() => emit("act", { roomId: room.roomId, playerId, action }));
  return (
    <section className="actionPanel bettingPanel">
      <div className="betInfo">
        <div className="handCards">{privateState.hand.map((card, index) => <CardView key={index} card={card} />)}</div>
        <BoardStrengths room={room} privateState={privateState} />
      </div>
      <div className="betControls">
        <div className="buttonRow actionButtons">
          <button onClick={() => sendAction(legal.canCheck ? { type: "check" } : { type: "call" })}>
            {legal.canCheck ? "Check" : `Call ${legal.toCall}`}
          </button>
          <button onClick={() => sendAction({ type: "fold" })}>Fold</button>
          <button onClick={() => setAmount(Math.floor((legal.maxRaiseTo + legal.minRaiseTo) / 2))}>1/2 Pot</button>
          <button onClick={() => setAmount(legal.maxRaiseTo)}>Pot</button>
          <button onClick={() => sendAction({ type: "all-in" })}>
            {mySeat.currentBet + legal.stack <= legal.maxRaiseTo ? "All-in" : "最大 Pot"}
          </button>
        </div>
        <div className="betRow">
          <input type="range" min={legal.minRaiseTo} max={legal.maxRaiseTo} value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
          <input type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
          <button disabled={!legal.canRaise} onClick={() => sendAction(legal.toCall === 0 ? { type: "bet", amount } : { type: "raise", amount })}>
            {legal.toCall === 0 ? "Bet" : "Raise"}
          </button>
        </div>
      </div>
    </section>
  );
}

function BoardStrengths({ room, privateState }: { room: PublicRoomState; privateState: PrivateState }) {
  const strengths = useMemo(() => {
    const hand = privateState.hand;
    const top = evaluateOmahaCurrent(hand, room.board.top);
    const bottom = evaluateOmahaCurrent(hand, room.board.bottom);
    const handBoard = evaluateHandBoard(hand);
    return [
      ["Board A", handTypeOnly(top?.description ?? "等待 flop")],
      ["Board B", handTypeOnly(bottom?.description ?? "等待 flop")],
      ["手牌 Board", handTypeOnly(handBoard.description)]
    ];
  }, [privateState.hand, room.board.top, room.board.bottom]);
  return (
    <div className="strengthGrid">
      {strengths.map(([label, value]) => (
        <div className="strengthItem" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function handTypeOnly(description: string): string {
  return description.replace(/\s*[（(].*$/, "");
}

function HostPanel({
  room,
  settings,
  setSettings,
  run
}: {
  room: PublicRoomState;
  settings: RoomSettings;
  setSettings: (settings: RoomSettings) => void;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}) {
  const isHost = room.viewerId === room.hostId;
  useEffect(() => setSettings(room.settings), [room.settings, setSettings]);
  return (
    <section className="panel">
      <h3>
        <Settings size={16} /> 房间设置
      </h3>
      <div className="buttonRow">
        <button disabled={!isHost} onClick={() => run(() => emit("hostStartHand", { roomId: room.roomId, playerId }))}>
          <Play size={14} /> 开始
        </button>
        <button
          disabled={!isHost || room.street === "idle" || room.street === "settled"}
          onClick={() => run(() => emit(room.paused ? "hostResumeGame" : "hostPauseGame", { roomId: room.roomId, playerId }))}
        >
          <Pause size={14} /> {room.paused ? "继续" : "暂停"}
        </button>
      </div>
      <div className="settingsGrid compact">
        <label className="wideField">
          牌局名称
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} value={settings.tableName} onChange={(e) => setSettings({ ...settings, tableName: e.target.value })} />
        </label>
        <label>
          Ante
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.ante} onChange={(e) => setSettings({ ...settings, ante: Number(e.target.value) })} />
        </label>
        <label>
          买入下限
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.minBuyIn} onChange={(e) => setSettings({ ...settings, minBuyIn: Number(e.target.value) })} />
        </label>
        <label>
          买入上限
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.maxBuyIn} onChange={(e) => setSettings({ ...settings, maxBuyIn: Number(e.target.value) })} />
        </label>
        <label>
          秒数
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.thinkingTimeSeconds} onChange={(e) => setSettings({ ...settings, thinkingTimeSeconds: Number(e.target.value) })} />
        </label>
        <label>
          游戏分钟
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.gameDurationMinutes} onChange={(e) => setSettings({ ...settings, gameDurationMinutes: Number(e.target.value) })} />
        </label>
        <label>
          抽水 %
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.rakePercent} onChange={(e) => setSettings({ ...settings, rakePercent: Number(e.target.value) })} />
        </label>
        <label>
          抽水 Cap
          <input disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} type="number" value={settings.rakeCap} onChange={(e) => setSettings({ ...settings, rakeCap: Number(e.target.value) })} />
        </label>
      </div>
      <button disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} onClick={() => run(() => emit("updateSettings", { roomId: room.roomId, playerId, settings }))}>
        保存设置
      </button>
      <BuyInRequests room={room} run={run} />
      <BuyInControl room={room} run={run} />
      <TableControls room={room} run={run} />
    </section>
  );
}

function BuyInRequests({ room, run }: { room: PublicRoomState; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const isHost = room.viewerId === room.hostId;
  if (!isHost || room.pendingBuyIns.length === 0) return null;
  return (
    <div className="buyInRequests">
      <span className="controlLabel">带入审核</span>
      {room.pendingBuyIns.map((request) => (
        <div className="buyInRequest" key={request.id}>
          <div>
            <strong>{request.nickname}</strong>
            <small>申请带入 {request.amount}</small>
          </div>
          <div className="buttonRow">
            <button className="primary" onClick={() => run(() => emit("approveBuyIn", { roomId: room.roomId, playerId, requestId: request.id }))}>
              通过
            </button>
            <button onClick={() => run(() => emit("rejectBuyIn", { roomId: room.roomId, playerId, requestId: request.id }))}>
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TableControls({ room, run }: { room: PublicRoomState; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [target, setTarget] = useState("");
  const isHost = room.viewerId === room.hostId;
  const mySeat = room.seats.find((seat) => seat.playerId === room.viewerId);
  const candidates = room.seats.filter((seat) => seat.playerId && seat.playerId !== room.viewerId);
  useEffect(() => {
    if (!target && candidates[0]?.playerId) setTarget(candidates[0].playerId);
  }, [target, candidates]);
  return (
    <div className="tableControls">
      <span className="controlLabel">座位操作</span>
      {!mySeat && (
        <button onClick={() => run(() => emit("sitRandom", { roomId: room.roomId, playerId }))}>
          <Armchair size={14} /> 随机入座 / 回原座
        </button>
      )}
      {isHost && candidates.length > 0 && (
        <div className="transferRow">
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            {candidates.map((seat) => (
              <option value={seat.playerId ?? ""} key={seat.playerId ?? seat.index}>
                转交给 {seat.nickname}
              </option>
            ))}
          </select>
          <button onClick={() => run(() => emit("transferHost", { roomId: room.roomId, playerId, targetPlayerId: target }))}>
            转交房主
          </button>
        </div>
      )}
      {mySeat && (
        <button className="dangerButton" onClick={() => run(() => emit("stand", { roomId: room.roomId, playerId }))}>
          离桌
        </button>
      )}
    </div>
  );
}

function BuyInControl({ room, run }: { room: PublicRoomState; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [amount, setAmount] = useState(room.settings.minBuyIn);
  const mySeat = room.seats.find((seat) => seat.playerId === room.viewerId);
  const pending = room.pendingBuyIns.find((request) => request.playerId === room.viewerId);
  if (!mySeat || room.viewerRole === "spectator") return null;
  return (
    <div className="buyIn">
      <span className="controlLabel">积分操作</span>
      <input type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
      <button disabled={!!pending} onClick={() => run(() => emit("buyIn", { roomId: room.roomId, playerId, amount }))}>
        {pending ? `待房主确认 ${pending.amount}` : room.street !== "idle" && room.street !== "settled" ? "申请下局积分" : room.viewerId === room.hostId ? "带入/加分" : "申请带入"}
      </button>
    </div>
  );
}

function Scoreboard({ room }: { room: PublicRoomState }) {
  const sorted = [...room.seats].filter((seat) => seat.playerId).sort((a, b) => b.stack - a.stack);
  return (
    <section className="panel">
      <div className="panelTitleRow">
        <h3><Trophy size={16} /> 积分排行</h3>
        {room.viewerId === room.hostId && (
          <button onClick={() => exportScoreboard(room, sorted)}>
            导出 Excel
          </button>
        )}
      </div>
      <p className="scoreSummary">累计抽水 {room.rakeTotal}</p>
      {sorted.map((seat) => (
        <div className="scoreRow" key={seat.index}>
          <span>{seat.nickname}</span>
          <strong>{seat.stack}</strong>
          <small>带入 {seat.buyIn} / 输赢 {seat.stack - seat.buyIn >= 0 ? "+" : ""}{seat.stack - seat.buyIn} / 抽水 {seat.rakePaid}{seat.pendingBuyIn ? ` / 下局 +${seat.pendingBuyIn}` : ""}</small>
        </div>
      ))}
    </section>
  );
}

function exportScoreboard(room: PublicRoomState, seats: PublicRoomState["seats"]): void {
  const rows = seats.map((seat, index) => ({
    rank: index + 1,
    nickname: seat.nickname ?? "",
    stack: seat.stack,
    buyIn: seat.buyIn,
    net: seat.stack - seat.buyIn,
    rakePaid: seat.rakePaid,
    pendingBuyIn: seat.pendingBuyIn
  }));
  const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body>
    <h2>${escapeHtml(room.settings.tableName)} 积分排行</h2>
    <p>房间 ${escapeHtml(room.roomId)} / 累计抽水 ${room.rakeTotal} / 导出时间 ${new Date().toLocaleString()}</p>
    <table border="1">
      <thead><tr><th>排名</th><th>玩家</th><th>当前积分</th><th>带入积分</th><th>输赢</th><th>累计抽水</th><th>下局待生效</th></tr></thead>
      <tbody>
        ${rows.map((row) => `<tr><td>${row.rank}</td><td>${escapeHtml(row.nickname)}</td><td>${row.stack}</td><td>${row.buyIn}</td><td>${row.net}</td><td>${row.rakePaid}</td><td>${row.pendingBuyIn}</td></tr>`).join("")}
      </tbody>
    </table>
  </body></html>`;
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${room.settings.tableName || room.roomId}-积分排行.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char] ?? char);
}

function Chat({ room, run }: { room: PublicRoomState; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [text, setText] = useState("");
  return (
    <section className="panel chatPanel">
      <h3><MessageSquare size={16} /> 聊天</h3>
      <div className="messages">
        {room.chat.map((message) => (
          <p key={message.id}>
            <strong>{message.nickname}</strong>：{message.text}
          </p>
        ))}
      </div>
      <form
        className="chatInput"
        onSubmit={(event) => {
          event.preventDefault();
          const sending = text;
          setText("");
          run(() => emit("sendChat", { roomId: room.roomId, playerId, text: sending }));
        }}
      >
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="发送消息" />
        <button>
          <Send size={14} />
        </button>
      </form>
    </section>
  );
}

function Replay({ room }: { room: PublicRoomState }) {
  const [index, setIndex] = useState(0);
  const visible = room.replay.slice(0, index + 1);
  useEffect(() => setIndex(Math.max(0, room.replay.length - 1)), [room.replay.length]);
  return (
    <section className="panel replayPanel">
      <h3><History size={16} /> 手牌回放</h3>
      <div className="buttonRow">
        <button onClick={() => setIndex(Math.max(0, index - 1))}>上一步</button>
        <button onClick={() => setIndex(Math.min(room.replay.length - 1, index + 1))}>下一步</button>
      </div>
      <div className="messages">
        {visible.map((event) => (
          <div className="replayEvent" key={event.id}>
            <p>{event.message}</p>
            <ReplayPayload event={event} room={room} />
          </div>
        ))}
      </div>
      {room.showdown && (
        <div className="showdown">
          <strong>{room.showdown.noShowdown ? "下注获胜，无需秀牌" : "秀牌顺序"}</strong>
          {!room.showdown.noShowdown && <p>{room.showdown.showOrder.map((id) => playerName(room, id)).join(" → ")}</p>}
          <ShowdownDetails room={room} />
        </div>
      )}
    </section>
  );
}

function ReplayPayload({ event, room }: { event: PublicRoomState["replay"][number]; room: PublicRoomState }) {
  const payload = event.payload as { board?: { top?: Card[]; bottom?: Card[] }; pot?: number; rakeTotal?: number; playerResults?: PlayerSettlement[]; potAwards?: Array<{ amount: number; rake: number; winners: string[] }> } | undefined;
  if (!payload) return null;
  if (event.type === "settled" && payload.playerResults) {
    return (
      <div className="settlementReplay">
        <small>抽水 {payload.rakeTotal ?? 0} / Pot {payload.pot ?? room.pot}</small>
        <SettlementTable results={payload.playerResults} />
        {payload.potAwards?.map((award, index) => (
          <small key={index}>底池 {index + 1}: {award.amount} → {award.winners.map((id) => playerName(room, id)).join("、")} {award.rake ? `(抽水 ${award.rake})` : ""}</small>
        ))}
      </div>
    );
  }
  if (payload.board) {
    return (
      <small>
        A: {payload.board.top?.map(cardToString).join(" ") || "-"} / B: {payload.board.bottom?.map(cardToString).join(" ") || "-"}
        {typeof payload.pot === "number" ? ` / Pot ${payload.pot}` : ""}
      </small>
    );
  }
  return null;
}

function SettlementTable({ results }: { results: PlayerSettlement[] }) {
  return (
    <div className="settlementTable">
      <span>玩家</span>
      <span>得分</span>
      <span>投入</span>
      <span>分回</span>
      <span>抽水</span>
      <span>净输赢</span>
      {results.map((result) => (
        <Fragment key={result.playerId}>
          <strong>{result.nickname}{result.folded ? " 弃牌" : ""}</strong>
          <span>{result.points}</span>
          <span>{result.contribution}</span>
          <span>{result.awarded}</span>
          <span>{result.rakePaid}</span>
          <strong className={result.net >= 0 ? "positive" : "negative"}>{result.net >= 0 ? "+" : ""}{result.net}</strong>
        </Fragment>
      ))}
    </div>
  );
}

function ShowdownModal({ room, closedKey, setClosedKey }: { room: PublicRoomState; closedKey: string | null; setClosedKey: (key: string) => void }) {
  if (!room.showdown) return null;
  const key = showdownKey(room);
  if (closedKey === key) return null;
  return (
    <div className="showdownBackdrop">
      <section className="showdownModal">
        <button className="iconButton closeButton" onClick={() => setClosedKey(key)} aria-label="关闭">
          <X size={16} />
        </button>
        <div>
          <p className="eyebrow">Showdown</p>
          <h3>最终比分</h3>
          <div className="scoreChips">
            {Object.entries(room.showdown.points).map(([id, points]) => (
              <span key={id}>{playerName(room, id)} {points}</span>
            ))}
          </div>
        </div>
        <ShowdownDetails room={room} />
      </section>
    </div>
  );
}

function ShowdownDetails({ room }: { room: PublicRoomState }) {
  if (!room.showdown) return null;
  return (
    <div className="showdownFull">
      <strong>摊牌手牌</strong>
      {room.showdown.noShowdown ? <p>其他玩家已弃牌，获胜者无需亮牌。</p> : <div className="showdownHands">
        {room.seats.filter((seat) => seat.playerId && seat.cards?.length && seat.cards.some((card) => card !== "back")).map((seat) => (
          <div className="showdownHand" key={seat.playerId ?? seat.index}>
            <div className="showdownHandTop">
              <span>{seat.nickname}</span>
              {seat.playerId && room.showdown?.winnerIds.includes(seat.playerId) && <strong>WIN</strong>}
            </div>
            <div className="miniShowCards">
              {seat.cards?.map((card, index) => <CardView key={index} card={card} small />)}
            </div>
          </div>
        ))}
      </div>}
      <strong>获胜方牌型</strong>
      {room.showdown.boards.map((board) => (
        <div className="boardResult" key={board.board}>
          <p>{boardName(board.board)}：{board.winners.map((id) => playerName(room, id)).join("、")}</p>
          {board.winners.map((id) => (
            <small key={id}>{playerName(room, id)} - {board.descriptions[id]}</small>
          ))}
        </div>
      ))}
      <strong>底池分配</strong>
      {room.showdown.potAwards.map((award, i) => (
        <p key={i}>{award.amount} → {award.winners.map((id) => playerName(room, id)).join("、")} {award.rake ? `(抽水 ${award.rake})` : ""}</p>
      ))}
      <strong>本局输赢</strong>
      <SettlementTable results={room.showdown.playerResults} />
    </div>
  );
}

function showdownKey(room: PublicRoomState): string {
  if (!room.showdown) return "";
  return `${room.roomId}:${room.showdown.potAwards.map((award) => `${award.amount}-${award.winners.join(".")}`).join("|")}:${Object.entries(room.showdown.points).map(([id, points]) => `${id}-${points}`).join("|")}`;
}

function UtilityModal({ panel, setPanel, children }: { panel: UtilityPanel; setPanel: (panel: UtilityPanel) => void; children: ReactNode }) {
  if (!panel) return null;
  return (
    <div className="utilityBackdrop" onClick={() => setPanel(null)}>
      <div className="utilityModal" onClick={(event) => event.stopPropagation()}>
        <button className="iconButton closeButton" onClick={() => setPanel(null)} aria-label="关闭">
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}

function useTimer(room: PublicRoomState): { secondsLeft: number | null; progress: number } {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  if (!room.timerEndsAt || room.paused) return { secondsLeft: null, progress: 0 };
  const total = room.settings.thinkingTimeSeconds * 1000;
  const remaining = Math.max(0, room.timerEndsAt - now);
  return {
    secondsLeft: Math.ceil(remaining / 1000),
    progress: total > 0 ? remaining / total : 0
  };
}

function useGameRemaining(room: PublicRoomState): { label: string; expired: boolean } | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!room.gameEndsAt) return null;
  const remaining = room.gameEndsAt - now;
  if (remaining <= 0) return { label: "时长已到", expired: true };
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.ceil((remaining % 60_000) / 1000);
  return { label: `剩余 ${minutes}:${seconds.toString().padStart(2, "0")}`, expired: false };
}

function rotateSeats(room: PublicRoomState): Array<{ seat: PublicRoomState["seats"][number]; position: number }> {
  const self = room.seats.find((seat) => seat.playerId === room.viewerId);
  const anchor = self?.index ?? 0;
  return Array.from({ length: room.seats.length }, (_, position) => ({
    seat: room.seats[(anchor + position) % room.seats.length],
    position
  }));
}

function playerName(room: PublicRoomState, id: string): string {
  return room.seats.find((seat) => seat.playerId === id)?.nickname ?? id;
}

function boardName(board: "top" | "bottom" | "hand"): string {
  return board === "top" ? "Board A" : board === "bottom" ? "Board B" : "手牌 Board";
}

function DrawRevealModal({ room, card, run }: { room: PublicRoomState; card: Card; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);

  function startDrag(event: PointerEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y });
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y
    });
  }

  function stopDrag(event: PointerEvent<HTMLDivElement>): void {
    if (drag?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  }

  return (
    <div className="modalBackdrop drawRevealBackdrop">
      <div
        className="modal drawRevealModal"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      >
        <h2>换一张明牌</h2>
        <p>你可以接受这张牌，或拒绝后再拿一张暗牌。</p>
        <CardView card={card} />
        <div className="buttonRow">
          <button className="primary" onClick={() => run(() => emit("drawRevealDecision", { roomId: room.roomId, playerId, accept: true }))}>
            接受
          </button>
          <button onClick={() => run(() => emit("drawRevealDecision", { roomId: room.roomId, playerId, accept: false }))}>
            拒绝拿暗牌
          </button>
        </div>
      </div>
    </div>
  );
}

function streetLabel(street: string): string {
  const labels: Record<string, string> = {
    idle: "等待开局",
    flopBet: "Flop 下注",
    flopDraw: "Flop 换牌",
    turnBet: "Turn 下注",
    turnDraw: "Turn 换牌",
    riverBet: "River 下注",
    settled: "已结算"
  };
  return labels[street] ?? street;
}
