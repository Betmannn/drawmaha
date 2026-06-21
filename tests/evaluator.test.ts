import { describe, expect, it } from "vitest";
import type { Card } from "../shared/types";
import { evaluateFive, evaluateHandBoard, evaluateOmahaBoard, evaluateOmahaCurrent, compareHandRanks } from "../shared/evaluator";

function c(text: string): Card {
  return { rank: text[0] as Card["rank"], suit: text[1] as Card["suit"] };
}

function cards(text: string): Card[] {
  return text.split(/\s+/).map(c);
}

describe("hand evaluator", () => {
  it("evaluates a direct five-card hand board", () => {
    const rank = evaluateHandBoard(cards("Ah Kh Qh Jh Th"));
    expect(rank.category).toBe(8);
  });

  it("requires exactly two hole cards and three board cards for Omaha boards", () => {
    const hand = cards("As Ad 2c 3d 4h");
    const board = cards("Ks Qs Js Ts 9d");
    const rank = evaluateOmahaBoard(hand, board);
    expect(rank.category).toBeLessThan(4);
    const illegalOneHoleStraight = evaluateFive(cards("As Ks Qs Js Ts"));
    expect(compareHandRanks(illegalOneHoleStraight, rank)).toBeGreaterThan(0);
  });

  it("compares full houses over trips", () => {
    const fullHouse = evaluateFive(cards("Th Td Tc 8d 8h"));
    const trips = evaluateFive(cards("Th Td Tc 9s 8h"));
    expect(compareHandRanks(fullHouse, trips)).toBeGreaterThan(0);
  });

  it("evaluates current Omaha strength before river", () => {
    const hand = cards("Ah Th Td 9h 9c");
    const flop = cards("Kh Qh 2s");
    const turn = cards("Kh Qh 2s Jc");
    expect(evaluateOmahaCurrent(hand, flop)?.description).toContain("一对");
    expect(evaluateOmahaCurrent(hand, turn)?.description).toContain("顺子");
  });
});
