import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrated, calibrationFactor, calibrationNote, PRIOR_TRADES } from "./calibration";

test("with no closed trades a strategy ranks exactly as predicted", () => {
  assert.equal(calibrationFactor(0, null), 1);
  assert.equal(calibrationFactor(0, 0.4), 1);
});

test("a handful of trades barely moves it", () => {
  // Three trades at half the prediction: noise, most likely.
  const f = calibrationFactor(3, 0.5);
  assert.ok(f > 0.85 && f < 0.9, `got ${f}`);
});

test("evidence moves it toward the realised ratio: halfway at the prior, most of the way beyond", () => {
  assert.equal(calibrationFactor(PRIOR_TRADES, 0.5), 0.75);
  assert.equal(calibrationFactor(40, 0.5), 0.6);
});

test("one freak result cannot flip a strategy's sign or triple it", () => {
  assert.ok(calibrationFactor(1, -3) >= 0, "losses shrink it toward zero, never below");
  assert.ok(calibrationFactor(1, 50) <= 2, "a windfall is capped");
});

test("a strategy that beats its predictions is promoted, slowly", () => {
  assert.ok(calibrationFactor(20, 1.3) > 1);
});

test("the calibrated margin is the margin scaled, and untouched without a record", () => {
  assert.equal(calibrated(40, { factor: 0.75, closed: 10, note: "" }), 30);
  assert.equal(calibrated(40, undefined), 40);
});

test("the note says how much evidence stands behind the factor", () => {
  assert.match(calibrationNote("spread", 3, 0.5, 0.885), /too few yet/);
  assert.match(calibrationNote("set", 0, null, 1), /no closed set trades/);
});
