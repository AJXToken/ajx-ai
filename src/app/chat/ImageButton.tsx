// src/app/chat/ImageButton.tsx
"use client";

import React from "react";
import { t, type Locale } from "../../lib/i18n";
import type { Plan } from "./imageClient";

type SourceImage = {
  name?: string;
  type?: string;
  dataUrl: string;
};

type Props = {
  disabled?: boolean;
  devPlan?: Plan | null;
  getPrompt: () => string;
  clearPrompt?: () => void;
  onStatus?: (txt: string) => void;

  // Valinnainen: page.tsx voi myöhemmin antaa liitetyn kuvan tähän.
  getSourceImage?: () => SourceImage | null;
};

const LOCALE_STORAGE_KEY = "ajx_locale_v1";
const DEFAULT_IMAGE_SIZE = "768x768";

function clampLocale(v: string | null): Locale {
  const s = (v || "").toLowerCase().trim();
  if (s === "fi" || s === "en" || s === "es") return s as Locale;
  return "fi";
}

function readLocale(): Locale {
  try {
    return clampLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return "fi";
  }
}

function toAbsoluteUrl(u: string): string {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;

  try {
    return `${window.location.origin}${s.startsWith("/") ? "" : "/"}${s}`;
  } catch {
    return s;
  }
}

function makeMarkdownImageFromBase64Png(b64: string) {
  const clean = String(b64 || "").trim();
  if (!clean) return "";
  const dataUrl = `data:image/png;base64,${clean}`;
  return `![AJX Image](${dataUrl})`;
}

function makeMarkdownImageFromAnyUrl(url: string) {
  const abs = toAbsoluteUrl(url);
  if (!abs) return "";
  return `![AJX Image](${abs})`;
}

function looksLikeEditPrompt(prompt: string, locale: Locale) {
  const s = String(prompt || "").trim().toLowerCase();
  if (!s) return false;

  if (locale === "fi") {
    return (
      s.includes("muokkaa") ||
      s.includes("poista tausta") ||
      s.includes("vaihda tausta") ||
      s.includes("tee tästä") ||
      s.includes("muuta tämä") ||
      s.includes("paranna tätä") ||
      s.includes("rajaa tämä")
    );
  }

  if (locale === "es") {
    return (
      s.includes("edita") ||
      s.includes("editar") ||
      s.includes("quita el fondo") ||
      s.includes("cambia el fondo") ||
      s.includes("mejora esta imagen") ||
      s.includes("recorta esta imagen")
    );
  }

  return (
    s.includes("edit") ||
    s.includes("remove background") ||
    s.includes("change background") ||
    s.includes("improve this image") ||
    s.includes("crop this image") ||
    s.includes("modify this image")
  );
}

function getAskText(locale: Locale, hasSourceImage: boolean) {
  if (locale === "fi") {
    return hasSourceImage
      ? "Kuva on liitetty. Kirjoita muokkausohje tai uuden kuvan prompt."
      : t(locale, "image.prompt.ask");
  }
  if (locale === "es") {
    return hasSourceImage
      ? "Hay una imagen adjunta. Escribe la instrucción de edición o el prompt de nueva imagen."
      : t(locale, "image.prompt.ask");
  }
  return hasSourceImage
    ? "An image is attached. Write the edit instruction or a new image prompt."
    : t(locale, "image.prompt.ask");
}

function getMissingPromptText(locale: Locale) {
  if (locale === "fi") return "Kirjoita ensin kuvan pyyntö tai muokkausohje.";
  if (locale === "es") return "Escribe primero una instrucción para la imagen.";
  return "Write an image prompt or edit instruction first.";
}

function getGeneratingText(locale: Locale, prompt: string, editing: boolean) {
  if (editing) {
    if (locale === "fi") return `🛠️ Muokataan kuvaa: ${prompt}`;
    if (locale === "es") return `🛠️ Editando imagen: ${prompt}`;
    return `🛠️ Editing image: ${prompt}`;
  }

  return t(locale, "image.generating", { prompt });
}

function pickPrompt(props: Props, locale: Locale, hasSourceImage: boolean): string {
  const fromField = (props.getPrompt?.() || "").trim();
  if (fromField) return fromField;

  const asked = window.prompt(getAskText(locale, hasSourceImage), "");
  return (asked || "").trim();
}

function dismissMobileKeyboard() {
  try {
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
  } catch {}
}

