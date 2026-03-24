// src/app/chat/imageClient.ts

// Yhdenmukainen uusien plan-id:iden kanssa
export type Plan = "free" | "visual" | "basic" | "pro" | "company";

export type Limits = {
  // HUOM: image endpoint palauttaa sun omat limits-avaimet (imgGenPerMonth/imgGenPerDay).
  // Pidetään tämä väljänä, koska muualla projektissa voi olla eri limits-mallit.
  [k: string]: any;
};

export type Usage = {
  // Samoin usage: endpointissä on imgGenThisMonth jne.
  [k: string]: any;
};

export type ImageOkJson =
  | {
      ok: true;
      format: "png";
      data: string; // base64
      source: "openai" | "fallback_svg";
      plan: Plan;
      limits: Limits;
      usage: Usage;
      note?: string;

      // optional: vanhat kentät
      imageId?: string;
      imageUrl?: string;
      markdown?: string;
    }
  | {
      ok: true;
      format: "svg";
      data: string; // raw svg
      source: "openai" | "fallback_svg";
      plan: Plan;
      limits: Limits;
      usage: Usage;
      note?: string;

      imageId?: string;
      imageUrl?: string;
      markdown?: string;
    };

export type ImageErrJson = {
  ok: false;
  error: string;
  plan?: Plan;
  limits?: Limits;
  usage?: Usage;
  upsell?: { message?: string };
};

export function makeImageMarkdown(prompt: string, j: ImageOkJson) {
  let src = "";
  if (j.format === "png") src = `data:image/png;base64,${j.data}`;
  else src = `data:image/svg+xml;utf8,${encodeURIComponent(j.data)}`;

  return `🖼️ ${prompt}\n\n![AJX Image](${src})`;
}

export async function generateImage(
  prompt: string,
  devPlan?: Plan | null,
  size: string = "1024x1024"
): Promise<ImageOkJson | ImageErrJson> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (devPlan) headers["x-ajx-dev-plan"] = devPlan;

  const res = await fetch("/api/image", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, size }),
  });

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: t || "Image endpoint returned non-JSON." };
  }

  const j: any = await res.json();

  // error
  if (!j || j.ok === false) {
    return {
      ok: false,
      error: String(j?.error || "Image generation failed."),
      plan: j?.plan,
      limits: j?.limits,
      usage: j?.usage,
      upsell: j?.upsell,
    };
  }

  // success: jos uusi muoto on kunnossa
  if (j.ok === true && j.format && j.data) {
    return j as ImageOkJson;
  }

  // success: fallback jos server palautti vain imageUrl/markdown (tai joku vanha muoto)
  // Ei kaadeta UI:ta — palautetaan png mutta data tyhjänä => UI voi käyttää j.markdown tai j.imageUrl
  if (j.ok === true) {
    return {
      ok: true,
      format: "png",
      data: "",
      source: "openai",
      plan: j.plan,
      limits: j.limits,
      usage: j.usage,
      note: "Server returned legacy image payload (imageUrl/markdown).",
      imageId: j.imageId,
      imageUrl: j.imageUrl,
      markdown: j.markdown,
    } as ImageOkJson;
  }

  return { ok: false, error: "Image endpoint returned unexpected JSON." };
}