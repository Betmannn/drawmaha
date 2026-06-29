import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { Fragment } from "react";
import { io, Socket } from "socket.io-client";
import { Armchair, Eye, History, MessageSquare, Pause, Play, Send, Settings, Trophy, X } from "lucide-react";
import type { Card, ChatMessage, ClientAction, PlayerSettlement, PrivateState, PublicRoomState, RoomSettings, ShowdownBoardResult } from "../shared/types";
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
  drawTimeSeconds: 30,
  settlementSeconds: 5,
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

type SavedRoomSession = {
  roomId: string;
  nickname: string;
  asSpectator: boolean;
};

function saveRoomSession(session: SavedRoomSession): void {
  localStorage.setItem("zhuamaha.session", JSON.stringify(session));
}

function loadRoomSession(): SavedRoomSession | null {
  const raw = localStorage.getItem("zhuamaha.session");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedRoomSession>;
    if (!parsed.roomId || !parsed.nickname) return null;
    return {
      roomId: parsed.roomId,
      nickname: parsed.nickname,
      asSpectator: !!parsed.asSpectator
    };
  } catch {
    return null;
  }
}

function clearRoomSession(): void {
  localStorage.removeItem("zhuamaha.session");
}

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
  const [settlementSnapshot, setSettlementSnapshot] = useState<{ room: PublicRoomState; expiresAt: number } | null>(null);
  const [seenChat, setSeenChat] = useState<{ roomId: string | null; count: number }>({ roomId: null, count: 0 });
  const [restoreAttempted, setRestoreAttempted] = useState(false);

  useEffect(() => {
    socket.on("roomState", setRoom);
    socket.on("privateState", setPrivateState);
    socket.on("connect", () => setError(null));
    socket.on("disconnect", () => setError("连接已断开，正在等待重连"));
    socket.on("chatMessage", (_message: ChatMessage) => undefined);
    socket.on("roomLeft", () => {
      clearRoomSession();
      setRoom(null);
      setPrivateState(null);
      setOpenPanel(null);
      setClosedShowdownKey(null);
      setSettlementSnapshot(null);
    });
    return () => {
      socket.off("roomState");
      socket.off("privateState");
      socket.off("connect");
      socket.off("disconnect");
      socket.off("chatMessage");
      socket.off("roomLeft");
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

  const activeShowdownKey = room?.showdown ? showdownKey(room) : "";
  useEffect(() => {
    if (!room?.showdown) return;
    const key = showdownKey(room);
    setSettlementSnapshot({ room, expiresAt: Date.now() + 30_000 });
    const timer = window.setTimeout(() => {
      setSettlementSnapshot((current) => current && showdownKey(current.room) === key ? null : current);
      setClosedShowdownKey((current) => current === key ? current : key);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [activeShowdownKey]);

  async function run<T>(fn: () => Promise<T>) {
    try {
      setError(null);
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (room || restoreAttempted) return;
    const saved = loadRoomSession();
    if (!saved) {
      setRestoreAttempted(true);
      return;
    }
    let cancelled = false;
    const restore = async () => {
      try {
        setError(null);
        setRoomIdInput(saved.roomId);
        if (saved.asSpectator) setJoinNickname(saved.nickname);
        else setJoinNickname(saved.nickname);
        await emit(saved.asSpectator ? "joinSpectator" : "joinRoom", {
          roomId: saved.roomId,
          playerId,
          nickname: saved.nickname
        });
      } catch (err) {
        clearRoomSession();
        if (!cancelled) setError(err instanceof Error ? `恢复房间失败：${err.message}` : "恢复房间失败");
      } finally {
        if (!cancelled) setRestoreAttempted(true);
      }
    };
    if (socket.connected) void restore();
    else socket.once("connect", restore);
    return () => {
      cancelled = true;
      socket.off("connect", restore);
    };
  }, [room, restoreAttempted]);

  async function createRoom() {
    if (!createNickname.trim()) return setError("请输入开房昵称");
    localStorage.setItem("zhuamaha.nickname", createNickname.trim());
    const result = await run(() =>
      emit<{ roomId: string }>("createRoom", { playerId, nickname: createNickname.trim(), settings })
    );
    if (result?.roomId) {
      setRoomIdInput(result.roomId);
      saveRoomSession({ roomId: result.roomId, nickname: createNickname.trim(), asSpectator: false });
    }
  }

  async function join(asSpectator: boolean) {
    if (!joinNickname.trim()) return setError("请输入加入昵称");
    if (!roomIdInput.trim()) return setError("请输入房间码");
    localStorage.setItem("zhuamaha.nickname", joinNickname.trim());
    const result = await run(() =>
      emit(asSpectator ? "joinSpectator" : "joinRoom", {
        roomId: roomIdInput.trim().toUpperCase(),
        playerId,
        nickname: joinNickname.trim()
      })
    );
    if (result !== undefined) {
      saveRoomSession({ roomId: roomIdInput.trim().toUpperCase(), nickname: joinNickname.trim(), asSpectator });
    }
  }

  async function leaveCurrentRoom() {
    if (!room) return;
    const leftRoomId = room.roomId;
    const failed = await run(() => emit("leaveRoom", { roomId: leftRoomId }).then(() => false));
    if (failed === false) {
      clearRoomSession();
      setRoom(null);
      setPrivateState(null);
      setOpenPanel(null);
      setClosedShowdownKey(null);
      setRoomIdInput(leftRoomId);
    }
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
                下注秒数
                <input type="number" value={settings.thinkingTimeSeconds} onChange={(e) => setSettings({ ...settings, thinkingTimeSeconds: Number(e.target.value) })} />
              </label>
              <label>
                换牌秒数
                <input type="number" value={settings.drawTimeSeconds} onChange={(e) => setSettings({ ...settings, drawTimeSeconds: Number(e.target.value) })} />
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
              <input value={roomIdInput} onChange={(event) => setRoomIdInput(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="例如 123456" />
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
  const showdownRoom = room.showdown ? room : settlementSnapshot?.room ?? null;

  return (
    <main className="appShell">
      <Header room={room} error={error} />
      <UtilityDock room={room} openPanel={openPanel} setOpenPanel={setOpenPanel} hasUnreadChat={hasUnreadChat} onLeave={leaveCurrentRoom} />
      <PokerTable room={room} privateState={privateState} run={run} />
      <ActionPanel room={room} privateState={privateState} run={run} />
      <UtilityModal panel={openPanel} setPanel={setOpenPanel}>
        {openPanel === "settings" && <HostPanel room={room} settings={settings} setSettings={setSettings} run={run} />}
        {openPanel === "score" && <Scoreboard room={room} />}
        {openPanel === "chat" && <Chat room={room} run={run} />}
        {openPanel === "replay" && <Replay room={room} />}
      </UtilityModal>
      {showdownRoom && (
        <ShowdownModal
          room={showdownRoom}
          closedKey={closedShowdownKey}
          onClose={(key) => {
            setClosedShowdownKey(key);
            setSettlementSnapshot((current) => current && showdownKey(current.room) === key ? null : current);
          }}
        />
      )}
      {privateState?.pendingDrawReveal && <DrawRevealModal room={room} card={privateState.pendingDrawReveal} run={run} />}
    </main>
  );
}

function Header({ room, error }: { room: PublicRoomState; error: string | null }) {
  const { secondsLeft } = useTimer(room);
  const gameRemaining = useGameRemaining(room);
  const durationLabel = `${room.settings.gameDurationMinutes || "不限"}${room.settings.gameDurationMinutes ? "分钟" : ""}`;
  return (
    <header className="topBar">
      <div className="tableIdentity">
        <p className="eyebrow">房间 {room.roomId}</p>
        <h2>
          <span>{room.settings.tableName}</span>
          <small>
            Ante {room.settings.ante} · 时长 {durationLabel}
            {gameRemaining ? ` · ${gameRemaining.label}` : ""}
          </small>
        </h2>
      </div>
      <div className="statusPills">
        <span>{room.viewerRole === "spectator" ? "观战" : room.viewerId === room.hostId ? "房主" : "玩家"}</span>
        <span>{room.paused ? "已暂停" : "进行中"}</span>
        {error && <span className="danger">{error}</span>}
      </div>
    </header>
  );
}

function UtilityDock({
  room,
  openPanel,
  setOpenPanel,
  hasUnreadChat,
  onLeave
}: {
  room: PublicRoomState;
  openPanel: UtilityPanel;
  setOpenPanel: (panel: UtilityPanel) => void;
  hasUnreadChat: boolean;
  onLeave: () => Promise<void>;
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
      <button className="leaveRoomButton" aria-label="退出房间" onClick={onLeave}>
        <X size={16} />
        <span>退出</span>
      </button>
    </nav>
  );
}

function PokerTable({ room, privateState, run }: { room: PublicRoomState; privateState: PrivateState | null; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const { secondsLeft, progress } = useTimer(room);
  const seats = useMemo(() => rotateSeats(room), [room]);
  const [startBannerHand, setStartBannerHand] = useState<string | null>(null);
  const [seatChats, setSeatChats] = useState<Record<string, { id: string; text: string }>>({});
  useEffect(() => {
    if (!room.handId || room.street === "settled") return;
    setStartBannerHand(room.handId);
    const timer = window.setTimeout(() => setStartBannerHand(null), 1600);
    return () => window.clearTimeout(timer);
  }, [room.handId]);
  useEffect(() => {
    const latest = room.chat.at(-1);
    if (!latest?.playerId || Date.now() - latest.at > 2000) return;
    setSeatChats((current) => ({ ...current, [latest.playerId]: { id: latest.id, text: latest.text } }));
    const timer = window.setTimeout(() => {
      setSeatChats((current) => {
        if (current[latest.playerId]?.id !== latest.id) return current;
        const next = { ...current };
        delete next[latest.playerId];
        return next;
      });
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [room.chat.length, room.roomId]);
  const showBoard = room.street !== "idle";
  return (
    <section className={`felt ${startBannerHand ? "dealing" : ""}`}>
      {startBannerHand && <div className="startBanner">游戏开始</div>}
      {showBoard && (
        <div className="board">
          <BoardRow title="Board A" cards={room.board.top} />
          <div className="pot">POT {room.pot}</div>
          <BoardRow title="Board B" cards={room.board.bottom} />
        </div>
      )}
      {!showBoard && (
        <div className="tableBrand">
          <strong>Online Drawmaha</strong>
          <span>Double Boards</span>
        </div>
      )}
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
          chatText={seat.playerId ? seatChats[seat.playerId]?.text ?? null : null}
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
  timerProgress,
  chatText
}: {
  room: PublicRoomState;
  seat: PublicRoomState["seats"][number];
  privateState: PrivateState | null;
  className: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  secondsLeft: number | null;
  timerProgress: number;
  chatText: string | null;
}) {
  const isSelf = seat.playerId === room.viewerId;
  const isWinner = !!seat.playerId && !!room.showdown?.winnerIds.includes(seat.playerId);
  const cards = isSelf && privateState?.hand.length ? privateState.hand : seat.cards;
  const isDealer = room.dealerSeat === seat.index;
  const actionStatus = seat.currentBet ? undefined : seat.lastAction;
  const chipScale = seat.currentBet > 0 ? Math.min(1.65, 1 + Math.log10(Math.max(1, seat.currentBet)) * 0.18) : 1;
  const timerStyle = {
    "--timer-progress": `${Math.round(timerProgress * 360)}deg`,
    "--timer-percent": `${Math.round(timerProgress * 100)}%`
  } as CSSProperties;
  return (
    <div className={`${className} ${!seat.playerId ? "emptySeatWrap" : ""} ${isDealer ? "dealerSeat" : ""} ${room.currentSeat === seat.index ? "active" : ""} ${seat.folded ? "folded" : ""} ${isWinner ? "winnerSeat" : ""}`} style={timerStyle}>
      {seat.playerId ? (
        <>
          {isDealer && <div className="dealerButton">D</div>}
          {chatText && <div className="seatChatBubble">{chatText}</div>}
          <div className="seatTop">
            <div className="avatarBlock">
              <strong>{seat.nickname}</strong>
            </div>
            <span className="seatStack">{seat.stack}</span>
          </div>
          {isWinner && <div className="winBadge">WIN</div>}
          {secondsLeft !== null && <div className="seatTimer">{secondsLeft}s</div>}
          {seat.currentBet > 0 && (
            <div className="chipStack" style={{ "--chip-scale": chipScale } as CSSProperties} aria-label={`下注 ${seat.currentBet}`}>
              {seat.currentBet}
            </div>
          )}
          {cards?.length ? (
            <div className="miniCards">
              {cards.map((card, i) => <CardView key={i} card={card} small />)}
            </div>
          ) : (
            <div className="miniCardsHidden">行动中</div>
          )}
          <div className="seatMeta">
            {actionStatus && <span className="seatActionText">{actionStatus}</span>}
            {seat.drawCount !== null && <span className="seatDrawText">换 {seat.drawCount}</span>}
          </div>
        </>
      ) : (
        <div className="emptySeat">
          <span>{seat.index + 1}</span>
          <strong>空位</strong>
        </div>
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
    const payload = latest.payload as { playerId?: string; accept?: boolean } | undefined;
    if (payload?.playerId === room.viewerId) return;
    if (Date.now() - latest.at > 6000) return;
    setVisibleId(latest.id);
    const timer = window.setTimeout(() => setVisibleId(null), payload?.accept === false ? 2000 : 3600);
    return () => window.clearTimeout(timer);
  }, [latest?.id, latest?.at, latest?.payload, room.viewerId]);
  if (!latest || visibleId !== latest.id) return null;
  return <div className="drawDecisionNotice">{latest.message}</div>;
}

function CardView({ card, small = false, board = false, selected = false, onClick }: { card: Card | "back"; small?: boolean; board?: boolean; selected?: boolean; onClick?: () => void }) {
  const suitClass = card === "back" ? "" : `suit-${card.suit}`;
  return (
    <button className={`card ${card === "back" ? "backCard" : ""} ${suitClass} ${small ? "smallCard" : ""} ${board ? "boardCard" : ""} ${selected ? "selected" : ""}`} onClick={onClick} disabled={!onClick}>
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
  const [confirmCheckFold, setConfirmCheckFold] = useState(false);
  const legal = privateState?.legalActions;
  const mySeat = room.seats.find((seat) => seat.playerId === room.viewerId);

  useEffect(() => {
    setSelected([]);
    setAmount(legal?.minRaiseTo ?? 0);
    setConfirmCheckFold(false);
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
      <section className="actionPanel drawPanel">
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
        <div className="buttonRow drawActions">
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
  const requestFold = () => {
    if (legal.canCheck) {
      setConfirmCheckFold(true);
      return;
    }
    void sendAction({ type: "fold" });
  };
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
          <button onClick={requestFold}>Fold</button>
          <button onClick={() => setAmount(Math.floor((legal.maxRaiseTo + legal.minRaiseTo) / 2))}>1/2 Pot</button>
          <button onClick={() => setAmount(legal.maxRaiseTo)}>Pot</button>
        </div>
        <div className="betRow">
          <input type="range" min={legal.minRaiseTo} max={legal.maxRaiseTo} value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
          <input type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
          <button className="betSubmit" disabled={!legal.canRaise} onClick={() => sendAction(legal.toCall === 0 ? { type: "bet", amount } : { type: "raise", amount })}>
            {legal.toCall === 0 ? "Bet" : "Raise"}
          </button>
        </div>
      </div>
      {confirmCheckFold && (
        <div className="inlineConfirmBackdrop">
          <div className="inlineConfirm">
            <strong>当前可以 Check</strong>
            <p>是否仍要弃牌？</p>
            <div className="buttonRow">
              <button
                className="dangerButton"
                onClick={() => {
                  setConfirmCheckFold(false);
                  void sendAction({ type: "fold" });
                }}
              >
                是，弃牌
              </button>
              <button className="primary" onClick={() => setConfirmCheckFold(false)}>
                否，继续
              </button>
            </div>
          </div>
        </div>
      )}
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
          下注秒数
          <input disabled={!isHost} type="number" value={settings.thinkingTimeSeconds} onChange={(e) => setSettings({ ...settings, thinkingTimeSeconds: Number(e.target.value) })} />
        </label>
        <label>
          换牌秒数
          <input disabled={!isHost} type="number" value={settings.drawTimeSeconds} onChange={(e) => setSettings({ ...settings, drawTimeSeconds: Number(e.target.value) })} />
        </label>
        <label>
          结算时长
          <select disabled={!isHost} value={settings.settlementSeconds} onChange={(e) => setSettings({ ...settings, settlementSeconds: Number(e.target.value) })}>
            <option value={3}>3s</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
          </select>
        </label>
        <label>
          玩家人数
          <select disabled={!isHost || (room.street !== "idle" && room.street !== "settled")} value={settings.maxPlayers} onChange={(e) => setSettings({ ...settings, maxPlayers: Number(e.target.value) })}>
            {[2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}人</option>)}
          </select>
        </label>
        <label>
          游戏分钟
          <input disabled={!isHost} type="number" value={settings.gameDurationMinutes} onChange={(e) => setSettings({ ...settings, gameDurationMinutes: Number(e.target.value) })} />
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
      <button disabled={!isHost} onClick={() => run(() => emit("updateSettings", { roomId: room.roomId, playerId, settings }))}>
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
  const canHostStand = room.street === "idle" || room.street === "settled";
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
          <button disabled={!canHostStand} className="dangerButton" onClick={() => run(() => emit("hostStand", { roomId: room.roomId, playerId, targetPlayerId: target }))}>
            让其起立
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
  const sorted = [...room.scores].sort((a, b) => Number(b.seated) - Number(a.seated) || b.stack - a.stack);
  const isHost = room.viewerId === room.hostId;
  return (
    <section className="panel">
      <div className="panelTitleRow">
        <h3><Trophy size={16} /> 积分排行</h3>
        {isHost && (
          <button onClick={() => exportScoreboard(room, sorted)}>
            导出 Excel
          </button>
        )}
      </div>
      {isHost && <p className="scoreSummary">累计抽水 {room.rakeTotal}</p>}
      {sorted.map((record) => (
        <div className={`scoreRow ${record.seated ? "seatedScore" : ""}`} key={record.playerId}>
          <span>{record.nickname}</span>
          <strong>{record.stack}</strong>
          <small>
            {record.seated ? `在座 ${record.seatIndex !== null ? record.seatIndex + 1 : ""} / ` : "离座 / "}
            带入 {record.buyIn} / 输赢 {record.stack - record.buyIn >= 0 ? "+" : ""}{record.stack - record.buyIn}
            {isHost ? ` / 抽水 ${record.rakePaid}` : ""}
            {record.pendingBuyIn ? ` / 下局 +${record.pendingBuyIn}` : ""}
          </small>
        </div>
      ))}
    </section>
  );
}

function exportScoreboard(room: PublicRoomState, records: PublicRoomState["scores"]): void {
  const rows = records.map((record, index) => ({
    rank: index + 1,
    nickname: record.nickname,
    status: record.seated ? `在座${record.seatIndex !== null ? record.seatIndex + 1 : ""}` : "离座",
    stack: record.stack,
    buyIn: record.buyIn,
    net: record.stack - record.buyIn,
    rakePaid: record.rakePaid,
    pendingBuyIn: record.pendingBuyIn
  }));
  const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body>
    <h2>${escapeHtml(room.settings.tableName)} 积分排行</h2>
    <p>房间 ${escapeHtml(room.roomId)} / 累计抽水 ${room.rakeTotal} / 导出时间 ${new Date().toLocaleString()}</p>
    <table border="1">
      <thead><tr><th>排名</th><th>玩家</th><th>状态</th><th>当前积分</th><th>带入积分</th><th>输赢</th><th>累计抽水</th><th>下局待生效</th></tr></thead>
      <tbody>
        ${rows.map((row) => `<tr><td>${row.rank}</td><td>${escapeHtml(row.nickname)}</td><td>${escapeHtml(row.status)}</td><td>${row.stack}</td><td>${row.buyIn}</td><td>${row.net}</td><td>${row.rakePaid}</td><td>${row.pendingBuyIn}</td></tr>`).join("")}
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
  const messagesRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [room.chat.length]);
  return (
    <section className="panel chatPanel">
      <h3><MessageSquare size={16} /> 聊天</h3>
      <div className="messages" ref={messagesRef}>
        {room.chat.map((message) => (
          <button className="chatMessage" type="button" key={message.id} onClick={() => setText(message.text)} title="点击复制到输入框">
            <strong>{message.nickname}</strong>：{message.text}
          </button>
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
  const hands = useMemo(() => replayHands(room.replay), [room.replay]);
  return (
    <section className="panel replayPanel">
      <div className="panelTitleRow">
        <h3><History size={16} /> 手牌回放</h3>
        <button onClick={() => exportReplayPdf(room)}>导出 PDF</button>
      </div>
      <div className="messages">
        {hands.length ? hands.map((hand, reverseIndex) => <ReplayHandCard key={hand.id} hand={hand} room={room} number={hands.length - reverseIndex} />) : <p>暂无回放记录</p>}
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

type ReplayHand = {
  id: string;
  startedAt: number;
  events: PublicRoomState["replay"];
};

const replayLineTypes = new Set(["act", "draw", "drawRevealShown", "drawReveal", "turn", "river", "stand", "autoStand", "settled"]);

function replayHands(events: PublicRoomState["replay"]): ReplayHand[] {
  const hands: ReplayHand[] = [];
  let current: ReplayHand | null = null;
  for (const event of events) {
    if (event.type === "handStarted") {
      current = { id: event.id, startedAt: event.at, events: [event] };
      hands.push(current);
      continue;
    }
    if (current) current.events.push(event);
  }
  return hands.reverse();
}

function ReplayHandCard({ hand, room, number }: { hand: ReplayHand; room: PublicRoomState; number: number }) {
  const settled = [...hand.events].reverse().find((event) => event.type === "settled");
  const settledPayload = settled?.payload as ReplayPayloadData | undefined;
  const boardPayload = settledPayload?.board ?? [...hand.events].reverse().map((event) => (event.payload as ReplayPayloadData | undefined)?.board).find(Boolean);
  const lines = hand.events.filter((event) => replayLineTypes.has(event.type)).reverse();
  return (
    <article className="replayHandCard">
      <div className="replayHandHeader">
        <strong>第 {number} 手</strong>
        <small>{new Date(hand.startedAt).toLocaleString()}</small>
      </div>
      {settledPayload?.shownHands?.length && <ReplayShowdownTable payload={settledPayload} />}
      {boardPayload && (
        <div className="replayBoardCards">
          <ReplayBoardRow title="Board A" cards={boardPayload.top ?? []} />
          <ReplayBoardRow title="Board B" cards={boardPayload.bottom ?? []} />
        </div>
      )}
      {settledPayload?.playerResults && <SettlementTable results={settledPayload.playerResults} />}
      {settledPayload?.potAwards?.length && (
        <div className="replayAwards">
          {settledPayload.potAwards.map((award, index) => (
            <small key={index}>底池 {index + 1}: {award.amount} → {award.winners.map((id) => playerName(room, id)).join("、")}</small>
          ))}
        </div>
      )}
      <div className="replayActionLine">
        {lines.map((event) => (
          <ReplayEventLine key={event.id} event={event} />
        ))}
      </div>
    </article>
  );
}

function ReplayShowdownTable({ payload }: { payload: ReplayPayloadData }) {
  if (!payload.shownHands?.length) return null;
  const boardDescriptions = new Map<string, Record<string, string>>();
  for (const board of payload.boards ?? []) boardDescriptions.set(board.board, board.descriptions);
  return (
    <div className="replayShowdownTable">
      <span>玩家</span>
      <span>手牌</span>
      <span>得分</span>
      <span>Board A</span>
      <span>Board B</span>
      <span>手牌 Board</span>
      {payload.shownHands.map((shown) => (
        <Fragment key={shown.playerId}>
          <strong>{shown.nickname}</strong>
          <div className="miniShowCards">
            {shown.cards.map((card, index) => <CardView key={index} card={card} small />)}
          </div>
          <b>{payload.points?.[shown.playerId] ?? 0}</b>
          <small>{shortHandDescription(boardDescriptions.get("top")?.[shown.playerId] ?? "-")}</small>
          <small>{shortHandDescription(boardDescriptions.get("bottom")?.[shown.playerId] ?? "-")}</small>
          <small>{shortHandDescription(boardDescriptions.get("hand")?.[shown.playerId] ?? "-")}</small>
        </Fragment>
      ))}
    </div>
  );
}

function ReplayEventLine({ event }: { event: PublicRoomState["replay"][number] }) {
  const groups = replayEventCardGroups(event);
  return (
    <div className="replayEvent">
      <small>{new Date(event.at).toLocaleTimeString()}</small>
      <p>{replayEventMessage(event)}</p>
      {groups.map((group) => (
        <div className="replayEventCards" key={group.label}>
          <span>{group.label}</span>
          <div className="miniShowCards">
            {group.cards.map((card, index) => <CardView key={`${group.label}-${index}`} card={card} small />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function replayEventMessage(event: PublicRoomState["replay"][number]): string {
  if (event.type === "turn") return "Turn 发出";
  if (event.type === "river") return "River 发出";
  if (event.type === "drawRevealShown") return event.message.replace(/\s+[2-9TJQKA][shdc](?=，|,|$)/g, "");
  return event.message.replace(/\s+[2-9TJQKA][shdc](?=\s|\/|，|,|$)/g, "");
}

function replayEventCardGroups(event: PublicRoomState["replay"][number]): Array<{ label: string; cards: Card[] }> {
  const payload = event.payload as ReplayPayloadData | undefined;
  if (!payload) return [];
  if ((event.type === "turn" || event.type === "river") && payload.board) {
    const index = event.type === "turn" ? 3 : 4;
    return [
      { label: "Board A", cards: payload.board.top?.[index] ? [payload.board.top[index]] : [] },
      { label: "Board B", cards: payload.board.bottom?.[index] ? [payload.board.bottom[index]] : [] }
    ].filter((group) => group.cards.length > 0);
  }
  if (event.type === "drawRevealShown" && payload.card) return [{ label: "明牌", cards: [payload.card] }];
  if (event.type === "drawReveal" && payload.reveal) return [{ label: "第一张明牌", cards: [payload.reveal] }];
  return [];
}

function ReplayBoardRow({ title, cards }: { title: string; cards: Card[] }) {
  return (
    <div className="replayBoardRow">
      <strong>{title}</strong>
      <div className="miniShowCards">
        {Array.from({ length: 5 }, (_, index) => <CardView key={index} card={cards[index] ?? "back"} small />)}
      </div>
    </div>
  );
}

type ReplayPayloadData = {
  board?: { top?: Card[]; bottom?: Card[] };
  boards?: ShowdownBoardResult[];
  card?: Card;
  reveal?: Card;
  discarded?: Card;
  pot?: number;
  rakeTotal?: number;
  playerResults?: PlayerSettlement[];
  potAwards?: Array<{ amount: number; rake: number; winners: string[] }>;
  points?: Record<string, number>;
  shownHands?: Array<{ playerId: string; nickname: string; cards: Card[] }>;
};

function ReplayPayload({ event, room }: { event: PublicRoomState["replay"][number]; room: PublicRoomState }) {
  const payload = event.payload as ReplayPayloadData | undefined;
  if (!payload) return null;
  if (event.type === "settled" && payload.playerResults) {
    const myResult = payload.playerResults.find((result) => result.playerId === room.viewerId);
    return (
      <div className="settlementReplay">
        <small>Pot {payload.pot ?? room.pot}</small>
        {myResult && <small>我的比分 {myResult.points} / 本局 {myResult.net >= 0 ? "+" : ""}{myResult.net}</small>}
        {!!payload.shownHands?.length && (
          <div className="replayShownHands">
            {payload.shownHands.map((shown) => (
              <div className="showdownHand" key={shown.playerId}>
                <div className="showdownHandTop">
                  <span>{shown.nickname}</span>
                  <small>{payload.points?.[shown.playerId] ?? 0} 分</small>
                </div>
                <div className="miniShowCards">
                  {shown.cards.map((card, index) => <CardView key={index} card={card} small />)}
                </div>
                {payload.board && <ReplayBoardCards board={payload.board} />}
              </div>
            ))}
          </div>
        )}
        <BoardStrengthSummary boards={payload.boards} room={room} />
        <SettlementTable results={payload.playerResults} />
        {payload.potAwards?.map((award, index) => (
          <small key={index}>底池 {index + 1}: {award.amount} → {award.winners.map((id) => playerName(room, id)).join("、")}</small>
        ))}
      </div>
    );
  }
  if (payload.board) {
    return (
      <div className="settlementReplay">
        <ReplayBoardCards board={payload.board} />
        {typeof payload.pot === "number" ? <small>Pot {payload.pot}</small> : null}
      </div>
    );
  }
  return null;
}

function ReplayBoardCards({ board }: { board: { top?: Card[]; bottom?: Card[] } }) {
  return (
    <div className="replayBoardCompare">
      <ReplayBoardRow title="Board A" cards={board.top ?? []} />
      <ReplayBoardRow title="Board B" cards={board.bottom ?? []} />
    </div>
  );
}

function exportReplayPdf(room: PublicRoomState): void {
  const hands = replayHands(room.replay);
  const rows = hands.map((hand, reverseIndex) => replayHandHtml(hand, room, hands.length - reverseIndex)).join("");
  const html = `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(room.settings.tableName)} 手牌回放</title>
        <style>
          body { margin: 24px; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          h1 { margin: 0 0 6px; font-size: 22px; }
          .meta { margin: 0 0 18px; color: #4b5563; font-size: 12px; }
          .hand { break-inside: avoid; border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; margin-bottom: 16px; display: grid; gap: 10px; }
          .handTitle { display: flex; justify-content: space-between; gap: 12px; color: #111827; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; }
          .handTitle span, small { color: #6b7280; font-size: 11px; }
          .actionLine { display: grid; gap: 4px; padding: 8px; border-radius: 8px; background: #f8fafc; }
          .event { display: grid; gap: 3px; padding: 6px 0; border-bottom: 1px solid #e5e7eb; }
          .event:last-child { border-bottom: 0; }
          .eventTitle { display: flex; justify-content: space-between; gap: 12px; color: #111827; }
          .eventTitle span, small { color: #6b7280; font-size: 11px; }
          .grid { display: grid; gap: 6px; margin-top: 8px; }
          .cardLine { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
          .cardLine b { min-width: 58px; font-size: 11px; color: #374151; }
          .cards { display: flex; gap: 4px; flex-wrap: wrap; }
          .pdfCard { width: 28px; height: 40px; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 900; line-height: 1; }
          .pdfCard .rank { font-size: 12px; }
          .pdfCard .suit { font-size: 16px; }
          .pdfCard.suit-s { color: #111827; }
          .pdfCard.suit-h { color: #c81e1e; }
          .pdfCard.suit-d { color: #1d6fd8; }
          .pdfCard.suit-c { color: #11834a; }
          .shownHands { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
          .cardBox { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; }
          .boardStrengths { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
          .boardStrengthBlock { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; display: grid; gap: 4px; }
          .boardStrengthBlock small { display: flex; justify-content: space-between; gap: 8px; }
          .replayShowdown { display: grid; grid-template-columns: 0.8fr 1.7fr 0.45fr repeat(3, 0.8fr); gap: 5px 8px; align-items: center; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; }
          .replayShowdown small { font-weight: 700; color: #374151; }
          .replayShowdown b { color: #111827; }
          .settlement { display: grid; grid-template-columns: 1.2fr repeat(4, auto); gap: 4px 8px; align-items: center; font-size: 12px; }
          .settlement b { color: #111827; }
          .positive { color: #047857; }
          .negative { color: #b91c1c; }
          @media print { body { margin: 16mm; } button { display: none; } }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(room.settings.tableName)} 手牌回放</h1>
        <p class="meta">房间 ${escapeHtml(room.roomId)} · 导出 ${new Date().toLocaleString()} · 手牌 ${hands.length} 手</p>
        ${rows || "<p>暂无回放记录</p>"}
        <script>setTimeout(() => window.print(), 250);</script>
      </body>
    </html>`;
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    window.alert("浏览器阻止了导出窗口，请允许弹窗后重试。");
    return;
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

function replayPayloadHtml(payload: ReplayPayloadData | undefined, room: PublicRoomState): string {
  if (!payload) return "";
  if (payload.playerResults) {
    const shown = replayShowdownTableHtml(payload);
    const settlements = payload.playerResults.map((result) => `
      <b>${escapeHtml(result.nickname)}${result.folded ? " 弃牌" : ""}</b>
      <span>${result.points}</span>
      <span>${result.contribution}</span>
      <span>${result.awarded}</span>
      <b class="${result.net >= 0 ? "positive" : "negative"}">${result.net >= 0 ? "+" : ""}${result.net}</b>
    `).join("");
    const awards = payload.potAwards?.map((award, index) => `<small>底池 ${index + 1}: ${award.amount} -> ${escapeHtml(award.winners.map((id) => playerName(room, id)).join("、"))}</small>`).join("<br />") ?? "";
    return `<div class="grid">
      <small>Pot ${payload.pot ?? room.pot}</small>
      ${shown}
      <div class="settlement"><small>玩家</small><small>得分</small><small>投入</small><small>分回</small><small>净输赢</small>${settlements}</div>
      ${awards}
    </div>`;
  }
  if (payload.board) {
    return `<div class="grid">${boardHtml(payload.board)}${typeof payload.pot === "number" ? `<small>Pot ${payload.pot}</small>` : ""}</div>`;
  }
  return "";
}

function replayHandHtml(hand: ReplayHand, room: PublicRoomState, number: number): string {
  const settled = [...hand.events].reverse().find((event) => event.type === "settled");
  const settledPayload = settled?.payload as ReplayPayloadData | undefined;
  const boardPayload = settledPayload?.board ?? [...hand.events].reverse().map((event) => (event.payload as ReplayPayloadData | undefined)?.board).find(Boolean);
  const lines = hand.events.filter((event) => replayLineTypes.has(event.type)).reverse();
  const awards = settledPayload?.potAwards?.map((award, index) => `<small>底池 ${index + 1}: ${award.amount} -> ${escapeHtml(award.winners.map((id) => playerName(room, id)).join("、"))}</small>`).join("<br />") ?? "";
  return `
    <section class="hand">
      <div class="handTitle">
        <strong>第 ${number} 手</strong>
        <span>${new Date(hand.startedAt).toLocaleString()}</span>
      </div>
      ${settledPayload ? replayShowdownTableHtml(settledPayload) : ""}
      ${boardPayload ? boardHtml(boardPayload) : ""}
      ${settledPayload?.playerResults ? settlementHtml(settledPayload.playerResults) : ""}
      ${awards}
      <div class="actionLine">
        ${lines.map((event) => `
          <div class="event">
            <div class="eventTitle">
              <strong>${escapeHtml(replayEventMessage(event))}</strong>
              <span>${new Date(event.at).toLocaleTimeString()}</span>
            </div>
            ${replayEventCardsHtml(event)}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function replayEventCardsHtml(event: PublicRoomState["replay"][number]): string {
  const groups = replayEventCardGroups(event);
  if (!groups.length) return "";
  return `<div class="grid">${groups.map((group) => `<div class="cardLine"><b>${escapeHtml(group.label)}</b>${cardsHtml(group.cards)}</div>`).join("")}</div>`;
}

function settlementHtml(results: PlayerSettlement[]): string {
  const rows = results.map((result) => `
    <b>${escapeHtml(result.nickname)}${result.folded ? " 弃牌" : ""}</b>
    <span>${result.points}</span>
    <span>${result.contribution}</span>
    <span>${result.awarded}</span>
    <b class="${result.net >= 0 ? "positive" : "negative"}">${result.net >= 0 ? "+" : ""}${result.net}</b>
  `).join("");
  return `<div class="settlement"><small>玩家</small><small>得分</small><small>投入</small><small>分回</small><small>净输赢</small>${rows}</div>`;
}

function replayShowdownTableHtml(payload: ReplayPayloadData): string {
  if (!payload.shownHands?.length) return "";
  const descriptions = new Map<string, Record<string, string>>();
  for (const board of payload.boards ?? []) descriptions.set(board.board, board.descriptions);
  const rows = payload.shownHands.map((hand) => `
    <b>${escapeHtml(hand.nickname)}</b>
    <span>${cardsHtml(hand.cards)}</span>
    <span>${payload.points?.[hand.playerId] ?? 0}</span>
    <span>${escapeHtml(shortHandDescription(descriptions.get("top")?.[hand.playerId] ?? "-"))}</span>
    <span>${escapeHtml(shortHandDescription(descriptions.get("bottom")?.[hand.playerId] ?? "-"))}</span>
    <span>${escapeHtml(shortHandDescription(descriptions.get("hand")?.[hand.playerId] ?? "-"))}</span>
  `).join("");
  return `<div class="replayShowdown"><small>玩家</small><small>手牌</small><small>得分</small><small>Board A</small><small>Board B</small><small>手牌 Board</small>${rows}</div>`;
}

function boardHtml(board: { top?: Card[]; bottom?: Card[] }): string {
  return `
    <div class="cardLine"><b>Board A</b>${cardsHtml(board.top ?? [])}</div>
    <div class="cardLine"><b>Board B</b>${cardsHtml(board.bottom ?? [])}</div>
  `;
}

function cardsHtml(cards: Card[]): string {
  if (!cards.length) return "<small>-</small>";
  return `<span class="cards">${cards.map(cardHtml).join("")}</span>`;
}

function cardHtml(card: Card): string {
  return `<span class="pdfCard suit-${card.suit}"><span class="rank">${escapeHtml(card.rank)}</span><span class="suit">${suitSymbol(card.suit)}</span></span>`;
}

function BoardStrengthSummary({ boards, room }: { boards?: ShowdownBoardResult[]; room: PublicRoomState }) {
  const publicBoards = boards?.filter((board) => board.board === "top" || board.board === "bottom") ?? [];
  if (!publicBoards.length) return null;
  return (
    <div className="boardStrengthSummary">
      {publicBoards.map((board) => (
        <div className="boardStrengthBlock" key={board.board}>
          <strong>{boardName(board.board)} 各玩家牌力</strong>
          {Object.entries(board.descriptions).map(([id, description]) => (
            <small key={id}>
              <span>{playerName(room, id)}</span>
              <span>{shortHandDescription(description)}</span>
            </small>
          ))}
        </div>
      ))}
    </div>
  );
}

function boardStrengthsHtml(boards: ShowdownBoardResult[] | undefined, room: PublicRoomState): string {
  const publicBoards = boards?.filter((board) => board.board === "top" || board.board === "bottom") ?? [];
  if (!publicBoards.length) return "";
  return `<div class="boardStrengths">
    ${publicBoards.map((board) => `
      <div class="boardStrengthBlock">
        <b>${escapeHtml(boardName(board.board))} 各玩家牌力</b>
        ${Object.entries(board.descriptions).map(([id, description]) => `
          <small><span>${escapeHtml(playerName(room, id))}</span><span>${escapeHtml(shortHandDescription(description))}</span></small>
        `).join("")}
      </div>
    `).join("")}
  </div>`;
}

function SettlementTable({ results }: { results: PlayerSettlement[] }) {
  return (
    <div className="settlementTable">
      <span>玩家</span>
      <span>得分</span>
      <span>投入</span>
      <span>分回</span>
      <span>净输赢</span>
      {results.map((result) => (
        <Fragment key={result.playerId}>
          <strong>{result.nickname}{result.folded ? " 弃牌" : ""}</strong>
          <span>{result.points}</span>
          <span>{result.contribution}</span>
          <span>{result.awarded}</span>
          <strong className={result.net >= 0 ? "positive" : "negative"}>{result.net >= 0 ? "+" : ""}{result.net}</strong>
        </Fragment>
      ))}
    </div>
  );
}

function ShowdownModal({ room, closedKey, onClose }: { room: PublicRoomState; closedKey: string | null; onClose: (key: string) => void }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const key = room.showdown ? showdownKey(room) : "";
  useEffect(() => {
    setPosition({ x: 0, y: 0 });
    setDrag(null);
  }, [key]);
  if (!room.showdown) return null;
  if (closedKey === key) return null;

  function startDrag(event: PointerEvent<HTMLElement>): void {
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y });
  }

  function moveDrag(event: PointerEvent<HTMLElement>): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y
    });
  }

  function stopDrag(event: PointerEvent<HTMLElement>): void {
    if (drag?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  }

  return (
    <section
      className="settlementBanner"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      style={{ transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))` }}
    >
      <button className="iconButton closeButton" onClick={() => onClose(key)} aria-label="关闭">
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
  );
}

function ShowdownDetails({ room }: { room: PublicRoomState }) {
  if (!room.showdown) return null;
  return (
    <div className="showdownFull">
      <strong>摊牌与牌力</strong>
      {room.showdown.noShowdown ? <p>其他玩家已弃牌，获胜者无需亮牌。</p> : <ShowdownTransposedTable room={room} />}
      <strong>底池分配</strong>
      {room.showdown.potAwards.map((award, i) => (
        <p key={i}>{award.amount} → {award.winners.map((id) => playerName(room, id)).join("、")}</p>
      ))}
      <strong>本局输赢</strong>
      <SettlementTable results={room.showdown.playerResults} />
    </div>
  );
}

function ShowdownTransposedTable({ room }: { room: PublicRoomState }) {
  const showdown = room.showdown;
  if (!showdown) return null;
  const shownSeats = room.seats.filter((seat) => seat.playerId && seat.cards?.length && seat.cards.some((card) => card !== "back"));
  if (!shownSeats.length) return null;
  const descriptions = new Map<string, Record<string, string>>();
  for (const board of showdown.boards) descriptions.set(board.board, board.descriptions);
  const rows = [
    { label: "玩家", render: (seat: PublicRoomState["seats"][number]) => <strong>{seat.nickname}{seat.playerId && showdown.winnerIds.includes(seat.playerId) ? <span className="matrixWinText"> WIN</span> : null}</strong> },
    { label: "手牌", render: (seat: PublicRoomState["seats"][number]) => <div className="miniShowCards">{seat.cards?.map((card, index) => <CardView key={index} card={card} small />)}</div> },
    { label: "得分", render: (seat: PublicRoomState["seats"][number]) => <b>{seat.playerId ? showdown.points[seat.playerId] ?? 0 : 0}</b> },
    { label: "Board A", render: (seat: PublicRoomState["seats"][number]) => <span>{seat.playerId ? shortHandDescription(descriptions.get("top")?.[seat.playerId] ?? "-") : "-"}</span> },
    { label: "Board B", render: (seat: PublicRoomState["seats"][number]) => <span>{seat.playerId ? shortHandDescription(descriptions.get("bottom")?.[seat.playerId] ?? "-") : "-"}</span> },
    { label: "手牌 Board", render: (seat: PublicRoomState["seats"][number]) => <span>{seat.playerId ? shortHandDescription(descriptions.get("hand")?.[seat.playerId] ?? "-") : "-"}</span> }
  ];
  return (
    <div className="showdownMatrix" style={{ "--showdown-columns": shownSeats.length } as CSSProperties}>
      {rows.map((row) => (
        <Fragment key={row.label}>
          <small>{row.label}</small>
          {shownSeats.map((seat) => <div className={seat.playerId && showdown.winnerIds.includes(seat.playerId) ? "matrixWinnerCell" : ""} key={`${row.label}-${seat.playerId}`}>{row.render(seat)}</div>)}
        </Fragment>
      ))}
      <small>公共牌</small>
      <div className="showdownMatrixBoard">
        <ReplayBoardRow title="Board A" cards={room.board.top} />
        <ReplayBoardRow title="Board B" cards={room.board.bottom} />
      </div>
    </div>
  );
}

function showdownKey(room: PublicRoomState): string {
  if (!room.showdown) return "";
  return `${room.roomId}:${room.handId ?? "hand"}:${room.showdown.potAwards.map((award) => `${award.amount}-${award.winners.join(".")}`).join("|")}:${Object.entries(room.showdown.points).map(([id, points]) => `${id}-${points}`).join("|")}`;
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
  const totalSeconds = room.street.endsWith("Draw") ? room.settings.drawTimeSeconds : room.settings.thinkingTimeSeconds;
  const total = totalSeconds * 1000;
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

function shortHandDescription(description: string): string {
  return description.replace(/\s*\(.+\)$/, "");
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
