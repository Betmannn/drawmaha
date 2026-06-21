import { describe, expect, it } from "vitest";
import { GameStore, act, approveBuyIn, autoTimeout, buyIn, drawRevealDecision, drawSelect, joinRoom, privateState, publicState, requestBuyIn, sit, sitRandom, stand, startHand, transferHost } from "../server/game";
import type { Card } from "../shared/types";

function c(text: string): Card {
  return { rank: text[0] as Card["rank"], suit: text[1] as Card["suit"] };
}

function cards(text: string): Card[] {
  return text.split(/\s+/).map(c);
}

describe("game flow", () => {
  it("starts a hand and hides private cards from spectators", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10, thinkingTimeSeconds: 20 });
    joinRoom(room, "p2", "P2");
    joinRoom(room, "spec", "Watcher", true);
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    const hostPublic = publicState(room, "host");
    const spectatorPublic = publicState(room, "spec");
    const hostCards = hostPublic.seats[0].cards;
    const spectatorCards = spectatorPublic.seats[0].cards;

    expect(hostCards?.[0]).not.toBe("back");
    expect(spectatorCards).toEqual(["back", "back", "back", "back", "back"]);
    expect(privateState(room, "host")?.hand).toHaveLength(5);
  });

  it("rotates the dealer button and makes the dealer act last", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    joinRoom(room, "p3", "P3");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    sit(room, "p3", 2);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    buyIn(room, "p3", 1000);

    startHand(room, "host");

    expect(publicState(room, "host").dealerSeat).toBe(0);
    expect(room.hand!.currentSeat).toBe(1);
    act(room, "p2", { type: "check" });
    expect(room.hand!.currentSeat).toBe(2);
    act(room, "p3", { type: "check" });
    expect(room.hand!.currentSeat).toBe(0);
    act(room, "host", { type: "check" });
    expect(room.hand!.street).toBe("flopDraw");
    expect(room.hand!.currentSeat).toBe(1);

    room.hand!.street = "settled";
    startHand(room, "host");

    expect(publicState(room, "host").dealerSeat).toBe(1);
    expect(room.hand!.currentSeat).toBe(2);
  });

  it("reveals one-card draw publicly and supports reject to dark card", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    room.hand!.street = "flopDraw";
    room.hand!.currentSeat = 0;
    room.seats[0].acted = false;
    room.seats[1].acted = true;

    const original = room.seats[0].hand[0];
    const reveal = drawSelect(room, "host", [0]);
    expect(reveal).toBeTruthy();
    expect(privateState(room, "host")?.pendingDrawReveal).toEqual(reveal);
    expect(publicState(room, "p2").drawReveal).toEqual({ playerId: "host", nickname: "Host", card: reveal, status: "pending" });
    drawRevealDecision(room, "host", false);
    expect(publicState(room, "p2").drawReveal).toBeNull();
    expect(publicState(room, "p2").seats[0].lastAction).toBe("不要第一张");
    expect([...room.replay].reverse().find((event) => event.type === "drawReveal")?.payload).toMatchObject({ playerId: "host", accept: false });
    expect(room.seats[0].hand[0]).not.toEqual(original);
    expect(room.seats[0].hand[0]).not.toEqual(reveal);
  });

  it("does not show cards when a bet wins by folds", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    act(room, "p2", { type: "bet", amount: 20 });
    act(room, "host", { type: "fold" });

    expect(room.hand!.street).toBe("settled");
    expect(room.hand!.showdown?.noShowdown).toBe(true);
    expect(room.hand!.showdown?.shownPlayerIds).toEqual([]);
    expect(publicState(room, "host").seats[1].cards).toEqual(["back", "back", "back", "back", "back"]);
  });

  it("uses predealt turn and river cards instead of cards discarded during draws", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    room.hand!.street = "flopDraw";
    room.hand!.currentSeat = 0;
    room.seats[0].acted = false;
    room.seats[1].acted = true;

    const reservedTurnTop = room.hand!.runout.top[0];
    const reservedTurnBottom = room.hand!.runout.bottom[0];
    const discarded = room.seats[0].hand.slice(0, 3);

    drawSelect(room, "host", [0, 1, 2]);

    expect(room.hand!.street).toBe("turnBet");
    expect(room.hand!.board.top[3]).toEqual(reservedTurnTop);
    expect(room.hand!.board.bottom[3]).toEqual(reservedTurnBottom);
    expect(discarded).not.toContainEqual(room.hand!.board.top[3]);
    expect(discarded).not.toContainEqual(room.hand!.board.bottom[3]);
  });

  it("reshuffles prior discards when the deck is short without returning current player discards", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    room.hand!.street = "flopDraw";
    room.hand!.currentSeat = 0;
    room.seats[0].acted = false;
    room.seats[1].acted = true;
    room.seats[0].hand = cards("2s 3s 4s 5s 6s");
    room.hand!.deck = cards("7s");
    room.hand!.discards = cards("Ah Kh Qh");

    drawSelect(room, "host", [0, 1, 2]);

    const currentDiscards = cards("2s 3s 4s");
    expect(room.seats[0].hand.slice(0, 3)).not.toContainEqual(currentDiscards[0]);
    expect(room.seats[0].hand.slice(0, 3)).not.toContainEqual(currentDiscards[1]);
    expect(room.seats[0].hand.slice(0, 3)).not.toContainEqual(currentDiscards[2]);
    expect(room.seats[0].hand).toHaveLength(5);
  });

  it("requires host transfer before host leaves when another player is seated", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", {});
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    expect(() => stand(room, "host")).toThrow("转交");
    transferHost(room, "host", "p2");
    stand(room, "host");
    expect(room.hostId).toBe("p2");
    expect(room.seats[0].playerId).toBeNull();
  });

  it("returns a player to their previous seat when they sit again", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", {});
    sitRandom(room, "host");
    const firstSeat = room.participants.get("host")!.seatIndex;
    stand(room, "host");
    expect(room.participants.get("host")!.seatIndex).toBeNull();
    expect(sitRandom(room, "host")).toBe(firstSeat);
    expect(room.participants.get("host")!.seatIndex).toBe(firstSeat);
  });

  it("lets a losing heads-up river caller muck after calling a bet", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    joinRoom(room, "spec", "Watcher", true);
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    room.hand!.street = "riverBet";
    room.hand!.board = {
      top: cards("9s 9d 2c 3h 4d"),
      bottom: cards("Kh Kd 5c 6h 7d")
    };
    room.hand!.currentSeat = 0;
    room.hand!.currentBet = 0;
    room.hand!.minRaise = 1;
    room.seats[0].hand = cards("Ah Ad Ac Qc Jc");
    room.seats[1].hand = cards("2h 3d 4c 5s 7h");
    for (const seat of room.seats.slice(0, 2)) {
      seat.currentBet = 0;
      seat.acted = false;
      seat.folded = false;
      seat.allIn = false;
      seat.lastAction = null;
    }

    act(room, "host", { type: "bet", amount: 20 });
    act(room, "p2", { type: "call" });

    expect(room.hand!.showdown?.winnerIds).toEqual(["host"]);
    expect(room.hand!.showdown?.shownPlayerIds).toEqual(["host"]);
    const spectator = publicState(room, "spec");
    expect(spectator.seats[0].cards?.[0]).not.toBe("back");
    expect(spectator.seats[1].cards).toEqual(["back", "back", "back", "back", "back"]);
  });

  it("requires host approval before a player buy-in is applied", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", {});
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);

    requestBuyIn(room, "p2", 500);
    expect(room.seats[1].stack).toBe(0);
    expect(publicState(room, "host").pendingBuyIns).toHaveLength(1);

    approveBuyIn(room, "host", room.pendingBuyIns[0].id);
    expect(room.seats[1].stack).toBe(500);
    expect(room.seats[1].buyIn).toBe(500);
    expect(publicState(room, "host").pendingBuyIns).toHaveLength(0);
  });

  it("applies approved buy-ins during a hand on the next hand", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    requestBuyIn(room, "p2", 500);
    approveBuyIn(room, "host", room.pendingBuyIns[0].id);

    expect(room.seats[1].stack).toBe(990);
    expect(room.seats[1].pendingBuyIn).toBe(500);
    room.hand!.street = "settled";
    startHand(room, "host");
    expect(room.seats[1].stack).toBe(1480);
    expect(room.seats[1].pendingBuyIn).toBe(0);
  });

  it("defaults timed-out draw decisions to no draw", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10, thinkingTimeSeconds: 5 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");
    room.hand!.street = "flopDraw";
    room.hand!.currentSeat = 0;
    room.hand!.timerEndsAt = Date.now() - 1;
    room.seats[0].acted = false;
    room.seats[1].acted = true;

    autoTimeout(room);

    expect(room.seats[0].drawCount).toBe(0);
    expect(room.hand!.street).toBe("turnBet");
  });

  it("takes rake from pots with a per-hand cap", () => {
    const store = new GameStore();
    const room = store.createRoom("host", "Host", { ante: 10, rakePercent: 10, rakeCap: 3 });
    joinRoom(room, "p2", "P2");
    sit(room, "host", 0);
    sit(room, "p2", 1);
    buyIn(room, "host", 1000);
    buyIn(room, "p2", 1000);
    startHand(room, "host");

    act(room, "p2", { type: "check" });
    act(room, "host", { type: "bet", amount: 20 });
    act(room, "p2", { type: "fold" });

    expect(room.hand!.showdown?.rakeTotal).toBe(3);
    expect(room.hand!.showdown?.potAwards[0].amount).toBe(37);
    expect(room.hand!.showdown?.playerResults.find((result) => result.playerId === "host")?.net).toBe(7);
    expect(room.hand!.showdown?.playerResults.find((result) => result.playerId === "p2")?.net).toBe(-10);
  });
});
