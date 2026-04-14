// src/lib/plans.ts
export type PlanId = "free" | "basic" | "plus" | "pro" | "company" | "visual";
export type Locale = "en" | "fi" | "es";

// UI käyttää vielä legacy-nimiä devPlan-headerissa:
// lite -> visual (vanha) -> basic (uusi)
// visual -> basic
// partner -> company
export function normalizePlanId(raw: any): PlanId {
  const s = String(raw || "").toLowerCase().trim();

  // legacy aliases
  if (s === "lite") return "basic";
  if (s === "visual") return "basic";
  if (s === "partner") return "company";

  if (s === "free" || s === "basic" || s === "plus" || s === "pro" || s === "company") {
    return s as PlanId;
  }

  return "free";
}

/**
 * Plan = “totuus” plan-objektista, mutta mukana myös alias-kenttiä,
 * jotta vanha ja uusi koodi toimii yhtä aikaa.
 */
export type Plan = {
  id: PlanId;

  // chat
  messagesPerMonth: number;

  /**
   * Kuvat (analyysi) – vanha kenttä
   */
  imageAnalysesPerMonth: number;

  /**
   * Kuvat (alias) – osa koodista käyttää tätä
   */
  imagesPerMonth: number;

  /**
   * Kuvien generointi (erillinen kiintiö)
   */
  imageGenerationsPerMonth: number;

  // web
  webSearchesPerMonth: number;

  /**
   * Työmuisti (viestien määrä) – uusi/selkeä kenttä
   */
  workMemoryMessages: number;

  /**
   * Työmuisti (alias) – usage.ts odottaa tätä nimeä
   */
  memorySlots: number;
};

/**
 * usage.ts:n käyttämä rajoitusrakenne.
 */
export type PlanLimits = {
  msgPerMonth: number;
  imgPerMonth: number;
  webPerMonth: number;
  memorySlots: number;
};

/**
 * usage.ts importtaa PLANS suoraan -> exportataan.
 *
 * LUKITTU HINNASTO / RAJAT:
 * - Free 0€:
 *   20 viestiä / vrk (päivälogiikka route:ssa)
 *   ei web-hakuja
 *   ei kuvan generointia
 *   muisti 5
 *
 * - Basic 3,99€:
 *   1000 viestiä / kk
 *   5 kuva-analyysiä / vrk
 *   1 kuva gen / vrk
 *   muisti 10
 *   ei web-hakuja
 *
 * - Plus 9,99€:
 *   1000 viestiä / kk
 *   120 kuva-analyysiä / kk
 *   2 kuva gen / vrk
 *   muisti 15
 *   ei web-hakuja
 *
 * - Pro 19,99€:
 *   3000 viestiä / kk
 *   200 kuva-analyysiä / kk
 *   100 kuva gen / kk
 *   200 web / kk
 *   muisti 50
 *
 * - Company 29,99€:
 *   4000 viestiä / kk
 *   300 kuva-analyysiä / kk
 *   200 kuva gen / kk
 *   300 web / kk
 *   muisti 75
 *
 * HUOM:
 * Free on päiväkohtainen route-logiikassa, mutta tässä pidetään 20 UI/display-yhteensopivuuden vuoksi.
 * Basic on oikeasti 1000 / kk.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",

    // Free näyttää 20 ja oikea esto tehdään route:ssa päiväkohtaisesti.
    messagesPerMonth: 20,

    imageAnalysesPerMonth: 0,
    imagesPerMonth: 0,
    imageGenerationsPerMonth: 0,

    webSearchesPerMonth: 0,

    workMemoryMessages: 5,
    memorySlots: 5,
  },

  basic: {
    id: "basic",

    // OIKEA: 1000 / kk
    messagesPerMonth: 1000,

    // 5 / vrk -> kuukausiarvio 150 display/yhteensopivuuteen
    imageAnalysesPerMonth: 150,
    imagesPerMonth: 150,

    // 1 / vrk -> kuukausiarvio 30
    imageGenerationsPerMonth: 30,

    webSearchesPerMonth: 0,

    workMemoryMessages: 10,
    memorySlots: 10,
  },

  plus: {
    id: "plus",
    messagesPerMonth: 1000,

    imageAnalysesPerMonth: 120,
    imagesPerMonth: 120,

    // 2 / vrk -> kuukausiarvio 60
    imageGenerationsPerMonth: 60,

    webSearchesPerMonth: 0,

    workMemoryMessages: 15,
    memorySlots: 15,
  },

  pro: {
    id: "pro",
    messagesPerMonth: 3000,

    imageAnalysesPerMonth: 200,
    imagesPerMonth: 200,

    imageGenerationsPerMonth: 100,

    webSearchesPerMonth: 200,

    workMemoryMessages: 50,
    memorySlots: 50,
  },

  company: {
    id: "company",
    messagesPerMonth: 4000,

    imageAnalysesPerMonth: 300,
    imagesPerMonth: 300,

    imageGenerationsPerMonth: 200,

    webSearchesPerMonth: 300,

    workMemoryMessages: 75,
    memorySlots: 75,
  },

  // legacy placeholder: älä käytä enää suoraan, normalisoidaan basic:iin
  visual: {
    id: "visual",

    // pidetään samana kuin basic yhteensopivuuden vuoksi
    messagesPerMonth: 1000,
    imageAnalysesPerMonth: 150,
    imagesPerMonth: 150,
    imageGenerationsPerMonth: 30,
    webSearchesPerMonth: 0,
    workMemoryMessages: 10,
    memorySlots: 10,
  },
};

export function getPlan(planId: PlanId) {
  const id = normalizePlanId(planId);
  return PLANS[id];
}

export function getMessageLimitReachedText(planId: PlanId, locale: Locale): string {
  const id = normalizePlanId(planId);

  if (id === "free") {
    switch (locale) {
      case "fi":
        return "Olet saavuttanut ilmaistason päivittäisen viestirajan. Päivitä maksulliseen versioon jatkaaksesi keskustelua.";
      case "es":
        return "Has alcanzado el límite diario de mensajes del plan gratuito. Actualiza a una versión de pago para seguir chateando.";
      case "en":
      default:
        return "You have reached your free daily message limit. Upgrade to continue chatting.";
    }
  }

  if (id === "basic") {
    switch (locale) {
      case "fi":
        return "Olet saavuttanut kuukausittaisen viestirajan. Päivitä Plus-versioon tai osta lisäpaketti jatkaaksesi.";
      case "es":
        return "Has alcanzado tu límite mensual de mensajes. Actualiza a Plus o compra un paquete adicional para continuar.";
      case "en":
      default:
        return "You have reached your monthly message limit. Upgrade to Plus or buy an extra pack to continue.";
    }
  }

  switch (locale) {
    case "fi":
      return "Olet saavuttanut viestirajan.";
    case "es":
      return "Has alcanzado el límite de mensajes.";
    case "en":
    default:
      return "You have reached your message limit.";
  }
}