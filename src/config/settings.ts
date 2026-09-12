import { getMeta, setMeta, type Db } from "../db/index";
import { DEFAULT_ALERT_POLICY, type AlertPolicy } from "../live/detect";

export interface AppSettings {
  discordWebhook: string;
  defaultBudget: number;
  maxPerItem: number;
  cashReserve: number;
  maxPerGroup: number;
  minConfidence: "low" | "medium" | "high";
  pollSeconds: number;
  alert: Pick<AlertPolicy, "sellDiscount" | "buyPremium" | "minProfit" | "minVolume48h">;
}

export const DEFAULT_SETTINGS: AppSettings = {
  discordWebhook: "", defaultBudget: 500, maxPerItem: 150, cashReserve: 75, maxPerGroup: 6, minConfidence: "medium", pollSeconds: 90,
  alert: { sellDiscount: DEFAULT_ALERT_POLICY.sellDiscount, buyPremium: DEFAULT_ALERT_POLICY.buyPremium,
    minProfit: DEFAULT_ALERT_POLICY.minProfit, minVolume48h: DEFAULT_ALERT_POLICY.minVolume48h },
};

const KEY = "settings:v1";
export function appSettings(db: Db): AppSettings {
  try {
    const saved = JSON.parse(getMeta(db, KEY) ?? "{}") as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...saved, alert: { ...DEFAULT_SETTINGS.alert, ...(saved.alert ?? {}) } };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}

export function saveAppSettings(db: Db, value: AppSettings): void {
  setMeta(db, KEY, JSON.stringify(value));
}

export function alertPolicy(db: Db): AlertPolicy {
  return { ...DEFAULT_ALERT_POLICY, ...appSettings(db).alert };
}
