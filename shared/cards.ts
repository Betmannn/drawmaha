import type { Card, Rank, Suit } from "./types";

export const ranks: Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const suits: Suit[] = ["s", "h", "d", "c"];

export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function suitSymbol(suit: Suit): string {
  return ({ s: "♠", h: "♥", d: "♦", c: "♣" } as const)[suit];
}

export function cardToDisplay(card: Card): string {
  return `${card.rank}${suitSymbol(card.suit)}`;
}

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of suits) {
    for (const rank of ranks) deck.push({ rank, suit });
  }
  return deck;
}

export function shuffle(deck: Card[], random = Math.random): Card[] {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function draw(deck: Card[]): Card {
  const card = deck.pop();
  if (!card) throw new Error("Deck is empty");
  return card;
}

export function describeCards(cards: Card[]): string {
  return cards.map(cardToString).join(" ");
}
