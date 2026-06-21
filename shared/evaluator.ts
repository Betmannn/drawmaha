import { cardToDisplay } from "./cards";
import type { Card } from "./types";

const rankValue: Record<string, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14
};

const categoryName = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺"
];

export interface HandRank {
  category: number;
  tiebreakers: number[];
  description: string;
  cards: Card[];
}

function descending(values: number[]): number[] {
  return [...values].sort((a, b) => b - a);
}

function straightHigh(values: number[]): number | null {
  const unique = Array.from(new Set(values)).sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i += 1) {
    const window = unique.slice(i, i + 5);
    if (window[0] - window[4] === 4) return window[0];
  }
  return null;
}

export function evaluateFive(cards: Card[]): HandRank {
  if (cards.length !== 5) throw new Error("evaluateFive requires exactly 5 cards");
  const values = cards.map((card) => rankValue[card.rank]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straight = straightHigh(values);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let category = 0;
  let tiebreakers = descending(values);

  if (flush && straight) {
    category = 8;
    tiebreakers = [straight];
  } else if (groups[0][1] === 4) {
    category = 7;
    tiebreakers = [groups[0][0], ...descending(groups.filter((group) => group[1] === 1).map(([value]) => value))];
  } else if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    category = 6;
    tiebreakers = [groups[0][0], groups[1][0]];
  } else if (flush) {
    category = 5;
    tiebreakers = descending(values);
  } else if (straight) {
    category = 4;
    tiebreakers = [straight];
  } else if (groups[0][1] === 3) {
    category = 3;
    tiebreakers = [groups[0][0], ...descending(groups.filter((group) => group[1] === 1).map(([value]) => value))];
  } else if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    category = 2;
    const pairs = descending(groups.filter((group) => group[1] === 2).map(([value]) => value));
    const kicker = groups.find((group) => group[1] === 1)?.[0] ?? 0;
    tiebreakers = [...pairs, kicker];
  } else if (groups[0][1] === 2) {
    category = 1;
    tiebreakers = [groups[0][0], ...descending(groups.filter((group) => group[1] === 1).map(([value]) => value))];
  }

  return {
    category,
    tiebreakers,
    description: `${categoryName[category]} (${cards.map(cardToDisplay).join(" ")})`,
    cards
  };
}

export function compareHandRanks(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  return [
    ...combinations(rest, size - 1).map((combo) => [first, ...combo]),
    ...combinations(rest, size)
  ];
}

export function evaluateOmahaBoard(hand: Card[], board: Card[]): HandRank {
  if (hand.length !== 5) throw new Error("Omaha hand must contain 5 cards");
  if (board.length !== 5) throw new Error("Omaha board must contain 5 cards at showdown");
  let best: HandRank | null = null;
  for (const holeCombo of combinations(hand, 2)) {
    for (const boardCombo of combinations(board, 3)) {
      const rank = evaluateFive([...holeCombo, ...boardCombo]);
      if (!best || compareHandRanks(rank, best) > 0) best = rank;
    }
  }
  if (!best) throw new Error("Unable to evaluate Omaha board");
  return best;
}

export function evaluateOmahaCurrent(hand: Card[], board: Card[]): HandRank | null {
  if (hand.length !== 5) throw new Error("Omaha hand must contain 5 cards");
  if (board.length < 3) return null;
  let best: HandRank | null = null;
  for (const holeCombo of combinations(hand, 2)) {
    for (const boardCombo of combinations(board, 3)) {
      const rank = evaluateFive([...holeCombo, ...boardCombo]);
      if (!best || compareHandRanks(rank, best) > 0) best = rank;
    }
  }
  return best;
}

export function evaluateHandBoard(hand: Card[]): HandRank {
  return evaluateFive(hand);
}