export default function ImageButton(props: Props) {
  const [busy, setBusy] = React.useState(false);

  const locale = readLocale();
  const a11yLabel = `✨ ${t(locale, "ui.create_images")}`;

  async function onClick() {
    if (busy || props.disabled) return;

    dismissMobileKeyboard();

    const sourceImage = props.getSourceImage?.() || null;
    const hasSourceImage = !!sourceImage?.dataUrl;

    const prompt = pickPrompt(props, locale, hasSourceImage);
    if (!prompt) {
      props.onStatus?.(getMissingPromptText(locale));
      return;
    }

    const editing = hasSourceImage && looksLikeEditPrompt(prompt, locale);

    setBusy(true);
    props.onStatus?.(getGeneratingText(locale, prompt, editing));

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (props.devPlan) headers["x-ajx-dev-plan"] = props.devPlan;

      const body: Record<string, any> = {
        prompt,
        size: DEFAULT_IMAGE_SIZE,
        locale,

        // Halvempi oletusprofiili backendille
        preferredProvider: "gemini",
        preferredModelFamily: "gemini-2.5-flash-image",
        costTier: "low",
        quality: "standard",
        latencyTier: "fast",
      };

      // Tämä lähtee mukaan vain jos page.tsx antaa lähdekuvan.
      if (hasSourceImage) {
        body.sourceImage = {
          name: sourceImage?.name || "image",
          type: sourceImage?.type || "image/png",
          dataUrl: sourceImage?.dataUrl,
        };
        body.editing = editing;
      }

      const res = await fetch("/api/image", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const ct = res.headers.get("content-type") || "";

      if (!res.ok) {
        const errText = ct.includes("application/json")
          ? (await res.json().catch(() => null))?.error || `HTTP ${res.status}`
          : (await res.text().catch(() => "")) || `HTTP ${res.status}`;

        props.onStatus?.(String(errText || ""));
        return;
      }

      const j: any = ct.includes("application/json")
        ? await res.json().catch(() => null)
        : null;

      if (j?.ok === true && j?.format === "png" && typeof j?.data === "string" && j.data.trim()) {
        const md = makeMarkdownImageFromBase64Png(j.data);
        if (md) {
          props.onStatus?.(md);
          props.clearPrompt?.();
          return;
        }
      }

      if (typeof j?.imageUrl === "string" && j.imageUrl.trim()) {
        const md = makeMarkdownImageFromAnyUrl(j.imageUrl);
        if (md) {
          props.onStatus?.(md);
          props.clearPrompt?.();
          return;
        }
      }

      if (typeof j?.markdown === "string" && j.markdown.trim()) {
        props.onStatus?.(j.markdown);
        props.clearPrompt?.();
        return;
      }

      if (typeof j?.image_url === "string" && j.image_url.trim()) {
        const md = makeMarkdownImageFromAnyUrl(j.image_url);
        if (md) {
          props.onStatus?.(md);
          props.clearPrompt?.();
          return;
        }
      }

      if (typeof j?.url === "string" && j.url.trim()) {
        const md = makeMarkdownImageFromAnyUrl(j.url);
        if (md) {
          props.onStatus?.(md);
          props.clearPrompt?.();
          return;
        }
      }

      if (typeof j?.text === "string" && j.text.trim()) {
        props.onStatus?.(j.text);
        props.clearPrompt?.();
        return;
      }

      props.onStatus?.(
        locale === "fi"
          ? "Kuva käsiteltiin, mutta palvelin ei palauttanut kuvaa."
          : locale === "es"
            ? "La imagen se procesó, pero el servidor no devolvió ninguna imagen."
            : "Image processed, but the server did not return an image."
      );

      props.clearPrompt?.();
    } catch (e: any) {
      props.onStatus?.(
        String(
          e?.message ||
            (locale === "fi"
              ? "Virhe kuvan luonnissa."
              : locale === "es"
                ? "Error al crear la imagen."
                : "Error creating image.")
        )
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={props.disabled || busy}
      title={a11yLabel}
      aria-label={a11yLabel}
      style={{
        borderRadius: 12,
        padding: "10px 12px",
        fontSize: 16,
        fontWeight: 900,
        cursor: props.disabled || busy ? "not-allowed" : "pointer",
        border: "1px solid rgba(0,0,0,0.14)",
        background: "rgba(0,0,0,0.04)",
        color: "#111",
        opacity: props.disabled || busy ? 0.6 : 1,
        lineHeight: 1,
      }}
    >
      ✨
    </button>
  );
}