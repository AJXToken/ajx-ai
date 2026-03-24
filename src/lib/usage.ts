// src/lib/usage.ts
import { PLANS, type PlanId, type PlanLimits } from "./plans";

export type UsageCounters = {
  msgThisMonth: number;
  imgThisMonth: number;
  webThisMonth: number;
  extraImgThisMonth?: number;
};

// ✅ Muunna PLANS -> PlanLimits-muotoon (msgPerMonth/imgPerMonth/webPerMonth)
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = (Object.keys(PLANS) as PlanId[]).reduce((acc, id) => {
  const p = PLANS[id];
  acc[id] = {
    msgPerMonth: p.messagesPerMonth,
    imgPerMonth: p.imagesPerMonth,
    webPerMonth: p.webSearchesPerMonth,
    memorySlots: p.memorySlots,
  };
  return acc;
}, {} as Record<PlanId, PlanLimits>);

export type Limits = {
  messagesPerMonth: number;
  imagesPerMonth: number;
  webSearchesPerMonth: number;
};

export function getLimitsForPlan(planId: PlanId, counters?: UsageCounters): Limits {
  const base = PLAN_LIMITS[planId] || PLAN_LIMITS.free;

  return {
    // ✅ nämä pitää tulla PlanLimits kentistä (msg/img/web)
    messagesPerMonth: base.msgPerMonth,
    imagesPerMonth: base.imgPerMonth + (counters?.extraImgThisMonth || 0),
    webSearchesPerMonth: base.webPerMonth,
  };
}

// ---- (jos tiedostossa oli muita funktioita, jätetään ne ennalleen) ----
// Tämä tiedosto oli aiemmin tehty limits-laskentaa varten.
// Jos sulla on täällä lisää logiikkaa (monthKey/localStorage/...) ja haluat
// pitää sen, liitä se tänne niin teen “täyden merge-version” kokonaisena.
