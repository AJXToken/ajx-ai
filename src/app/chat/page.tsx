"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import styles from "./chat2030.module.css";
import ImageButton from "./ImageButton";
import {
  ChatMsg,
  ChatThread,
  createThread,
  deleteThread,
  getActiveThreadId,
  loadThreads,
  saveThreads,
  setActiveThreadId,
  upsertThread,
  updateAutoTitle,
  setCustomTitle,
} from "./chatStore";
import type { Plan, Limits, Usage } from "./imageClient";

import { t, type Locale } from "../../lib/i18n";

type StatsResp = {
  ok: boolean;
  plan: Plan;
  limits: Limits;
  usage: Usage;
  error?: string;
};

type ChatOkJson = {
  ok: true;
  plan: Plan;
  limits: Limits;
  usage: Usage;
  text: string;
};

type ChatErrJson = {
  ok: false;
  error: string;
  plan?: Plan;
  limits?: Limits;
  usage?: Usage;
  upsell?: { message?: string };
};

const LOCALE_STORAGE_KEY = "ajx_locale_v1";

// ===== image payload safety =====
const MAX_IMAGE_DIMENSION = 1024;
const INITIAL_JPEG_QUALITY = 0.75;
const MIN_JPEG_QUALITY = 0.45;
const TARGET_IMAGE_BYTES = 900_000;
const HARD_MAX_IMAGE_BYTES = 1_200_000;
const MAX_NON_IMAGE_FILE_BYTES = 8_000_000;

// ====== Canonical plans (UI) ======
type CanonicalPlan = "free" | "basic" | "plus" | "pro" | "company";
const FREE_DISPLAY_LIMIT = 10;

type ImageIntentChoice = "analyze" | "edit" | null;

type QuickAction = {
  id: string;
  label: string;
  prompt: string;
  mode: AjxMode;
};

type ExtractedCopyBox = {
  mainText: string;
  copyText: string;
  label: string;
} | null;

function clampLocale(v: string | null): Locale | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s === "fi" || s === "en" || s === "es") return s as Locale;
  return null;
}

function detectBrowserLocale(): Locale {
  try {
    const langs = (
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || "fi"]
    )
      .filter(Boolean)
      .map((x) => String(x).toLowerCase())
      .join(",");

    if (langs.includes("es")) return "es";
    if (langs.includes("en")) return "en";
    return "fi";
  } catch {
    return "fi";
  }
}

function clampPlan(v: string | null): Plan | null {
  if (!v) return null;
  const s = v.toLowerCase();
  const allowed = ["free", "basic", "plus", "pro", "company", "visual", "lite", "partner"];
  if (allowed.includes(s)) return s as any;
  return null;
}

function nowTs() {
  return Date.now();
}

type TitleMode = ChatThread["titleMode"];
function normalizeTitleMode(v: any): TitleMode {
  if (v === "auto" || v === "manual" || v === "custom") return v as TitleMode;
  return undefined as TitleMode;
}

function extractMarkdownImageUrls(text: string): string[] {
  if (!text) return [];
  const re = /!\[[^\]]*\]\(\s*([^)]+)\s*\)/g;

  const urls: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const url = (m[1] || "").trim();
    if (!url) continue;
    if (url.includes("AJX_IMAGE_REMOVED")) continue;
    urls.push(url);
  }

  return Array.from(new Set(urls));
}

function stripMarkdownImages(text: string): string {
  if (!text) return "";
  const re = /!\[[^\]]*\]\(\s*([^)]+)\s*\)/g;
  return text.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
}

function renderImagesFromContent(text: string) {
  const urls = extractMarkdownImageUrls(text);
  if (urls.length === 0) return null;

  return (
    <div className="ajxInlineImages">
      {urls.map((u, i) => (
        <a
          key={`${u}-${i}`}
          href={u}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "block", maxWidth: "100%" }}
        >
          <img src={u} alt="AJX Image" className={styles.inlineImage} />
        </a>
      ))}
    </div>
  );
}

function renderInlineFormatting(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*.*?\*\*)/g).filter(Boolean);

  return parts.map((part, idx) => {
    const isBold = part.startsWith("**") && part.endsWith("**") && part.length >= 4;
    if (isBold) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function isBulletLine(line: string) {
  return /^(\-|\*|â€¢)\s+/.test(line.trim());
}

function isOrderedLine(line: string) {
  const s = line.trim();
  if (!s) return false;
  if (!/^\d+[\.\)]\s+/.test(s)) return false;

  const withoutMarker = s.replace(/^\d+[\.\)]\s+/, "").trim();
  if (/[?ï¼Ÿ]$/.test(withoutMarker)) return false;

  return true;
}

function isDividerLine(line: string) {
  return /^(-{3,}|â€”\s*â€”\s*â€”)$/.test(line.trim());
}

function isMarkdownHeadingLine(line: string) {
  return /^#{1,6}\s+/.test(line.trim());
}

function isBoldHeadingLine(line: string) {
  const s = line.trim();
  if (!/^\*\*[^*\n]+\*\*:?$/.test(s)) return false;

  const inner = s.replace(/^\*\*/, "").replace(/\*\*:?\s*$/, "").trim();
  if (!inner) return false;
  if (inner.length > 60) return false;
  if (/[.!?]/.test(inner)) return false;
  if (isBulletLine(inner) || isOrderedLine(inner)) return false;

  return true;
}

function isBlankLine(line: string | undefined) {
  return !String(line || "").trim();
}

function isStructuralLine(line: string | undefined) {
  const s = String(line || "").trim();
  if (!s) return false;
  return (
    isDividerLine(s) ||
    isBulletLine(s) ||
    isOrderedLine(s) ||
    isMarkdownHeadingLine(s) ||
    isBoldHeadingLine(s)
  );
}

function isPlainTextLine(line: string | undefined) {
  const s = String(line || "").trim();
  if (!s) return false;
  return !isStructuralLine(s);
}

function isQuestionLine(line: string | undefined) {
  const s = String(line || "").trim();
  if (!s) return false;
  if (isStructuralLine(s)) return false;
  if (s.length > 220) return false;
  return /[?ï¼Ÿ]$/.test(s);
}

function normalizeDetachedOrderedMarkers(text: string): string {
  if (!text) return "";

  return text
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\s+(\d+[\.\)])\s*\n+/g, "$1\n$2 ")
    .replace(/\n\s*(\d+[\.\)])\s*\n+/g, "\n$1 ")
    .replace(/([^\n])\s+(\d+[\.\)]\s+[A-ZÅÄÖa-zåäö¿¡])/g, "$1\n$2");
}

function normalizeInlineListSequences(text: string): string {
  if (!text) return "";

  return normalizeDetachedOrderedMarkers(text)
    .replace(/([^\n])\s+(â€¢\s)/g, "$1\n$2")
    .replace(/([^\n])\s+(\-\s)/g, "$1\n$2")
    .replace(/([^\n])\s+(\*\s)/g, "$1\n$2");
}

function normalizePlainTextBreaks(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const current = lines[i] ?? "";

    if (!isBlankLine(current)) {
      out.push(current);
      i += 1;
      continue;
    }

    let j = i;
    while (j < lines.length && isBlankLine(lines[j])) {
      j += 1;
    }

    const blankCount = j - i;
    const prev = out.length > 0 ? out[out.length - 1] : "";
    const next = j < lines.length ? lines[j] : "";

    const prevPlain = isPlainTextLine(prev);
    const nextPlain = isPlainTextLine(next);
    const prevQuestion = isQuestionLine(prev);
    const nextQuestion = isQuestionLine(next);

    if (blankCount === 1 && prevPlain && nextPlain && !prevQuestion && !nextQuestion) {
      i = j;
      continue;
    }

    out.push("");
    i = j;
  }

  return out;
}

function isHeadingLine(line: string, prevRaw?: string, nextRaw?: string) {
  const s = line.trim();
  if (!s) return false;

  if (isMarkdownHeadingLine(s)) return true;

  if (!isBoldHeadingLine(s)) return false;

  const prevBlank = isBlankLine(prevRaw);
  const nextBlank = isBlankLine(nextRaw);
  const nextStructural = isStructuralLine(nextRaw);

  return prevBlank && (nextBlank || nextStructural);
}

function cleanBulletText(line: string) {
  return line.trim().replace(/^(\-|\*|â€¢)\s+/, "");
}

function cleanOrderedText(line: string) {
  return line.trim().replace(/^\d+[\.\)]\s+/, "");
}

function cleanHeadingText(line: string) {
  const s = line.trim();

  if (isMarkdownHeadingLine(s)) {
    return s.replace(/^#{1,6}\s+/, "").trim();
  }

  if (isBoldHeadingLine(s)) {
    return s.replace(/^\*\*/, "").replace(/\*\*:?\s*$/, "").trim();
  }

  return s.trim();
}

function isSummaryHeadingLine(line: string, locale: Locale) {
  const cleaned = cleanHeadingText(line).toLowerCase();

  if (locale === "fi") {
    return cleaned === "yhteenveto" || cleaned === "tiivistelmÃ¤" || cleaned === "lyhyesti";
  }

  if (locale === "es") {
    return cleaned === "resumen" || cleaned === "en resumen" || cleaned === "brevemente";
  }

  return cleaned === "summary" || cleaned === "in short" || cleaned === "briefly";
}

function isSummaryLine(line: string, locale: Locale) {
  const s = line.trim().toLowerCase();

  if (locale === "fi") {
    return (
      s.startsWith("yhteenveto:") ||
      s.startsWith("tiivistelmÃ¤:") ||
      s.startsWith("lyhyesti:")
    );
  }

  if (locale === "es") {
    return (
      s.startsWith("resumen:") ||
      s.startsWith("en resumen:") ||
      s.startsWith("brevemente:")
    );
  }

  return s.startsWith("summary:") || s.startsWith("in short:") || s.startsWith("briefly:");
}

type RichSegment =
  | { type: "text"; value: string }
  | { type: "code"; language: string; code: string };

function parseCodeBlocks(text: string): RichSegment[] {
  const source = String(text || "");
  if (!source) return [{ type: "text", value: "" }];

  const re = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  const parts: RichSegment[] = [];

  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(source)) !== null) {
    const full = m[0];
    const lang = (m[1] || "").trim();
    const code = (m[2] || "").replace(/\n$/, "");

    const start = m.index;
    if (start > lastIndex) {
      parts.push({
        type: "text",
        value: source.slice(lastIndex, start),
      });
    }

    parts.push({
      type: "code",
      language: lang,
      code,
    });

    lastIndex = start + full.length;
  }

  if (lastIndex < source.length) {
    parts.push({
      type: "text",
      value: source.slice(lastIndex),
    });
  }

  if (parts.length === 0) {
    return [{ type: "text", value: source }];
  }

  return parts;
}

function copyLabel(locale: Locale, copied: boolean) {
  if (copied) {
    if (locale === "es") return "Copiado";
    if (locale === "en") return "Copied";
    return "Kopioitu";
  }

  if (locale === "es") return "Copiar";
  if (locale === "en") return "Copy";
  return "Kopioi";
}

function outputBoxLabel(locale: Locale) {
  if (locale === "es") return "Texto listo";
  if (locale === "en") return "Ready text";
  return "Valmis teksti";
}

function normalizeOutputBoxLabel(raw: string, locale: Locale) {
  const s = raw.trim().replace(/\*+/g, "").replace(/:+$/, "").trim().toLowerCase();

  if (!s) return outputBoxLabel(locale);

  if (locale === "fi") {
    if (s.includes("kÃ¤Ã¤nnÃ¶s")) return "KÃ¤Ã¤nnÃ¶s";
    if (s.includes("sÃ¤hkÃ¶postipohja")) return "SÃ¤hkÃ¶posti";
    if (s.includes("sÃ¤hkÃ¶posti")) return "SÃ¤hkÃ¶posti";
    if (s.includes("viestipohja")) return "Viesti";
    if (s.includes("viesti")) return "Viesti";
    if (s.includes("tarjouspohja")) return "Tarjous";
    if (s.includes("tarjous")) return "Tarjous";
    if (s.includes("mainosteksti")) return "Mainosteksti";
    if (s.includes("caption")) return "Caption";
    if (s.includes("valmis")) return "Valmis teksti";
    return raw.trim().replace(/:+$/, "");
  }

  if (locale === "es") {
    if (s.includes("traducciÃ³n")) return "TraducciÃ³n";
    if (s.includes("plantilla de correo")) return "Correo";
    if (s.includes("correo")) return "Correo";
    if (s.includes("plantilla de mensaje")) return "Mensaje";
    if (s.includes("mensaje")) return "Mensaje";
    if (s.includes("plantilla de oferta")) return "Oferta";
    if (s.includes("oferta")) return "Oferta";
    if (s.includes("texto publicitario")) return "Texto publicitario";
    if (s.includes("caption")) return "Caption";
    if (s.includes("texto final")) return "Texto final";
    return raw.trim().replace(/:+$/, "");
  }

  if (s.includes("translation")) return "Translation";
  if (s.includes("email template")) return "Email";
  if (s.includes("email")) return "Email";
  if (s.includes("message template")) return "Message";
  if (s.includes("message")) return "Message";
  if (s.includes("offer template")) return "Offer";
  if (s.includes("offer")) return "Offer";
  if (s.includes("ad copy")) return "Ad copy";
  if (s.includes("caption")) return "Caption";
  if (s.includes("final text")) return "Final text";
  return raw.trim().replace(/:+$/, "");
}

function normalizeCopyBoxSource(text: string) {
  return stripMarkdownImages(text || "").replace(/\r\n/g, "\n").trim();
}

function cleanCopyLabelLine(line: string) {
  return line
    .trim()
    .replace(/^\*+/, "")
    .replace(/\*+$/, "")
    .replace(/^[_`>#\-\sâ€¢]+/, "")
    .trim();
}

function isSummaryLikeLabel(line: string, locale: Locale) {
  const cleaned = cleanCopyLabelLine(line).toLowerCase().replace(/:+$/, "").trim();

  if (locale === "fi") {
    return cleaned === "yhteenveto" || cleaned === "tiivistelmÃ¤" || cleaned === "lyhyesti";
  }

  if (locale === "es") {
    return cleaned === "resumen" || cleaned === "en resumen" || cleaned === "brevemente";
  }

  return cleaned === "summary" || cleaned === "in short" || cleaned === "briefly";
}

function getExplicitCopyLabelMatch(line: string): string | null {
  const cleaned = cleanCopyLabelLine(line).toLowerCase();

  const labels = [
    "kÃ¤Ã¤nnÃ¶s",
    "tÃ¤ssÃ¤ kÃ¤Ã¤nnÃ¶s",
    "translation",
    "here is the translation",
    "traducciÃ³n",
    "aquÃ­ tienes la traducciÃ³n",
    "valmis teksti",
    "final text",
    "texto final",
    "sÃ¤hkÃ¶posti",
    "sÃ¤hkÃ¶postipohja",
    "valmis sÃ¤hkÃ¶posti",
    "valmis sÃ¤hkÃ¶postipohja",
    "email",
    "email template",
    "ready email",
    "correo",
    "plantilla de correo",
    "viesti",
    "viestipohja",
    "valmis viesti",
    "valmis viestipohja",
    "message",
    "message template",
    "mensaje",
    "plantilla de mensaje",
    "tarjous",
    "tarjouspohja",
    "valmis tarjous",
    "valmis tarjouspohja",
    "offer",
    "offer template",
    "oferta",
    "plantilla de oferta",
    "mainosteksti",
    "ad copy",
    "texto publicitario",
    "caption",
    "copy-paste",
    "copy paste",
    "kopioi tÃ¤stÃ¤",
    "copy from here",
    "copia desde aquÃ­",
  ];

  for (const label of labels) {
    if (
      cleaned === label ||
      cleaned === `${label}:` ||
      cleaned.startsWith(`${label}: `) ||
      cleaned === `${label} -` ||
      cleaned.startsWith(`${label} - `)
    ) {
      return label;
    }
  }

  for (const label of labels) {
    const idx = cleaned.indexOf(label);
    if (idx === -1) continue;

    const hasColonAfter = cleaned.indexOf(":", idx + label.length) !== -1;
    const hasDashAfter = cleaned.indexOf(" - ", idx + label.length) !== -1;

    if (hasColonAfter || hasDashAfter) {
      return label;
    }
  }

  return null;
}

function extractBodyFromMatchedLabelLine(line: string): string {
  const cleaned = cleanCopyLabelLine(line);

  const colonIndex = cleaned.lastIndexOf(":");
  if (colonIndex >= 0 && colonIndex < cleaned.length - 1) {
    return cleaned.slice(colonIndex + 1).trim();
  }

  const dashIndex = cleaned.lastIndexOf(" - ");
  if (dashIndex >= 0 && dashIndex < cleaned.length - 3) {
    return cleaned.slice(dashIndex + 3).trim();
  }

  return "";
}

function extractCopyBox(text: string, locale: Locale): ExtractedCopyBox {
  return null;
}

function renderPlainRichText(text: string, locale: Locale) {
  const content = stripMarkdownImages(text || "");
  if (!content) return null;

  const normalized = normalizeInlineListSequences(
    content.replace(/\r\n/g, "\n").replace(/\n?---\n?/g, "\nâ€” â€” â€”\n")
  );

  const rawLines = normalizePlainTextBreaks(normalized.split("\n"));
  const out: React.ReactNode[] = [];

  let paragraphBuffer: string[] = [];

  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;

    const paragraphText = paragraphBuffer
      .map((x) => x.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    paragraphBuffer = [];

    if (!paragraphText) return;

    out.push(
      <p
        key={`p-${out.length}`}
        className="ajxParagraph"
        style={{
          margin: "0 0 18px 0",
          lineHeight: 1.72,
          maxWidth: "100%",
          minWidth: 0,
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {renderInlineFormatting(paragraphText)}
      </p>
    );
  }

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    const line = raw.trim();
    const prevRaw = i > 0 ? rawLines[i - 1] : "";
    const nextRaw = i + 1 < rawLines.length ? rawLines[i + 1] : "";

    if (!line) {
      flushParagraph();
      continue;
    }

    if (isDividerLine(line)) {
      flushParagraph();
      out.push(
        <div
          key={`divider-${i}`}
          className="ajxDivider"
          style={{
            height: 1,
            margin: "12px 0 16px 0",
            background: "rgba(11, 13, 18, 0.08)",
            borderRadius: 999,
          }}
        />
      );
      continue;
    }

    if (isSummaryLine(line, locale)) {
      flushParagraph();
      out.push(
        <div
          key={`summary-inline-${i}`}
          className="ajxSummaryBox"
          style={{
            margin: "4px 0 16px 0",
            padding: "10px 12px",
            borderRadius: 14,
            border: "1px solid rgba(11, 13, 18, 0.08)",
            background: "rgba(11, 13, 18, 0.04)",
          }}
        >
          <div
            className="ajxSummaryTitle"
            style={{
              fontSize: 11,
              fontWeight: 950,
              letterSpacing: "0.2px",
              textTransform: "uppercase",
              opacity: 0.72,
              marginBottom: 4,
            }}
          >
            {locale === "fi" ? "Yhteenveto" : locale === "es" ? "Resumen" : "Summary"}
          </div>
          <div
            className="ajxSummaryText"
            style={{
              lineHeight: 1.55,
              fontWeight: 700,
              maxWidth: "100%",
              minWidth: 0,
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            {renderInlineFormatting(line.replace(/^[^:]+:\s*/, ""))}
          </div>
        </div>
      );
      continue;
    }

    if (isHeadingLine(line, prevRaw, nextRaw)) {
      flushParagraph();

      if (isSummaryHeadingLine(line, locale)) {
        out.push(
          <div
            key={`summary-heading-${i}`}
            className="ajxSummaryBox"
            style={{
              margin: "4px 0 16px 0",
              padding: "10px 12px",
              borderRadius: 14,
              border: "1px solid rgba(11, 13, 18, 0.08)",
              background: "rgba(11, 13, 18, 0.04)",
            }}
          >
            <div
              className="ajxSummaryTitle"
              style={{
                fontSize: 11,
                fontWeight: 950,
                letterSpacing: "0.2px",
                textTransform: "uppercase",
                opacity: 0.72,
                marginBottom: 4,
              }}
            >
              {locale === "fi" ? "Yhteenveto" : locale === "es" ? "Resumen" : "Summary"}
            </div>
          </div>
        );
      } else {
        out.push(
          <div
            key={`heading-${i}`}
            className="ajxHeadingBlock"
            style={{
              margin: "18px 0 12px 0",
              fontSize: 15,
              fontWeight: 950,
              lineHeight: 1.35,
              maxWidth: "100%",
              minWidth: 0,
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            {renderInlineFormatting(cleanHeadingText(line))}
          </div>
        );
      }
      continue;
    }

    if (isBulletLine(line)) {
      flushParagraph();

      const items: string[] = [];
      let j = i;

      while (j < rawLines.length && isBulletLine(rawLines[j].trim())) {
        items.push(cleanBulletText(rawLines[j].trim()));
        j += 1;
      }

      out.push(
        <ul
          key={`ul-${i}`}
          className="ajxRichList"
          style={{
            margin: "0 0 16px 0",
            paddingLeft: 20,
            lineHeight: 1.68,
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          {items.map((item, idx) => (
            <li
              key={idx}
              style={{
                margin: "0 0 6px 0",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }}
            >
              {renderInlineFormatting(item)}
            </li>
          ))}
        </ul>
      );

      i = j - 1;
      continue;
    }

    if (isOrderedLine(line)) {
      flushParagraph();

      const items: string[] = [];
      let j = i;

      while (j < rawLines.length && isOrderedLine(rawLines[j].trim())) {
        items.push(cleanOrderedText(rawLines[j].trim()));
        j += 1;
      }

      out.push(
        <ol
          key={`ol-${i}`}
          className="ajxRichListOrdered"
          style={{
            margin: "0 0 16px 0",
            paddingLeft: 20,
            lineHeight: 1.68,
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          {items.map((item, idx) => (
            <li
              key={idx}
              style={{
                margin: "0 0 6px 0",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }}
            >
              {renderInlineFormatting(item)}
            </li>
          ))}
        </ol>
      );

      i = j - 1;
      continue;
    }

    if (isQuestionLine(line)) {
      flushParagraph();

      const items: string[] = [];
      let j = i;

      while (j < rawLines.length) {
        const candidate = rawLines[j]?.trim() ?? "";
        if (!candidate || !isQuestionLine(candidate)) break;
        items.push(candidate.replace(/^\d+[\.\)]\s+/, "").trim());
        j += 1;
      }

      if (items.length >= 2) {
        out.push(
          <div
            key={`questions-${i}`}
            className="ajxQuestionList"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              margin: "0 0 16px 0",
              maxWidth: "100%",
              minWidth: 0,
            }}
          >
            {items.map((item, idx) => (
              <div
                key={idx}
                className="ajxQuestionRow"
                style={{
                  lineHeight: 1.68,
                  fontWeight: 700,
                  maxWidth: "100%",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                }}
              >
                {renderInlineFormatting(item)}
              </div>
            ))}
          </div>
        );

        i = j - 1;
        continue;
      }
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();

  return (
    <div
      className={styles.bubbleText}
      style={{
        minWidth: 0,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
    >
      {out}
    </div>
  );
}

function RichMessage({
  text,
  locale,
}: {
  text: string;
  locale: Locale;
}) {
  const content = stripMarkdownImages(text || "");
  if (!content) return null;

  const segments = parseCodeBlocks(content);

  return (
    <div
      className={styles.bubbleText}
      style={{
        minWidth: 0,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
    >
      {segments.map((segment, idx) => {
        if (segment.type === "text") {
          const extracted = extractCopyBox(segment.value, locale);
          const mainText = extracted?.mainText ?? segment.value;
          const rendered = renderPlainRichText(mainText, locale);

          return (
            <React.Fragment key={`seg-text-${idx}`}>
              {rendered}
              {extracted ? (
                <div className="ajxOutputBox">
                  <div className="ajxOutputTop">
                    <span className="ajxOutputTitle">{extracted.label}</span>
                  </div>
                  <div className="ajxOutputBody">{extracted.copyText}</div>
                </div>
              ) : null}
            </React.Fragment>
          );
        }

        const langLabel = segment.language || "code";

        return (
          <div key={`seg-code-${idx}`} className="ajxCodeBlockWrap">
            <div className="ajxCodeToolbar">
              <span className="ajxCodeLang">{langLabel}</span>
            </div>
            <pre className="ajxCodePre">
              <code>{segment.code}</code>
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function detectImageIntent(text: string): ImageIntentChoice {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return null;

  const editPatterns = [
    /\bpoista tausta\b/,
    /\bota tausta pois\b/,
    /\bmuokkaa\b/,
    /\beditoi\b/,
    /\bparanna\b/,
    /\btee tÃ¤stÃ¤\b/,
    /\bvaihda\b/,
    /\blisÃ¤Ã¤\b/,
    /\bpoista\b/,
    /\brajaa\b/,
    /\btausta\b/,
    /\bmustavalko/i,
    /\bblurraa\b/,
    /\bsumenna\b/,
    /\bretusoi\b/,
    /\bsiivoa\b/,
    /\btee mainos/i,
    /\bremove background\b/,
    /\bremove the background\b/,
    /\bedit\b/,
    /\bmodify\b/,
    /\bchange\b/,
    /\breplace\b/,
    /\badd\b/,
    /\bremove\b/,
    /\bcrop\b/,
    /\benhance\b/,
    /\bmake it\b/,
    /\bblack and white\b/,
    /\bbackground\b/,
    /\bquita el fondo\b/,
    /\belimina el fondo\b/,
    /\bedita\b/,
    /\bmodifica\b/,
    /\bcambia\b/,
    /\bagrega\b/,
    /\baÃ±ade\b/,
    /\bquita\b/,
    /\brecorta\b/,
    /\bmejora\b/,
    /\ben blanco y negro\b/,
  ];

  const analyzePatterns = [
    /\bmitÃ¤ kuvassa\b/,
    /\bmitÃ¤ tÃ¤ssÃ¤\b/,
    /\bmitÃ¤ nÃ¤et\b/,
    /\banalysoi\b/,
    /\barvioi\b/,
    /\btunnista\b/,
    /\bmikÃ¤ auto\b/,
    /\bmikÃ¤ tÃ¤mÃ¤ on\b/,
    /\bkerro kuvasta\b/,
    /\bkuvaile\b/,
    /\bonko tÃ¤mÃ¤\b/,
    /\bwhat is in the image\b/,
    /\bwhat's in the image\b/,
    /\bwhat do you see\b/,
    /\banalyze\b/,
    /\banalyse\b/,
    /\bdescribe\b/,
    /\bidentify\b/,
    /\bwhat car\b/,
    /\bis this\b/,
    /\bque hay en la imagen\b/,
    /\bquÃ© hay en la imagen\b/,
    /\bquÃ© ves\b/,
    /\bque ves\b/,
    /\banaliza\b/,
    /\bdescribe\b/,
    /\bidentifica\b/,
    /\bquÃ© coche\b/,
    /\bque coche\b/,
    /\bes esto\b/,
  ];

  const editMatch = editPatterns.some((re) => re.test(s));
  const analyzeMatch = analyzePatterns.some((re) => re.test(s));

  if (editMatch && !analyzeMatch) return "edit";
  if (analyzeMatch && !editMatch) return "analyze";
  return null;
}

// ====== AJX Agents (Mode) ======
type AjxMode = "general" | "research" | "ideation" | "analysis" | "strategy";
const MODE_KEY = "ajx_mode_v2";

function loadMode(key: string, fallback: AjxMode): AjxMode {
  try {
    const v2 = (localStorage.getItem(key) || "").toLowerCase().trim();
    const all2: AjxMode[] = ["general", "research", "ideation", "analysis", "strategy"];
    if (all2.includes(v2 as AjxMode)) return v2 as AjxMode;

    const v1 = (localStorage.getItem("ajx_mode_v1") || "").toLowerCase().trim();
    if (v1 === "quick") return "research";
    if (v1 === "ideas") return "ideation";
    if (v1 === "analysis") return "analysis";
    if (v1 === "strategy") return "strategy";
    if (v1 === "general") return "general";

    return fallback;
  } catch {
    return fallback;
  }
}

function modesForCanonicalPlan(cp: CanonicalPlan): AjxMode[] {
  const base: AjxMode[] = ["general"];
  if (cp === "free") return base;
  if (cp === "basic") return [...base, "research"];
  if (cp === "plus") return [...base, "research", "ideation"];
  if (cp === "pro") return [...base, "research", "ideation", "analysis"];
  if (cp === "company") return [...base, "research", "ideation", "analysis", "strategy"];
  return base;
}

type RoleId = AjxMode;
function modeToRole(mode: AjxMode): RoleId {
  return mode;
}

function modeLabel(mode: AjxMode, locale: Locale): string {
  if (mode === "general") return t(locale, "mode.general");
  if (mode === "research") return t(locale, "mode.research");
  if (mode === "ideation") return t(locale, "mode.ideation");
  if (mode === "analysis") return t(locale, "mode.analysis");
  return t(locale, "mode.strategy");
}

// ====== Plan normalization / legacy mapping ======
function toCanonicalPlan(p: Plan | null | undefined): CanonicalPlan {
  const s = String(p || "").toLowerCase().trim();

  if (s === "company") return "company";
  if (s === "pro") return "pro";
  if (s === "plus") return "plus";
  if (s === "basic") return "basic";
  if (s === "free") return "free";

  if (s === "visual") return "basic";
  if (s === "lite") return "basic";
  if (s === "partner") return "company";

  return "free";
}

function canonicalToHeaderPlan(cp: CanonicalPlan): Plan {
  if (cp === "company") return "company" as any;
  if (cp === "pro") return "pro" as any;
  if (cp === "plus") return "plus" as any;
  if (cp === "basic") return "basic" as any;
  return "free" as any;
}

function planLabelLocalized(cp: CanonicalPlan) {
  if (cp === "company") return "COMPANY";
  if (cp === "pro") return "PRO";
  if (cp === "plus") return "PLUS";
  if (cp === "basic") return "BASIC";
  return "FREE";
}

function defaultLimitsForCanonicalPlan(cp: CanonicalPlan): Limits {
  if (cp === "basic") return { msgPerMonth: 1000, imgPerMonth: 150, webPerMonth: 0 };
  if (cp === "plus") return { msgPerMonth: 1000, imgPerMonth: 120, webPerMonth: 0 };
  if (cp === "pro") return { msgPerMonth: 3000, imgPerMonth: 200, webPerMonth: 200 };
  if (cp === "company") return { msgPerMonth: 4000, imgPerMonth: 150, webPerMonth: 300 };
  return { msgPerMonth: FREE_DISPLAY_LIMIT, imgPerMonth: 0, webPerMonth: 0 };
}

function composerPlaceholder(locale: Locale): string {
  if (locale === "es") return "Escribe…";
  if (locale === "en") return "Write…";
  return "Kirjoita…";
}

function chatsToggleLabel(locale: Locale): string {
  if (locale === "es") return "Conversaciones";
  if (locale === "en") return "Chats";
  return "Keskustelut";
}

function quickActionsForLocale(locale: Locale): QuickAction[] {
  if (locale === "es") {
    return [
      { id: "offer", label: "Crear oferta", prompt: "Ay\u00fadame a crear una oferta clara y convincente para un cliente.", mode: "research" },
      { id: "funding", label: "Buscar ayudas y financiaci\u00f3n", prompt: "Ay\u00fadame a encontrar financiaci\u00f3n para mi empresa: subvenciones, ayudas p\u00fablicas, fondos europeos, programas locales, inversores, pr\u00e9stamos empresariales y otros canales realistas. Primero haz preguntas concretas.", mode: "research" },
      { id: "ad", label: "Crear anuncio", prompt: "Ay\u00fadame a crear un anuncio claro y convincente para mi producto o servicio.", mode: "ideation" },
      { id: "sales", label: "Aumentar ventas", prompt: "Ay\u00fadame a encontrar formas pr\u00e1cticas de aumentar mis ventas con acciones concretas.", mode: "analysis" },
      { id: "customers", label: "Conseguir clientes", prompt: "Ay\u00fadame a encontrar clientes nuevos y crear un plan pr\u00e1ctico para contactarlos.", mode: "research" },
      { id: "pricing", label: "Mejorar precios", prompt: "Analiza mi pricing y ay\u00fadame a mejorarlo.", mode: "analysis" },
      { id: "problem", label: "Resolver problema", prompt: "Ay\u00fadame a resolver un problema de negocio paso a paso.", mode: "analysis" },
    ];
  }

  if (locale === "en") {
    return [
      { id: "offer", label: "Create offer", prompt: "Help me create a clear and convincing offer for a client.", mode: "research" },
      { id: "funding", label: "Find grants & funding", prompt: "Help me find funding for my business: EU grants, public subsidies, local programs, investors, business loans and other realistic funding channels. First ask concrete questions.", mode: "research" },
      { id: "ad", label: "Create ad", prompt: "Help me create a clear and convincing ad for my product or service.", mode: "ideation" },
      { id: "sales", label: "Grow sales", prompt: "Help me find practical ways to grow my sales with concrete actions.", mode: "analysis" },
      { id: "customers", label: "Get customers", prompt: "Help me find new customers and create a practical outreach plan.", mode: "research" },
      { id: "pricing", label: "Improve pricing", prompt: "Analyze my pricing and help me improve it.", mode: "analysis" },
      { id: "problem", label: "Solve problem", prompt: "Help me solve a business problem step by step.", mode: "analysis" },
    ];
  }

  return [
    { id: "offer", label: "Luo tarjous", prompt: "Auta minua luomaan selke\u00e4 ja myyv\u00e4 tarjous asiakkaalle.", mode: "research" },
    { id: "funding", label: "Hanki tukia ja rahoitusta", prompt: "Auta minua l\u00f6yt\u00e4m\u00e4\u00e4n yritykselleni rahoitusta: EU-tukia, julkisia avustuksia, paikallisia tukiohjelmia, sijoittajia, yrityslainoja ja muita realistisia rahoituskanavia. Kysy ensin konkreettiset taustakysymykset.", mode: "research" },
    { id: "ad", label: "Luo mainos", prompt: "Auta minua luomaan selke\u00e4 ja myyv\u00e4 mainos tuotteelleni tai palvelulleni.", mode: "ideation" },
    { id: "sales", label: "Kasvata myynti\u00e4", prompt: "Auta minua l\u00f6yt\u00e4m\u00e4\u00e4n konkreettisia tapoja kasvattaa myynti\u00e4.", mode: "analysis" },
    { id: "customers", label: "Hanki asiakkaita", prompt: "Auta minua l\u00f6yt\u00e4m\u00e4\u00e4n uusia asiakkaita ja tee k\u00e4yt\u00e4nn\u00f6n suunnitelma, miten heit\u00e4 l\u00e4hestyt\u00e4\u00e4n.", mode: "research" },
    { id: "pricing", label: "Paranna hinnoittelua", prompt: "Analysoi nykyinen hinnoitteluni ja auta parantamaan sit\u00e4.", mode: "analysis" },
    { id: "problem", label: "Ratkaise yritysongelma", prompt: "Auta minua ratkaisemaan yritysongelma askel askeleelta.", mode: "analysis" },
  ];
}
function quickActionQuestionInstruction(action: QuickAction, locale: Locale): string {
  if (locale === "es") {
    return [
      `MODO_PIKATOIMINTO: ${action.id}`,
      "No des una respuesta larga ni un plan final todavÃ­a.",
      "Haz primero exactamente 3â€“5 preguntas cortas y concretas para recopilar la información necesaria.",
      "Presenta solo esas preguntas, cada una en su propia lÃ­nea, sin numeraciÃ³n ni viÃ±etas.",
      "No expliques tu razonamiento.",
      "No aÃ±adas resumen, introducciÃ³n larga ni propuesta final todavÃ­a.",
      "Cuando el usuario responda, entonces crea la oferta, el plan o la soluciÃ³n basÃ¡ndote en sus respuestas.",
    ].join("\n");
  }

  if (locale === "en") {
    return [
      `QUICK_ACTION_MODE: ${action.id}`,
      "Do not give a long answer or a final plan yet.",
      "First ask exactly 3â€“5 short, concrete questions needed to complete the task.",
      "Output only those questions, each on its own line, without numbering or bullet points.",
      "Do not explain your reasoning.",
      "Do not add a summary, long intro, or final proposal yet.",
      "After the user answers, then create the offer, plan, or solution based on those answers.",
    ].join("\n");
  }

  return [
    `PIKATOIMINTO_TILA: ${action.id}`,
    "Ã„lÃ¤ anna vielÃ¤ pitkÃ¤Ã¤ vastausta tai valmista suunnitelmaa.",
    "Kysy ensin tÃ¤smÃ¤lleen 3â€“5 lyhyttÃ¤ ja konkreettista kysymystÃ¤, joilla kerÃ¤Ã¤t tarvittavat tiedot.",
    "Tulosta vain nuo kysymykset, jokainen omalle rivilleen, ilman numerointia tai listamerkkejÃ¤.",
    "Ã„lÃ¤ selitÃ¤ ajatteluasi.",
    "Ã„lÃ¤ lisÃ¤Ã¤ yhteenvetoa, pitkÃ¤Ã¤ johdantoa tai lopullista tarjousta vielÃ¤.",
    "Kun kÃ¤yttÃ¤jÃ¤ vastaa, tee vasta sitten tarjous, suunnitelma tai ratkaisu vastausten perusteella.",
  ].join("\n");
}

function quickActionLockedText(locale: Locale): string {
  if (locale === "es") {
    return "Los accesos rÃ¡pidos estÃ¡n disponibles en Plus. Con Plus, AJX AI te guÃ­a paso a paso para crear ofertas, anuncios, planes de ventas, financiaciÃ³n y soluciones de negocio.";
  }

  if (locale === "en") {
    return "Quick actions are available on Plus. With Plus, AJX AI guides you step by step to create offers, ads, sales plans, funding paths and business solutions.";
  }

  return "Pikatoiminnot kuuluvat Plus-versioon. Plus ohjaa sinut vaihe vaiheelta tarjousten, mainosten, myynnin, rahoituksen ja yritysongelmien ratkaisuun.";
}

// ====== Attachments UI ======
type PendingAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  type: string;
  dataUrl: string;
};

type PlusMenuPos = {
  open: boolean;
  left: number;
  top: number;
  width: number;
};

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return 0;
  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.match(/=+$/)?.[0].length ?? 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("FileReader error"));
    fr.onload = () => resolve(String(fr.result || ""));
    fr.readAsDataURL(blob);
  });
}

function loadImageElementFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Kuvan lukeminen epÃ¤onnistui."));
    };

    img.src = objectUrl;
  });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Kuvan pakkaus epÃ¤onnistui."));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

async function compressImageFile(file: File): Promise<{
  name: string;
  type: string;
  dataUrl: string;
}> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Tiedosto ei ole kuva.");
  }

  if (file.type === "image/svg+xml") {
    if (file.size > HARD_MAX_IMAGE_BYTES) {
      throw new Error("SVG-kuva on liian suuri. KÃ¤ytÃ¤ pienempÃ¤Ã¤ kuvaa.");
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("FileReader error"));
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsDataURL(file);
    });

    return {
      name: file.name,
      type: file.type,
      dataUrl,
    };
  }

  const img = await loadImageElementFromFile(file);

  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;

  if (!width || !height) {
    throw new Error("Kuvan kokoa ei voitu lukea.");
  }

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas ei ole kÃ¤ytettÃ¤vissÃ¤.");
  }

  let currentWidth = width;
  let currentHeight = height;
  let quality = INITIAL_JPEG_QUALITY;
  let bestBlob: Blob | null = null;

  for (let pass = 0; pass < 6; pass += 1) {
    canvas.width = currentWidth;
    canvas.height = currentHeight;

    ctx.clearRect(0, 0, currentWidth, currentHeight);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, currentWidth, currentHeight);
    ctx.drawImage(img, 0, 0, currentWidth, currentHeight);

    quality = INITIAL_JPEG_QUALITY;

    for (let q = 0; q < 4; q += 1) {
      const blob = await canvasToJpegBlob(canvas, quality);

      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }

      if (blob.size <= TARGET_IMAGE_BYTES) {
        const dataUrl = await blobToDataUrl(blob);
        return {
          name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
          type: "image/jpeg",
          dataUrl,
        };
      }

      quality = Math.max(MIN_JPEG_QUALITY, quality - 0.1);
    }

    currentWidth = Math.max(320, Math.round(currentWidth * 0.85));
    currentHeight = Math.max(320, Math.round(currentHeight * 0.85));
  }

  if (!bestBlob) {
    throw new Error("Kuvan pakkaus epÃ¤onnistui.");
  }

  if (bestBlob.size > HARD_MAX_IMAGE_BYTES) {
    throw new Error("Kuva on liian suuri. Valitse pienempi kuva.");
  }

  const dataUrl = await blobToDataUrl(bestBlob);
  return {
    name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
    type: "image/jpeg",
    dataUrl,
  };
}

function imageEditStartedText(locale: Locale): string {
  if (locale === "es") return "Muokataan kuvaaâ€¦";
  if (locale === "en") return "Editing imageâ€¦";
  return "Muokataan kuvaaâ€¦";
}

function imageQueuedText(locale: Locale): string {
  if (locale === "es") return "Kuva lisÃ¤tty. Valitse analysointi tai muokkaus ja lÃ¤hetÃ¤ pyyntÃ¶.";
  if (locale === "en") return "Image attached. Choose analyze or edit, then send your request.";
  return "Kuva lisÃ¤tty. Valitse analyysi tai muokkaus ja lÃ¤hetÃ¤ pyyntÃ¶.";
}
function attachmentHintText(locale: Locale): string {
  if (locale === "es") {
    return "Adjuntos: puedes subir imÃ¡genes, PDF y otros archivos. TamaÃ±o mÃ¡ximo recomendado: 3,5 MB.";
  }
  if (locale === "en") {
    return "Attachments: you can upload images, PDFs, and other files. Recommended maximum size: 3.5 MB.";
  }
  return "Liitteet: voit ladata kuvia, PDF:iÃ¤ ja muita tiedostoja. Suositeltu enimmÃ¤iskoko: 3.5 MB.";
}

function attachFileMenuLabel(locale: Locale): string {
  if (locale === "es") return "Adjuntar archivo (PDF, TXT, CSV...)";
  if (locale === "en") return "Attach file (PDF, TXT, CSV...)";
  return "Liitä tiedosto (PDF, TXT, CSV...)";
}

export default function ChatPage(): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>("fi");

  const titleDefault = useMemo(() => t(locale, "thread.title_default"), [locale]);
  const greeting = useMemo(() => {
    if (locale === "es") return "¿Qué quieres hacer hoy?";
    if (locale === "en") return "What do you want to do today?";
    return "Mitä haluat tehdä tänään?";
  }, [locale]);

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth > 980;
  });

  const [messages, setMessages] = useState<ChatMsg[]>(() => [
    { role: "assistant", content: t("fi", "chat.greeting"), ts: nowTs() },
  ]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [plusOpen, setPlusOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const [plan, setPlan] = useState<Plan>("free");
  const [limits, setLimits] = useState<Limits>({
    msgPerMonth: FREE_DISPLAY_LIMIT,
    imgPerMonth: 0,
    webPerMonth: 0,
  });
  const [usage, setUsage] = useState<Usage>({
    msgThisMonth: 0,
    imgThisMonth: 0,
    webThisMonth: 0,
    extraImgThisMonth: 0,
  });

  const [devPlan, setDevPlan] = useState<Plan | null>(null);
  const didInitRef = useRef(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  const [imageStatus, setImageStatus] = useState<string>("");

  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageButtonWrapRef = useRef<HTMLDivElement | null>(null);

  const [forceWebNext, setForceWebNext] = useState<boolean>(false);

  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const [plusMenuPos, setPlusMenuPos] = useState<PlusMenuPos>({
    open: false,
    left: 0,
    top: 0,
    width: 240,
  });

  const [copiedKey, setCopiedKey] = useState<string>("");
  const [manualImageIntent, setManualImageIntent] = useState<ImageIntentChoice>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return window.innerHeight || 0;
  });
  const [composerHeight, setComposerHeight] = useState<number>(120);

  const effectivePlanRaw: Plan = (devPlan ?? plan) as any;
  const effectiveCanonical: CanonicalPlan = toCanonicalPlan(effectivePlanRaw);

  const effectiveLimits: Limits = useMemo(() => {
    if (devPlan) return defaultLimitsForCanonicalPlan(effectiveCanonical);

    if (effectiveCanonical === "free") {
      return {
        ...limits,
        msgPerMonth:
          Number(limits?.msgPerMonth || 0) > 0 ? limits.msgPerMonth : FREE_DISPLAY_LIMIT,
      };
    }
    return limits;
  }, [devPlan, effectiveCanonical, limits]);

  const canGenerateImages =
    effectiveCanonical === "plus" ||
    effectiveCanonical === "pro" ||
    effectiveCanonical === "company";

  const canAttachImagesForAnalysis = Number(effectiveLimits?.imgPerMonth || 0) > 0;
  const canOpenPlusMenu = effectiveCanonical !== "free";
  const canEditImages =
    effectiveCanonical === "pro" || effectiveCanonical === "company";
  const showImageButton = canGenerateImages;
  const showWebButton = Number(effectiveLimits?.webPerMonth || 0) > 0;

  const allowedModes = useMemo(
    () => modesForCanonicalPlan(effectiveCanonical),
    [effectiveCanonical]
  );
  const [mode, setMode] = useState<AjxMode>("general");

  const firstPendingImage = useMemo(
    () => pending.find((p) => p.kind === "image") || null,
    [pending]
  );

  const hasPendingImage = !!firstPendingImage;
  const suggestedImageIntent = useMemo(() => detectImageIntent(input), [input]);
  const effectiveImageIntent: ImageIntentChoice = manualImageIntent ?? suggestedImageIntent;

  const quickActions = useMemo(() => quickActionsForLocale(locale), [locale]);

  const showQuickActions = !loading && pending.length === 0;

  function closeSidebarOnMobile() {
    if (isMobile) setSidebarOpen(false);
  }

  function fallbackCopyText(value: string) {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function handleCopy(value: string, key: string) {
    if (!value) return;

    const markCopied = () => {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? "" : prev));
      }, 1400);
    };

    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(value)
        .then(() => {
          markCopied();
        })
        .catch(() => {
          if (fallbackCopyText(value)) {
            markCopied();
          }
        });
      return;
    }

    if (fallbackCopyText(value)) {
      markCopied();
    }
  }

  function triggerImageButton() {
    const root = imageButtonWrapRef.current;
    if (!root) return false;

    const btn = root.querySelector("button") as HTMLButtonElement | null;
    if (!btn || btn.disabled) return false;

    btn.click();
    return true;
  }

  function focusInputSoon() {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function dismissMobileComposer() {
    if (!isMobile) return;
    setInputFocused(false);
    try {
      inputRef.current?.blur();
    } catch {}
  }

  useEffect(() => {
    try {
      setMode(loadMode(MODE_KEY, "general"));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
  }, [mode]);

  useEffect(() => {
    if (!allowedModes.includes(mode)) {
      setMode(allowedModes[0] || "general");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCanonical]);

  useEffect(() => {
    const saved = clampLocale(
      typeof window !== "undefined" ? localStorage.getItem(LOCALE_STORAGE_KEY) : null
    );
    const next = saved || detectBrowserLocale();
    setLocale(next);

    setMessages((prev) => {
      if (prev.length === 1 && prev[0]?.role === "assistant") {
        return [{ ...prev[0], content: t(next, "chat.greeting") }];
      }
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const apply = () => {
      const mobile = window.innerWidth <= 980;
      setIsMobile(mobile);
      setViewportHeight(window.innerHeight || 0);
      setSidebarOpen((prev) => {
        if (mobile) return false;
        return prev;
      });
    };

    apply();

    const onResize = () => apply();
    window.addEventListener("resize", onResize);

    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  useEffect(() => {
    if (!hasPendingImage) {
      setManualImageIntent(null);
      setImageStatus("");
    }
  }, [hasPendingImage]);

  function scrollToBottom(force = false) {
    const run = () => {
      try {
        bottomRef.current?.scrollIntoView({ behavior: force ? "auto" : "smooth", block: "end" });
      } catch {}
    };

    requestAnimationFrame(run);
    window.setTimeout(run, 40);
  }

  async function fetchStats(forPlan: Plan | null) {
    const headers: Record<string, string> = {};
    if (forPlan) {
      const cp = toCanonicalPlan(forPlan);
      headers["x-ajx-dev-plan"] = canonicalToHeaderPlan(cp) as any;
    }

    const res = await fetch("/api/stats", { headers, method: "GET" });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return;

    const j = (await res.json()) as StatsResp;
    if (j?.ok) {
      setPlan(j.plan);
      setLimits(j.limits);
      setUsage(j.usage);
    }
  }

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const p = clampPlan(sp.get("devPlan"));
    setDevPlan(p);

    if (p) {
      const cp = toCanonicalPlan(p);
      setLimits(defaultLimitsForCanonicalPlan(cp));
    }

    if (didInitRef.current) return;
    didInitRef.current = true;

    const loaded = loadThreads(p);
    if (loaded.length === 0) {
      const th = createThread(greeting, titleDefault);
      const next = [th];
      setThreads(next);
      setActiveId(th.id);
      setMessages(th.messages);
      saveThreads(next, p);
      setActiveThreadId(th.id, p);
    } else {
      const savedActive = getActiveThreadId(p);
      const first = loaded[0];
      const active = loaded.find((x) => x.id === savedActive) || first;

      setThreads(loaded);
      setActiveId(active.id);
      setMessages(active.messages);
      setActiveThreadId(active.id, p);
    }

    fetchStats(p).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greeting, titleDefault]);

  useEffect(() => {
    if (!threads.length) return;

    const nextThreads: ChatThread[] = threads.map((th) => {
      const updated = updateAutoTitle(th, titleDefault) as ChatThread;
      const normalized: ChatThread = {
        ...updated,
        titleMode: normalizeTitleMode((updated as any).titleMode),
      };

      if ((normalized.titleMode || "auto") === "auto") {
        if (normalized.messages.length === 1 && normalized.messages[0]?.role === "assistant") {
          return { ...normalized, title: titleDefault, titleMode: "auto" as any };
        }
      }

      return normalized;
    });

    const changed =
      JSON.stringify(nextThreads.map((t) => [t.id, t.title, t.titleMode])) !==
      JSON.stringify(threads.map((t) => [t.id, t.title, t.titleMode]));

    if (changed) {
      setThreads(nextThreads);
      saveThreads(nextThreads, devPlan);

      if (activeId) {
        const active = nextThreads.find((x) => x.id === activeId);
        if (active) setMessages(active.messages);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, titleDefault]);

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;

    const updateViewportLayout = () => {
      const mobile = window.innerWidth <= 980;
      if (!mobile) {
        setViewportHeight(window.innerHeight || 0);
        setKeyboardInset(0);
        return;
      }

      if (!vv) {
        setViewportHeight(window.innerHeight || 0);
        setKeyboardInset(0);
        return;
      }

      const nextViewportHeight = Math.max(0, Math.round(vv.height));
      const rawInset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      const nextInset = rawInset > 120 ? Math.round(rawInset) : 0;

      setViewportHeight(nextViewportHeight || window.innerHeight || 0);
      setKeyboardInset(nextInset);
    };

    updateViewportLayout();

    if (!vv) {
      window.addEventListener("resize", updateViewportLayout);
      window.addEventListener("orientationchange", updateViewportLayout);
      return () => {
        window.removeEventListener("resize", updateViewportLayout);
        window.removeEventListener("orientationchange", updateViewportLayout);
      };
    }

    vv.addEventListener("resize", updateViewportLayout);
    vv.addEventListener("scroll", updateViewportLayout);
    window.addEventListener("orientationchange", updateViewportLayout);

    return () => {
      vv.removeEventListener("resize", updateViewportLayout);
      vv.removeEventListener("scroll", updateViewportLayout);
      window.removeEventListener("orientationchange", updateViewportLayout);
    };
  }, []);

  useEffect(() => {
    const measure = () => {
      const h = composerRef.current?.offsetHeight || 120;
      setComposerHeight(h);
    };

    measure();
    window.addEventListener("resize", measure);

    return () => window.removeEventListener("resize", measure);
  }, [input, pending.length, locale, loading, showQuickActions, keyboardInset, plan, imageStatus]);

  useEffect(() => {
    if (!isMobile || !inputFocused) return;

    const id = window.setTimeout(() => {
      scrollToBottom(true);
    }, 120);

    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, inputFocused, keyboardInset, composerHeight]);

  function persistActive(nextMessages: ChatMsg[]) {
    if (!activeId) return;
    const current = threads.find((tt) => tt.id === activeId);
    if (!current) return;

    const updatedBase: ChatThread = {
      ...current,
      messages: nextMessages,
      updatedAt: Date.now(),
    };
    const updated = updateAutoTitle(updatedBase, titleDefault) as ChatThread;
    const fixed: ChatThread = {
      ...updated,
      titleMode: normalizeTitleMode((updated as any).titleMode),
    };

    const nextThreads = upsertThread(threads, fixed);
    setThreads(nextThreads);
    saveThreads(nextThreads, devPlan);
  }

  function appendAssistantMessage(text: string) {
    const msg: ChatMsg = { role: "assistant", content: text, ts: nowTs() };
    setMessages((prev) => {
      const next = [...prev, msg];
      persistActive(next);
      return next;
    });
  }

  function upsertAssistantStreamMessage(streamTs: number, text: string) {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.role === "assistant" && m.ts === streamTs);
      let next: ChatMsg[];

      if (idx === -1) {
        next = [...prev, { role: "assistant", content: text, ts: streamTs }];
      } else {
        next = prev.map((m, i) => (i === idx ? { ...m, content: text } : m));
      }

      persistActive(next);
      return next;
    });
  }

  function insertLineBreak() {
    if (loading) return;

    const el = inputRef.current;
    const currentValue = input || "";

    if (!el) {
      setInput((prev) => `${prev}\n`);
      return;
    }

    const start = el.selectionStart ?? currentValue.length;
    const end = el.selectionEnd ?? currentValue.length;

    const nextValue = `${currentValue.slice(0, start)}\n${currentValue.slice(end)}`;
    setInput(nextValue);

    requestAnimationFrame(() => {
      const nextPos = start + 1;
      el.focus();
      el.selectionStart = nextPos;
      el.selectionEnd = nextPos;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    });
  }

  function setActiveThread(id: string) {
    const th = threads.find((x) => x.id === id);
    if (!th) return;

    setActiveId(id);
    setActiveThreadId(id, devPlan);
    setMessages(th.messages);
    setInput("");
    setPlusOpen(false);
    setImageStatus("");
    setPending([]);
    setForceWebNext(false);
    setManualImageIntent(null);
    closeSidebarOnMobile();
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      inputRef.current?.focus();
    });
  }

  function newChat() {
    const th = createThread(greeting, titleDefault);
    const nextThreads = [th, ...threads].sort((a, b) => b.updatedAt - a.updatedAt);

    setThreads(nextThreads);
    setActiveId(th.id);
    setActiveThreadId(th.id, devPlan);
    setMessages(th.messages);
    saveThreads(nextThreads, devPlan);

    setInput("");
    setPlusOpen(false);
    setImageStatus("");
    setPending([]);
    setForceWebNext(false);
    setManualImageIntent(null);
    closeSidebarOnMobile();
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      inputRef.current?.focus();
    });
  }

  function renameChat(id: string) {
    const th = threads.find((x) => x.id === id);
    if (!th) return;

    const name = window.prompt(t(locale, "thread.rename"), th.title);
    if (!name) return;

    const updated = setCustomTitle(th, name) as ChatThread;
    const fixed: ChatThread = {
      ...updated,
      titleMode: normalizeTitleMode((updated as any).titleMode),
    };

    const nextThreads = upsertThread(threads, { ...fixed, updatedAt: Date.now() });
    setThreads(nextThreads);
    saveThreads(nextThreads, devPlan);
  }

  function removeChat(id: string) {
    const ok = window.confirm(t(locale, "thread.delete.confirm"));
    if (!ok) return;

    const nextThreads = deleteThread(threads, id);
    setThreads(nextThreads);
    saveThreads(nextThreads, devPlan);

    if (activeId === id) {
      if (nextThreads.length === 0) {
        const th = createThread(greeting, titleDefault);
        const arr = [th];
        setThreads(arr);
        setActiveId(th.id);
        setActiveThreadId(th.id, devPlan);
        setMessages(th.messages);
        saveThreads(arr, devPlan);
      } else {
        const nextActive = nextThreads[0];
        setActiveId(nextActive.id);
        setActiveThreadId(nextActive.id, devPlan);
        setMessages(nextActive.messages);
      }
    }

    closeSidebarOnMobile();
  }

  function buildBackendMessages(userText: string) {
    const snapshot = [...messages, { role: "user" as const, content: userText, ts: nowTs() }];
    const sliced = snapshot.slice(-24);
    return sliced.map((m) => ({ role: m.role, content: m.content }));
  }

  function renderMessageContent(text: string, isUser: boolean) {
    const s = text || "";
    const stripped = stripMarkdownImages(s);

    if (isUser) {
      return (
        <div
          className={styles.bubbleText}
          style={{
            whiteSpace: "pre-wrap",
            maxWidth: "100%",
            minWidth: 0,
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
        >
          {stripped || ""}
        </div>
      );
    }

    return <RichMessage text={stripped} locale={locale} />;
  }

  function setLocaleAndPersist(next: Locale) {
    setLocale(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {}

    setMessages((prev) => {
      if (prev.length === 1 && prev[0]?.role === "assistant") {
        return [{ ...prev[0], content: t(next, "chat.greeting") }];
      }
      return prev;
    });
  }

  async function readFileAsDataUrl(file: File): Promise<string> {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("FileReader error"));
      fr.onload = () => resolve(String(fr.result || ""));
      fr.readAsDataURL(file);
    });
  }

  async function addAttachmentFromFile(file: File, kind: "image" | "file") {
    if (kind === "image") {
      const compressed = await compressImageFile(file);

      if (estimateDataUrlBytes(compressed.dataUrl) > HARD_MAX_IMAGE_BYTES) {
        throw new Error(
          locale === "fi"
            ? "Kuva on liian suuri. Valitse pienempi kuva."
            : locale === "es"
              ? "La imagen es demasiado grande. Elige una imagen mÃ¡s pequeÃ±a."
              : "The image is too large. Choose a smaller image."
        );
      }

      setPending((prev) => [
        ...prev,
        {
          id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
          kind,
          name: compressed.name || file.name || "image.jpg",
          type: compressed.type || "image/jpeg",
          dataUrl: compressed.dataUrl,
        },
      ]);
      setManualImageIntent(null);
      setImageStatus(imageQueuedText(locale));
      return;
    }

    if (file.size > MAX_NON_IMAGE_FILE_BYTES) {
      throw new Error(
        locale === "fi"
          ? "Tiedosto on liian suuri."
          : locale === "es"
            ? "El archivo es demasiado grande."
            : "The file is too large."
      );
    }

    const dataUrl = await readFileAsDataUrl(file);
    setPending((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        kind,
        name: file.name || "file",
        type: file.type || "application/octet-stream",
        dataUrl,
      },
    ]);
    setManualImageIntent(null);
  }

  function removeAttachmentChip(id: string) {
    setPending((prev) => prev.filter((x) => x.id !== id));
  }

  function computePlusMenuPos() {
    const btn = plusBtnRef.current;
    if (!btn || typeof window === "undefined") return;

    const rect = btn.getBoundingClientRect();

    const GAP = 10;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const MENU_W = Math.min(260, Math.max(200, vw - 24));

    let left = rect.left;
    let top = rect.bottom + GAP;

    if (left + MENU_W > vw - 12) {
      left = Math.max(12, vw - MENU_W - 12);
    }
    if (left < 12) {
      left = 12;
    }

    const estimatedH = 170;
    if (top + estimatedH > vh - 12) {
      top = Math.max(12, rect.top - GAP - estimatedH);
    }

    setPlusMenuPos({ open: true, left, top, width: MENU_W });
  }

  useEffect(() => {
    if (!plusOpen) {
      setPlusMenuPos((p) => ({ ...p, open: false }));
      return;
    }

    computePlusMenuPos();

    const onResize = () => computePlusMenuPos();
    const onScroll = () => computePlusMenuPos();

    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlusOpen(false);
    };
    window.addEventListener("keydown", onKey);

    const onDown = (e: MouseEvent) => {
      const btn = plusBtnRef.current;
      const menu = plusMenuRef.current;
      const target = e.target as Node | null;
      if (!target) return;

      if (btn && btn.contains(target)) return;
      if (menu && menu.contains(target)) return;

      setPlusOpen(false);
    };
    document.addEventListener("mousedown", onDown);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plusOpen]);

  async function sendTextDirect(text: string, forcedMode?: AjxMode, hiddenInstruction?: string) {
    const cleaned = (text || "").trim();
    if (!cleaned && pending.length === 0) return;
    if (loading) return;

    const useWebComputed = forceWebNext;
    const usedMode = forcedMode ?? mode;

    dismissMobileComposer();
    setInput("");
    setPlusOpen(false);
    setLoading(true);
    closeSidebarOnMobile();

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    const attachNote =
      pending.length > 0
        ? `\n\n[${t(locale, "ui.attachments")}: ${pending.map((p) => p.name).join(", ")}]`
        : "";
    const visibleUserContent = (cleaned || "") + attachNote;

    const backendUserContent = hiddenInstruction
      ? `${visibleUserContent}\n\n[AJX_QUICK_ACTION_INSTRUCTION]\n${hiddenInstruction}`
      : visibleUserContent;

    const userMsg: ChatMsg = { role: "user", content: visibleUserContent, ts: nowTs() };
    const optimistic = [...messages, userMsg];
    setMessages(optimistic);
    persistActive(optimistic);
    scrollToBottom(true);

    const convoForBackend = buildBackendMessages(backendUserContent);
    const attachmentsForRequest = pending.map((p) => ({
      kind: p.kind,
      name: p.name,
      type: p.type,
      dataUrl: p.dataUrl,
    }));

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      if (devPlan) {
        const cp = toCanonicalPlan(devPlan);
        headers["x-ajx-dev-plan"] = canonicalToHeaderPlan(cp) as any;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          stream: true,
          useWeb: useWebComputed,
          imagesRequested: 0,
          messages: convoForBackend,
          locale,
          rolesEnabled: true,
          role: modeToRole(usedMode),
          attachments: attachmentsForRequest,
        }),
      });

      const ct = res.headers.get("content-type") || "";

      setPending([]);
      setForceWebNext(false);
      setManualImageIntent(null);
      setImageStatus("");

      if (!res.ok) {
        if (ct.includes("application/json")) {
          const ej = (await res.json()) as ChatErrJson;
          const errText = ej?.upsell?.message || ej?.error || `HTTP ${res.status}`;
          const nextMsgs = [
            ...optimistic,
            { role: "assistant" as const, content: errText, ts: nowTs() },
          ];
          setMessages(nextMsgs);
          persistActive(nextMsgs);

          if (ej.plan && ej.limits && ej.usage) {
            setPlan(ej.plan);
            setLimits(ej.limits);
            setUsage(ej.usage);
          } else {
            await fetchStats(devPlan).catch(() => {});
          }
        } else {
          const tt = await res.text().catch(() => "");
          const nextMsgs = [
            ...optimistic,
            { role: "assistant" as const, content: tt || `HTTP ${res.status}`, ts: nowTs() },
          ];
          setMessages(nextMsgs);
          persistActive(nextMsgs);
          await fetchStats(devPlan).catch(() => {});
        }
        return;
      }

      if (ct.includes("application/json")) {
        const j = (await res.json()) as ChatOkJson;
        const nextMsgs = [
          ...optimistic,
          { role: "assistant" as const, content: j?.text ?? "", ts: nowTs() },
        ];
        setMessages(nextMsgs);
        persistActive(nextMsgs);

        setPlan(j.plan);
        setLimits(j.limits);
        setUsage(j.usage);
        return;
      }

      if (!res.body) {
        const tt = await res.text().catch(() => "");
        const nextMsgs = [
          ...optimistic,
          {
            role: "assistant" as const,
            content: tt || "(Virhe: stream puuttuu)",
            ts: nowTs(),
          },
        ];
        setMessages(nextMsgs);
        persistActive(nextMsgs);
        await fetchStats(devPlan).catch(() => {});
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const streamTs = nowTs() + 1;

      let textSoFar = "";
      let sseBuffer = "";
      let lineBuffer = "";
      let finalPlan: Plan | undefined;
      let finalLimits: Limits | undefined;
      let finalUsage: Usage | undefined;
      let streamError = "";
      let sawStructuredStream = false;

      const applyText = (nextText: string) => {
        textSoFar = nextText;
        upsertAssistantStreamMessage(streamTs, textSoFar);
        scrollToBottom(true);
      };

      const appendDelta = (delta: string) => {
        if (!delta) return;
        applyText(textSoFar + delta);
      };

      const applyMeta = (obj: any) => {
        if (obj?.plan) finalPlan = obj.plan;
        if (obj?.limits) finalLimits = obj.limits;
        if (obj?.usage) finalUsage = obj.usage;
      };

      const handleStructuredPayload = (payload: string) => {
        const trimmed = String(payload || "").trim();
        if (!trimmed) return;

        if (trimmed === "[DONE]") {
          sawStructuredStream = true;
          return;
        }

        try {
          const obj = JSON.parse(trimmed);
          sawStructuredStream = true;
          applyMeta(obj);

          if (obj?.error) {
            streamError = String(obj.error);
          }

          if (typeof obj?.delta === "string") {
            appendDelta(obj.delta);
          }

          if (typeof obj?.text === "string" && obj?.type === "delta") {
            appendDelta(obj.text);
          }

          if (typeof obj?.content === "string" && obj?.type === "delta") {
            appendDelta(obj.content);
          }

          const explicitFull =
            typeof obj?.fullText === "string"
              ? obj.fullText
              : typeof obj?.text === "string" && (obj?.type === "final" || obj?.done)
                ? obj.text
                : typeof obj?.content === "string" && (obj?.type === "final" || obj?.done)
                  ? obj.content
                  : null;

          if (typeof explicitFull === "string") {
            applyText(explicitFull);
          }

          return;
        } catch {
          // fall through to raw text append
        }

        appendDelta(trimmed);
      };

      const processSseChunk = (chunk: string) => {
        sseBuffer += chunk;

        while (true) {
          const sepIndex = sseBuffer.indexOf("\n\n");
          if (sepIndex === -1) break;

          const block = sseBuffer.slice(0, sepIndex);
          sseBuffer = sseBuffer.slice(sepIndex + 2);

          const lines = block
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

          const dataLines = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s?/, ""));

          if (dataLines.length === 0) continue;
          handleStructuredPayload(dataLines.join("\n"));
        }
      };

      const processNdjsonChunk = (chunk: string) => {
        lineBuffer += chunk;

        while (true) {
          const newlineIndex = lineBuffer.indexOf("\n");
          if (newlineIndex === -1) break;

          const line = lineBuffer.slice(0, newlineIndex);
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          handleStructuredPayload(line);
        }
      };

      const isEventStream = ct.includes("text/event-stream");
      const isNdjson =
        ct.includes("application/x-ndjson") ||
        ct.includes("application/jsonl") ||
        ct.includes("application/ndjson");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;

        if (isEventStream) {
          processSseChunk(chunk);
          continue;
        }

        if (isNdjson) {
          processNdjsonChunk(chunk);
          continue;
        }

        appendDelta(chunk);
      }

      const tail = decoder.decode();
      if (tail) {
        if (isEventStream) {
          processSseChunk(tail);
          if (sseBuffer.trim()) {
            const leftover = sseBuffer
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.replace(/^data:\s?/, ""))
              .join("\n");
            if (leftover) handleStructuredPayload(leftover);
          }
        } else if (isNdjson) {
          processNdjsonChunk(tail);
          if (lineBuffer.trim()) {
            handleStructuredPayload(lineBuffer);
          }
        } else {
          appendDelta(tail);
        }
      } else {
        if (isEventStream && sseBuffer.trim()) {
          const leftover = sseBuffer
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s?/, ""))
            .join("\n");
          if (leftover) handleStructuredPayload(leftover);
        }

        if (isNdjson && lineBuffer.trim()) {
          handleStructuredPayload(lineBuffer);
        }
      }

      if (streamError) {
        applyText(streamError);
      }

      if (!sawStructuredStream && !textSoFar.trim()) {
        applyText(
          locale === "fi" ? "(TyhjÃ¤ vastaus)" : locale === "es" ? "(Respuesta vacÃ­a)" : "(Empty response)"
        );
      }

      if (finalPlan && finalLimits && finalUsage) {
        setPlan(finalPlan);
        setLimits(finalLimits);
        setUsage(finalUsage);
      } else {
        await fetchStats(devPlan).catch(() => {});
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "Tuntematon virhe.";
      const nextMsgs = [
        ...optimistic,
        { role: "assistant" as const, content: msg, ts: nowTs() },
      ];
      setMessages(nextMsgs);
      persistActive(nextMsgs);
      await fetchStats(devPlan).catch(() => {});
    } finally {
      setLoading(false);
      scrollToBottom(true);
      if (!isMobile) {
        focusInputSoon();
      }
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && pending.length === 0) || loading) return;

    if (hasPendingImage && text) {
      if (effectiveImageIntent === "edit") {
        if (!canEditImages) {
          appendAssistantMessage(
            locale === "fi"
              ? "Kuvan muokkaus on kÃ¤ytÃ¶ssÃ¤ vain Pro- ja Company-tasoilla."
              : locale === "es"
                ? "La ediciÃ³n de imÃ¡genes estÃ¡ disponible solo en los planes Pro y Company."
                : "Image editing is available only on Pro and Company plans."
          );
          return;
        }

        setImageStatus(imageEditStartedText(locale));
        scrollToBottom(true);

        const ok = triggerImageButton();
        if (!ok) {
          setImageStatus("");
          appendAssistantMessage(
            locale === "fi"
              ? "Kuvan muokkausnappia ei lÃ¶ytynyt. Kokeile painaa kuvan generointinappia kerran."
              : locale === "es"
                ? "No se encontrÃ³ el botÃ³n de ediciÃ³n de imagen. Prueba a pulsar el botÃ³n de generaciÃ³n una vez."
                : "Image edit button was not found. Try pressing the image generation button once."
          );
        }
        return;
      }

      if (effectiveImageIntent === null) {
        appendAssistantMessage(
          locale === "fi"
            ? "Valitse ensin haluatko analysoida kuvan vai muokata sitÃ¤."
            : locale === "es"
              ? "Primero elige si quieres analizar o editar la imagen."
              : "First choose whether you want to analyze or edit the image."
        );
        return;
      }
    }

    await sendTextDirect(text);
  }

  async function runQuickAction(action: QuickAction) {
    if (effectiveCanonical === "free") {
      appendAssistantMessage(quickActionLockedText(locale));
      return;
    }

    await sendTextDirect(action.prompt, action.mode, quickActionQuestionInstruction(action, locale));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage().catch(() => {});
    }
  }

  const activeTitle = useMemo(() => {
    const th = threads.find((x) => x.id === activeId);
    return th?.title || titleDefault;
  }, [threads, activeId, titleDefault]);

  const planLabel = planLabelLocalized(effectiveCanonical);
  const freeCounterLabel = t(locale, "ui.free_messages");

  const helpLabel = locale === "fi" ? "Ohjeet" : locale === "es" ? "Ayuda" : "Help";
  const composerTextPlaceholder = composerPlaceholder(locale);
  const chatsLabel = chatsToggleLabel(locale);

  const disclaimerText = useMemo(() => {
    if (locale === "es") {
      return "AJX AI es una inteligencia artificial y puede cometer errores. Verifica siempre la información.";
    }
    if (locale === "en") {
      return "AJX AI is an AI and can make mistakes. Always verify important information.";
    }
    return "AJX AI on tekoäly ja voi tehdä virheitä. Tarkista tiedot aina.";
  }, [locale]);

  const imageIntentHint = useMemo(() => {
    if (!hasPendingImage) return "";

    if (effectiveImageIntent === "edit") {
      return locale === "fi"
        ? "Tulkinta: kuvan muokkaus"
        : locale === "es"
          ? "InterpretaciÃ³n: ediciÃ³n de imagen"
          : "Interpretation: image editing";
    }
  const attachmentHint = useMemo(() => attachmentHintText(locale), [locale]);
  const attachFileLabel = useMemo(() => attachFileMenuLabel(locale), [locale]);

    if (effectiveImageIntent === "analyze") {
      return locale === "fi"
        ? "Tulkinta: kuvan analyysi"
        : locale === "es"
          ? "InterpretaciÃ³n: anÃ¡lisis de imagen"
          : "Interpretation: image analysis";
    }

    return locale === "fi"
      ? "Valitse haluatko analysoida vai muokata kuvaa"
      : locale === "es"
        ? "Elige si quieres analizar o editar la imagen"
        : "Choose whether you want to analyze or edit the image";
  }, [effectiveImageIntent, hasPendingImage, locale]);

  const sendDisabled =
    loading ||
    (!input.trim() && pending.length === 0) ||
    (hasPendingImage && !!input.trim() && effectiveImageIntent === null);

  const mobileShellStyle: React.CSSProperties = isMobile
    ? {
        height: viewportHeight > 0 ? `${viewportHeight}px` : "100dvh",
        minHeight: viewportHeight > 0 ? `${viewportHeight}px` : "100dvh",
        maxHeight: viewportHeight > 0 ? `${viewportHeight}px` : "100dvh",
        overflow: "hidden",
      }
    : {};

  const planMiniText =
    effectiveCanonical === "free"
      ? `${planLabel} · ${Number(usage?.msgThisMonth || 0)}/${FREE_DISPLAY_LIMIT}`
      : planLabel;

  return (
    <div className={styles.shell} style={mobileShellStyle}>
      <div className={styles.bg} aria-hidden="true" />

      <style jsx>{`
        :global(body) {
          background: #07100c !important;
        }

        :global(.ajxControlGroup),
        :global(.ajxSelect),
        :global(.ajxHelpLink),
        :global(.ajxDisclaimerPlan),
        :global(.ajxCopyBtn) {
          background: rgba(8, 18, 13, 0.92) !important;
          color: #f4fff7 !important;
          border-color: rgba(91, 255, 139, 0.22) !important;
        }

        :global(.ajxDisclaimerRow) {
          color: rgba(244, 255, 247, 0.68) !important;
        }

        :global(textarea),
        :global(.ajxComposerText) {
          background: rgba(244, 255, 247, 0.96) !important;
          color: #07100c !important;
          caret-color: #07100c !important;
        }

        :global(textarea::placeholder) {
          color: rgba(7, 16, 12, 0.48) !important;
        }

        :global([data-ajx-card-themed="true"]),
        :global([data-ajx-themed="true"]) {
          background:
            radial-gradient(circle at top left, rgba(91, 255, 139, 0.10), transparent 42%),
            #07100c !important;
          border-color: rgba(91, 255, 139, 0.22) !important;
        }
        body {
          background: #07100c !important;
        }

        .ajxTopControls,
        .ajxControlGroup,
        .ajxSelect,
        .ajxHelpLink,
        .ajxDisclaimerPlan {
          background: rgba(8, 18, 13, 0.88) !important;
          color: #f4fff7 !important;
          border-color: rgba(91, 255, 139, 0.18) !important;
        }

        .ajxSelect option {
          background: #07100c !important;
          color: #f4fff7 !important;
        }

        [data-ajx-card-themed="true"],
        [data-ajx-themed="true"] {
          background:
            radial-gradient(circle at top left, rgba(91, 255, 139, 0.10), transparent 42%),
            #07100c !important;
          border-color: rgba(91, 255, 139, 0.20) !important;
        }

        .ajxDisclaimerRow {
          color: rgba(244, 255, 247, 0.66) !important;
        }

        textarea {
          background: rgba(244, 255, 247, 0.96) !important;
          color: #07100c !important;
          caret-color: #07100c !important;
        }

        textarea::placeholder {
          color: rgba(7, 16, 12, 0.48) !important;
        }
        body {
          background: #07100c !important;
        }

        .ajxTopControls,
        .ajxControlGroup,
        .ajxSelect,
        .ajxHelpLink,
        .ajxDisclaimerPlan {
          background: rgba(8, 18, 13, 0.88) !important;
          color: #f4fff7 !important;
          border-color: rgba(91, 255, 139, 0.18) !important;
        }

        .ajxSelect option {
          background: #07100c !important;
          color: #f4fff7 !important;
        }

        [data-ajx-card-themed="true"],
        [data-ajx-themed="true"] {
          background:
            radial-gradient(circle at top left, rgba(91, 255, 139, 0.10), transparent 42%),
            #07100c !important;
          border-color: rgba(91, 255, 139, 0.20) !important;
        }

        .ajxDisclaimerRow {
          color: rgba(244, 255, 247, 0.66) !important;
        }

        textarea {
          background: rgba(244, 255, 247, 0.96) !important;
          color: #07100c !important;
          caret-color: #07100c !important;
        }

        textarea::placeholder {
          color: rgba(7, 16, 12, 0.48) !important;
        }
        textarea {
          color: #111 !important;
          caret-color: #111 !important;
        }

        textarea::placeholder {
          color: rgba(0,0,0,0.4) !important;
        }
        .ajxToolsIconBtn {
          width: 46px;
          height: 46px;
          border-radius: 16px;
          border: 1px solid rgba(91, 255, 139, 0.28);
          background: rgba(91, 255, 139, 0.12);
          color: #35d96f;
          display: grid;
          place-items: center;
          font-size: 19px;
          font-weight: 950;
          cursor: pointer;
        }

        .ajxToolsDrawerMoved {
          margin-top: 10px;
          margin-bottom: 10px;
        }

        .ajxToolsDrawer {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          padding: 10px;
          border-radius: 18px;
          border: 1px solid rgba(91, 255, 139, 0.20);
          background: rgba(5, 10, 16, 0.92);
        }

        .ajxToolsDrawerBtn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          border: 1px solid rgba(91, 255, 139, 0.16);
          background: rgba(255, 255, 255, 0.045);
          color: #ffffff;
          border-radius: 14px;
          padding: 11px 12px;
          font-size: 12px;
          font-weight: 900;
          cursor: pointer;
          text-align: left;
        }

        .ajxToolsDrawerBtn b {
          color: rgba(91, 255, 139, 0.95);
          font-size: 16px;
        }

        @media (max-width: 520px) {
          .ajxToolsIconBtn {
            width: 42px;
            height: 42px;
            border-radius: 14px;
            font-size: 18px;
          }

          .ajxToolsDrawer {
            grid-template-columns: 1fr;
          }
        }

        .ajxToolsIconBtn {
          width: 46px;
          height: 46px;
          border-radius: 16px;
          border: 1px solid rgba(91, 255, 139, 0.28);
          background: rgba(91, 255, 139, 0.12);
          color: #35d96f;
          display: grid;
          place-items: center;
          font-size: 20px;
          font-weight: 950;
          cursor: pointer;
          box-shadow: 0 10px 24px rgba(21, 80, 42, 0.12);
        }

        .ajxToolsIconBtn:hover {
          background: rgba(91, 255, 139, 0.18);
          border-color: rgba(91, 255, 139, 0.42);
        }

        .ajxToolsDrawerMoved {
          margin-top: 10px;
        }

        .ajxToolsMiniRow {
          display: none !important;
        }

        body {
          background: #07100c !important;
        }

        .ajxTopControls,
        .ajxControlGroup,
        .ajxSelect,
        .ajxHelpLink {
          border-color: rgba(91, 255, 139, 0.18) !important;
        }

        [data-ajx-card-themed="true"] {
          background:
            radial-gradient(circle at top left, rgba(91, 255, 139, 0.08), transparent 36%),
            #07100c !important;
          border-color: rgba(91, 255, 139, 0.20) !important;
        }

        [data-ajx-themed="true"] {
          background:
            radial-gradient(circle at top left, rgba(91, 255, 139, 0.10), transparent 42%),
            #07100c !important;
          border-color: rgba(91, 255, 139, 0.22) !important;
        }

        [data-ajx-themed="true"] textarea {
          background: rgba(255, 255, 255, 0.94) !important;
        }

        @media (max-width: 520px) {
          .ajxToolsIconBtn {
            width: 42px;
            height: 42px;
            border-radius: 14px;
            font-size: 18px;
          }
        }

        [data-ajx-themed="true"] {
          border-top: 1px solid rgba(91, 255, 139, 0.18) !important;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.96), rgba(245,255,249,0.96)) !important;
          box-shadow: 0 -18px 60px rgba(21, 80, 42, 0.10) !important;
        }

        [data-ajx-card-themed="true"] {
          border: 1px solid rgba(91, 255, 139, 0.14) !important;
          box-shadow: 0 20px 80px rgba(21, 80, 42, 0.10) !important;
        }

        .ajxToolsMiniRow {
          display: flex;
          justify-content: flex-start;
          margin-bottom: 8px;
        }

        .ajxToolsMiniBtn {
          border: 1px solid rgba(91, 255, 139, 0.24);
          background: rgba(91, 255, 139, 0.10);
          color: #122018;
          border-radius: 999px;
          padding: 8px 13px;
          font-size: 12px;
          font-weight: 950;
          cursor: pointer;
        }

        .ajxToolsDrawer {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 10px;
          padding: 10px;
          border-radius: 18px;
          border: 1px solid rgba(91, 255, 139, 0.20);
          background: rgba(5, 10, 16, 0.88);
        }

        .ajxToolsDrawerBtn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          border: 1px solid rgba(91, 255, 139, 0.16);
          background: rgba(255, 255, 255, 0.045);
          color: #ffffff;
          border-radius: 14px;
          padding: 11px 12px;
          font-size: 12px;
          font-weight: 900;
          cursor: pointer;
          text-align: left;
        }

        .ajxToolsDrawerBtn b {
          color: rgba(91, 255, 139, 0.95);
          font-size: 16px;
        }

        .ajxToolsDrawerBtn:hover {
          background: rgba(91, 255, 139, 0.10);
          border-color: rgba(91, 255, 139, 0.32);
        }

        @media (max-width: 520px) {
          .ajxToolsDrawer {
            grid-template-columns: 1fr;
          }
        }

        .ajxCompactTools {
          margin: 8px 0 18px 0;
          padding: 16px;
          border-radius: 24px;
          border: 1px solid rgba(91, 255, 139, 0.20);
          background:
            radial-gradient(circle at top left, rgba(91, 255, 139, 0.13), transparent 38%),
            rgba(8, 12, 18, 0.88);
          box-shadow: 0 18px 48px rgba(0, 0, 0, 0.18);
        }

        .ajxCompactTop {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 14px;
        }

        .ajxCompactKicker {
          font-size: 11px;
          font-weight: 950;
          letter-spacing: 0.20em;
          color: rgba(91, 255, 139, 0.95);
        }

        .ajxCompactTitle {
          margin-top: 5px;
          font-size: 22px;
          line-height: 1.15;
          font-weight: 950;
          color: #ffffff;
        }

        .ajxCompactPlan {
          flex: 0 0 auto;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(91, 255, 139, 0.12);
          color: rgba(91, 255, 139, 0.98);
          border: 1px solid rgba(91, 255, 139, 0.22);
          font-size: 11px;
          font-weight: 950;
        }

        .ajxCompactGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }

        .ajxCompactToolBtn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          min-height: 52px;
          padding: 12px 13px;
          border-radius: 17px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.045);
          color: #ffffff;
          cursor: pointer;
          text-align: left;
          font-size: 13px;
          font-weight: 900;
          line-height: 1.25;
          transition: transform 0.14s ease, background 0.14s ease, border 0.14s ease;
        }

        .ajxCompactToolBtn:hover {
          transform: translateY(-1px);
          background: rgba(91, 255, 139, 0.09);
          border-color: rgba(91, 255, 139, 0.28);
        }

        .ajxCompactToolBtn b {
          flex: 0 0 auto;
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border-radius: 999px;
          background: rgba(91, 255, 139, 0.13);
          color: rgba(91, 255, 139, 0.98);
          font-size: 17px;
        }

        @media (max-width: 520px) {
          .ajxCompactTools {
            margin: 4px 0 14px 0;
            padding: 14px;
            border-radius: 22px;
          }

          .ajxCompactTitle {
            font-size: 20px;
          }

          .ajxCompactGrid {
            grid-template-columns: 1fr;
            gap: 8px;
          }

          .ajxCompactToolBtn {
            min-height: 48px;
            font-size: 13px;
          }
        }

        .ajxTopControls {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
          min-width: 0;
          max-width: 100%;
        }

        .ajxControlGroup {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px;
          border-radius: 16px;
          border: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(255, 255, 255, 0.62);
          backdrop-filter: blur(12px);
          box-shadow: 0 10px 24px rgba(11, 13, 18, 0.08);
          max-width: 100%;
          min-width: 0;
        }

        .ajxControlLabel {
          font-size: 12px;
          font-weight: 950;
          letter-spacing: 0.2px;
          color: rgba(11, 13, 18, 0.62);
          padding-left: 8px;
          white-space: nowrap;
        }

        .ajxSelectWrap {
          position: relative;
          display: inline-flex;
          align-items: center;
          max-width: 100%;
          min-width: 0;
        }

        .ajxSelect {
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.86);
          color: #0b0d12;
          border-radius: 14px;
          padding: 10px 36px 10px 12px;
          font-size: 13px;
          font-weight: 900;
          cursor: pointer;
          outline: none;
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.08);
          transition:
            border 0.12s ease,
            box-shadow 0.12s ease,
            background 0.12s ease,
            transform 0.12s ease;
          max-width: 100%;
          min-width: 0;
        }

        .ajxSelect:hover {
          border-color: rgba(11, 13, 18, 0.16);
          background: rgba(255, 255, 255, 0.94);
          box-shadow: 0 14px 30px rgba(11, 13, 18, 0.1);
        }

        .ajxSelect:focus {
          border-color: rgba(11, 13, 18, 0.2);
          box-shadow: 0 14px 34px rgba(11, 13, 18, 0.12), 0 0 0 4px rgba(11, 13, 18, 0.08);
        }

        .ajxChevron {
          pointer-events: none;
          position: absolute;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          opacity: 0.65;
          font-weight: 1000;
          font-size: 12px;
        }

        .ajxInlineImages {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          min-width: 0;
          max-width: 100%;
        }

        .ajxChips {
          margin-top: 8px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          min-width: 0;
          max-width: 100%;
        }

        .ajxChip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.62);
          backdrop-filter: blur(10px);
          font-size: 12px;
          font-weight: 900;
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.08);
          max-width: 100%;
          min-width: 0;
        }

        .ajxChipName {
          max-width: 260px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .ajxMenuCard {
          background: rgba(255, 255, 255, 0.92);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(11, 13, 18, 0.1);
          border-radius: 16px;
          box-shadow: 0 26px 80px rgba(11, 13, 18, 0.18);
          overflow: hidden;
        }

        .ajxMenuItem {
          width: 100%;
          justify-content: flex-start;
          border-radius: 0;
          padding: 12px 12px;
          border-left: none;
          border-right: none;
          border-top: none;
        }

        .ajxMenuItem + .ajxMenuItem {
          border-top: 1px solid rgba(11, 13, 18, 0.06);
        }

        .ajxComposerActions {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: end;
          gap: 10px;
          width: 100%;
          min-width: 0;
          max-width: 100%;
        }

        .ajxComposerLeft {
          grid-column: 1;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          align-self: end;
          min-width: 0;
          max-width: 100%;
        }

        .ajxComposerCenter {
          grid-column: 2;
          min-width: 0;
          width: 100%;
        }

        .ajxComposerRight {
          grid-column: 3;
          display: flex;
          gap: 8px;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: wrap;
          align-self: end;
          min-width: 0;
          max-width: 100%;
        }

        .ajxComposerText {
          width: 100%;
          min-width: 0;
          max-width: 100%;
        }

        .ajxActionBtn {
          width: 46px;
          height: 46px;
          border-radius: 16px;
          padding: 0;
          display: grid;
          place-items: center;
          line-height: 1;
          font-size: 18px;
          flex: 0 0 auto;
          position: relative;
          z-index: 3;
        }

        .ajxSidebarToggleBtn {
          min-width: 46px;
          height: 46px;
          border-radius: 16px;
          padding: 0 14px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          font-weight: 900;
          max-width: 100%;
        }

        .ajxSidebarToggleIcon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          font-size: 16px;
          line-height: 1;
        }

        .ajxSidebarToggleText {
          white-space: nowrap;
        }

        .ajxSidebarBackdrop {
          position: fixed;
          inset: 0;
          z-index: 100;
          background: rgba(11, 13, 18, 0.28);
          backdrop-filter: blur(2px);
        }

        .ajxHelpLink {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.86);
          color: #0b0d12;
          text-decoration: none;
          border-radius: 14px;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 900;
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.08);
          transition:
            border 0.12s ease,
            box-shadow 0.12s ease,
            background 0.12s ease,
            transform 0.12s ease;
          max-width: 100%;
          min-width: 0;
        }

        .ajxHelpLink:hover {
          border-color: rgba(11, 13, 18, 0.16);
          background: rgba(255, 255, 255, 0.94);
          box-shadow: 0 14px 30px rgba(11, 13, 18, 0.1);
          transform: translateY(-1px);
        }

        .ajxTopHelp {
          display: inline-flex;
        }

        .ajxComposerHelp {
          display: none;
        }

        .ajxParagraph {
          margin: 0 0 18px 0;
          line-height: 1.72;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxHeadingBlock {
          margin: 18px 0 12px;
          font-size: 15px;
          font-weight: 950;
          line-height: 1.35;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxRichList,
        .ajxRichListOrdered {
          margin: 0 0 16px 0;
          padding-left: 20px;
          line-height: 1.68;
          max-width: 100%;
          min-width: 0;
        }

        .ajxRichList li,
        .ajxRichListOrdered li {
          margin: 0 0 6px 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxQuestionList {
          margin: 0 0 16px 0;
          max-width: 100%;
          min-width: 0;
        }

        .ajxQuestionRow {
          line-height: 1.68;
          font-weight: 700;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxSummaryBox {
          margin: 4px 0 16px 0;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(11, 13, 18, 0.04);
          max-width: 100%;
          min-width: 0;
          overflow: hidden;
        }

        .ajxSummaryTitle {
          font-size: 11px;
          font-weight: 950;
          letter-spacing: 0.2px;
          text-transform: uppercase;
          opacity: 0.72;
          margin-bottom: 4px;
        }

        .ajxSummaryText {
          line-height: 1.55;
          font-weight: 700;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxDivider {
          height: 1px;
          margin: 12px 0 16px;
          background: rgba(11, 13, 18, 0.08);
          border-radius: 999px;
        }

        .ajxBubbleTop {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          max-width: 100%;
          min-width: 0;
        }

        .ajxCopyBtn {
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.72);
          color: #0b0d12;
          border-radius: 10px;
          padding: 6px 10px;
          font-size: 11px;
          font-weight: 900;
          cursor: pointer;
          transition:
            background 0.12s ease,
            border 0.12s ease,
            transform 0.12s ease;
        }

        .ajxCopyBtn:hover {
          background: rgba(255, 255, 255, 0.94);
          border-color: rgba(11, 13, 18, 0.16);
          transform: translateY(-1px);
        }

        .ajxCopyBtn:active {
          transform: translateY(1px);
        }

        .ajxCodeBlockWrap {
          margin: 0 0 16px 0;
          border: 1px solid rgba(11, 13, 18, 0.1);
          border-radius: 16px;
          overflow: hidden;
          background: rgba(11, 13, 18, 0.04);
          max-width: 100%;
          min-width: 0;
        }

        .ajxCodeToolbar {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 8px;
          padding: 8px 10px;
          border-bottom: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(255, 255, 255, 0.5);
          max-width: 100%;
          min-width: 0;
        }

        .ajxCodeLang {
          font-size: 11px;
          font-weight: 950;
          letter-spacing: 0.2px;
          opacity: 0.72;
          text-transform: uppercase;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxCodePre {
          margin: 0;
          padding: 12px 14px;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          max-width: 100%;
          white-space: pre;
          font-size: 13px;
          line-height: 1.55;
          font-family:
            ui-monospace,
            SFMono-Regular,
            Menlo,
            Monaco,
            Consolas,
            "Liberation Mono",
            "Courier New",
            monospace;
        }

        .ajxOutputBox {
          margin: 8px 0 16px 0;
          border: 1px solid rgba(11, 13, 18, 0.1);
          border-radius: 16px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.72);
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.06);
          max-width: 100%;
          min-width: 0;
        }

        .ajxOutputTop {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(11, 13, 18, 0.04);
          max-width: 100%;
          min-width: 0;
        }

        .ajxOutputTitle {
          font-size: 12px;
          font-weight: 950;
          letter-spacing: 0.2px;
          opacity: 0.78;
          text-transform: uppercase;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxOutputBody {
          margin: 0;
          padding: 14px 16px;
          white-space: pre;
          line-height: 1.7;
          font-size: 14px;
          font-family: inherit;
          max-width: 100%;
          min-width: max-content;
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }

        .ajxCodeBlockWrap {
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }

        .ajxCodePre {
          margin: 0;
          padding: 12px 14px;
          overflow-x: auto;
          overflow-y: hidden;
          max-width: 100%;
          min-width: max-content;
          white-space: pre;
          font-size: 13px;
          line-height: 1.55;
          font-family:
            ui-monospace,
            SFMono-Regular,
            Menlo,
            Monaco,
            Consolas,
            "Liberation Mono",
            "Courier New",
            monospace;
          -webkit-overflow-scrolling: touch;
        }

        .ajxParagraph,
        .ajxHeadingBlock,
        .ajxSummaryText,
        .ajxQuestionRow {
          min-width: max-content;
        }

        .ajxImageIntentBar {
          margin-top: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          min-width: 0;
          max-width: 100%;
        }

        .ajxImageIntentHint {
          width: 100%;
          font-size: 12px;
          font-weight: 800;
          color: rgba(11, 13, 18, 0.68);
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxIntentBtn {
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.86);
          color: #0b0d12;
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 900;
          cursor: pointer;
          transition:
            background 0.12s ease,
            border 0.12s ease,
            transform 0.12s ease,
            box-shadow 0.12s ease;
          max-width: 100%;
          min-width: 0;
        }

        .ajxIntentBtn:hover {
          transform: translateY(-1px);
          border-color: rgba(11, 13, 18, 0.16);
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.08);
        }

        .ajxIntentBtnActive {
          background: #0b0d12;
          color: #ffffff;
          border-color: #0b0d12;
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.14);
        }

        .ajxImageButtonWrap {
          display: inline-flex;
          align-items: center;
          min-width: 0;
          max-width: 100%;
        }

        .ajxQuickActionsWrap {
          padding: 0 20px 12px 20px;
          min-width: 0;
          max-width: 100%;
        }

        .ajxQuickActionsTitle {
          display: none;
        }

        .ajxQuickActionsRow {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          padding-bottom: 4px;
          scrollbar-width: thin;
          max-width: 100%;
        }

        .ajxQuickActionsRow::-webkit-scrollbar {
          height: 6px;
        }

        .ajxQuickActionBtn {
          flex: 0 0 auto;
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.9);
          color: #0b0d12;
          border-radius: 999px;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 900;
          cursor: pointer;
          white-space: nowrap;
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.08);
          transition:
            border 0.12s ease,
            box-shadow 0.12s ease,
            transform 0.12s ease,
            background 0.12s ease;
        }

        .ajxQuickActionBtn:hover {
          transform: translateY(-1px);
          border-color: rgba(11, 13, 18, 0.16);
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 14px 30px rgba(11, 13, 18, 0.1);
        }

        .ajxQuickActionLocked {
          opacity: 0.72;
          border-style: dashed;
          background: rgba(255, 255, 255, 0.72);
        }

        .ajxStatusNote {
          margin-top: 8px;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(11, 13, 18, 0.04);
          color: rgba(11, 13, 18, 0.78);
          font-size: 12px;
          font-weight: 800;
          line-height: 1.5;
          max-width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .ajxDisclaimerRow {
          margin-top: 10px;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
          justify-content: center;
          text-align: center;
          font-size: 11px;
          line-height: 1.45;
          color: rgba(11, 13, 18, 0.62);
          max-width: 100%;
          min-width: 0;
        }

        .ajxDisclaimerPlan {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid rgba(11, 13, 18, 0.1);
          background: rgba(255, 255, 255, 0.9);
          color: #0b0d12;
          font-size: 11px;
          font-weight: 950;
          letter-spacing: 0.2px;
          box-shadow: 0 10px 22px rgba(11, 13, 18, 0.08);
          max-width: 100%;
          min-width: 0;
        }        .ajxBubbleScroll {
          width: 100%;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: visible;
          -webkit-overflow-scrolling: touch;
        }

        .ajxBubbleScrollInner {
          min-width: max-content;
        }



                @media (max-width: 980px) {
          .ajxTopBar {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: nowrap;
          }

          .ajxTopControls {
            display: flex;
            gap: 6px;
            flex-wrap: nowrap;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
          }

          .ajxControlGroup {
            flex: 0 0 auto;
          }
        }
          .ajxTopControls {
            gap: 8px;
            width: 100%;
            justify-content: flex-start;
          }

          .ajxControlLabel {
            display: none;
          }

          .ajxControlGroup {
            gap: 6px;
            padding: 4px 6px;
            border-radius: 14px;
          }

          .ajxSelect {
            padding: 8px 28px 8px 10px;
            font-size: 12px;
            border-radius: 12px;
          }

          .ajxChevron {
            right: 10px;
            font-size: 11px;
          }
          .ajxControlGroup {
            padding: 5px;
          }

          .ajxParagraph,
          .ajxRichList,
          .ajxRichListOrdered,
          .ajxSummaryText,
          .ajxQuestionRow {
            line-height: 1.72;
          }

          .ajxCodePre {
            font-size: 12px;
          }

          .ajxOutputBody {
          margin: 0;
          padding: 14px 16px;
          white-space: pre;
          line-height: 1.7;
          font-size: 14px;
          font-family: inherit;
          max-width: 100%;
          min-width: max-content;
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }

        .ajxCodeBlockWrap {
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }

        .ajxCodePre {
          margin: 0;
          padding: 12px 14px;
          overflow-x: auto;
          overflow-y: hidden;
          max-width: 100%;
          min-width: max-content;
          white-space: pre;
          font-size: 13px;
          line-height: 1.55;
          font-family:
            ui-monospace,
            SFMono-Regular,
            Menlo,
            Monaco,
            Consolas,
            "Liberation Mono",
            "Courier New",
            monospace;
          -webkit-overflow-scrolling: touch;
        }
          .ajxActionBtn {
            width: 42px;
            height: 42px;
            border-radius: 14px;
            font-size: 16px;
          }

          .ajxSidebarToggleBtn {
            min-width: 42px;
            height: 42px;
            padding: 0 10px;
            border-radius: 14px;
          }

        .ajxParagraph,
        .ajxHeadingBlock,
        .ajxSummaryText,
        .ajxQuestionRow {
          min-width: max-content;
        }

          .ajxTopHelp {
          .ajxDisclaimerRow {
            margin-top: 8px;
            gap: 4px;
            font-size: 10px;
            line-height: 1.3;
          }

          .ajxDisclaimerPlan {
            padding: 3px 8px;
            font-size: 10px;
          }
            display: none;
          }

          .ajxComposerHelp {
            display: inline-flex;
            padding: 0 12px;
            height: 46px;
            border-radius: 16px;
          }

          .ajxComposerActions {
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: end;
            gap: 8px;
          }

          .ajxComposerCenter {
            grid-column: 1 / -1;
            grid-row: 1;
          }

          .ajxComposerLeft {
            grid-column: 1;
            grid-row: 2;
          }

          .ajxComposerRight {
            grid-column: 2;
            grid-row: 2;
            justify-content: flex-end;
          }

          .ajxSidebarToggleBtn {
            padding: 0 12px;
          }

          .ajxSidebarToggleText {
            display: none;
          }

          .ajxQuickActionsWrap {
            padding: 0 14px 10px 14px;
          }

          .ajxDisclaimerRow {
            padding-bottom: env(safe-area-inset-bottom, 0px);
          }
        }
      `}</style>

      <div
        className={styles.layout}
        style={
          isMobile
            ? {
                height: viewportHeight > 0 ? `${viewportHeight}px` : "100%",
                minHeight: 0,
                overflow: "hidden",
              }
            : undefined
        }
      >
        {isMobile && sidebarOpen ? (
          <button
            type="button"
            className="ajxSidebarBackdrop"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}

        <aside
          className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : styles.sidebarClosed}`}
        >
          <div className={styles.sidebarTop}>
            <div className={styles.brandMini}>
              <div>
                <div className={styles.brandMiniTitle}>{t(locale, "app.title")}</div>
                <div className={styles.brandMiniSub}>{t(locale, "ui.chats")}</div>
              </div>
            </div>

            <button className={styles.btnPrimarySmall} onClick={newChat}>
              {t(locale, "ui.new_chat")}
            </button>
          </div>

          <div className={styles.threadList}>
            {threads.map((th) => {
              const active = th.id === activeId;
              return (
                <div
                  key={th.id}
                  className={`${styles.threadItem} ${active ? styles.threadActive : ""}`}
                  onClick={() => setActiveThread(th.id)}
                  title={th.title}
                  role="button"
                >
                  <div className={styles.threadTitle}>{th.title}</div>
                  <div className={styles.threadMeta}>
                    <span>
                      {new Date(th.updatedAt).toLocaleDateString(
                        locale === "fi" ? "fi-FI" : locale === "es" ? "es-ES" : "en-US"
                      )}
                    </span>
                    <span>â€¢</span>
                    <span>
                      {th.messages.length} {t(locale, "ui.msg")}
                    </span>
                  </div>

                  <div className={styles.threadActions}>
                    <button
                      className={styles.btnTiny}
                      onClick={(e) => {
                        e.stopPropagation();
                        renameChat(th.id);
                      }}
                    >
                      {t(locale, "ui.rename")}
                    </button>
                    <button
                      className={styles.btnTinyDanger}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeChat(th.id);
                      }}
                    >
                      {t(locale, "ui.delete")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.sidebarBottom}>
            <div
              className={styles.sidebarPills}
              style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
            >
              <span className={styles.pill}>{planLabel}</span>
            </div>

            {effectiveCanonical === "free" ? (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                {freeCounterLabel}: {Number(usage?.msgThisMonth || 0)}/{FREE_DISPLAY_LIMIT}
              </div>
            ) : null}
          </div>
        </aside>

        <div
          className={styles.mainPane}
          style={
            isMobile
              ? {
                  minHeight: 0,
                  height: "100%",
                  overflow: "hidden",
                }
              : undefined
          }
        >
          <header className={styles.topbar} style={isMobile ? { display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", alignItems: "center", columnGap: "8px", rowGap: "0" } : undefined}>
            <div className={styles.topLeft} style={isMobile ? { minWidth: "auto", flex: "0 0 auto" } : undefined}>
              <button
                className={`${styles.btnGhost} ajxSidebarToggleBtn`}
                onClick={() => setSidebarOpen((v) => !v)}
                title={chatsLabel}
                aria-label={chatsLabel}
                type="button"
              >
                <span className="ajxSidebarToggleIcon">{sidebarOpen ? "\u2715" : "\u2630"}</span>
                <span className="ajxSidebarToggleText">{chatsLabel}</span>
              </button>

              <div className={styles.topTitle}>
                {!isMobile ? <div className={styles.title}>{activeTitle}</div> : null}
              </div>
            </div>

            <div className="ajxTopControls" style={isMobile ? { minWidth: 0, width: "100%", justifyContent: "flex-end", flexWrap: "nowrap", overflow: "hidden", gap: "6px", alignItems: "center" } : undefined}>
              <a
                href={`/help?lang=${locale}`}
                className="ajxHelpLink ajxTopHelp"
                title={helpLabel}
              >
                {helpLabel}
              </a>

              <div className="ajxControlGroup" aria-label={t(locale, "ui.ajx_mode")} style={isMobile ? { minWidth: 0, flex: "0 1 auto" } : undefined}>
                <div className="ajxControlLabel">{t(locale, "ui.ajx_mode")}</div>
                <div className="ajxSelectWrap">
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as AjxMode)}
                    className="ajxSelect"
                    title={t(locale, "ui.ajx_mode")}
                  >
                    {allowedModes.map((m) => (
                      <option key={m} value={m}>
                        {modeLabel(m, locale)}
                      </option>
                    ))}
                  </select>
                  <span className="ajxChevron">{"\u25BE"}</span>
                </div>
              </div>

              <div className="ajxControlGroup" aria-label={t(locale, "ui.language")} style={isMobile ? { minWidth: 0, flex: "0 0 auto" } : undefined}>
                <div className="ajxControlLabel">{t(locale, "ui.language")}</div>
                <div className="ajxSelectWrap">
                  <select
                    value={locale}
                    onChange={(e) => setLocaleAndPersist(e.target.value as Locale)}
                    className="ajxSelect"
                    title={t(locale, "ui.language")}
                  >
                    <option value="fi">FI</option>
                    <option value="en">EN</option>
                    <option value="es">ES</option>
                  </select>
                  <span className="ajxChevron">{"\u25BE"}</span>
                </div>
              </div>
            </div>
          </header>

          <main
            className={styles.main}
            style={
              isMobile
                ? {
                    minHeight: 0,
                    height: "100%",
                    overflow: "hidden",
                  }
                : undefined
            }
          >
            <section
              className={styles.chatCard}
              data-ajx-card-themed="true"
              style={
                isMobile
                  ? {
                      minHeight: 0,
                      height: "100%",
                      overflow: "hidden",
                    }
                  : undefined
              }
            >
              <div
                className={styles.msgList}
                style={
                  isMobile
                    ? {
                        minHeight: 0,
                        overflowY: "auto",
                        overflowX: "hidden",
                        WebkitOverflowScrolling: "touch",
                        paddingBottom:
                          composerHeight +
                          (showQuickActions ? 72 : 24) +
                          (keyboardInset > 0 ? 24 : 0),
                      }
                    : {
                        overflowX: "hidden",
                        paddingBottom: composerHeight + (showQuickActions ? 72 : 24),
                      }
                }
              >
                {showQuickActions && messages.length <= 1 ? (
                  <div className="ajxCompactTools">
                    <div className="ajxCompactTop">
                      <div>
                        <div className="ajxCompactKicker">AJX AI</div>
                        <div className="ajxCompactTitle">
                          {locale === "es"
                            ? "¿Qué quieres hacer?"
                            : locale === "en"
                              ? "What do you want to do?"
                              : "Mitä haluat tehdä?"}
                        </div>
                      </div>
                      <div className="ajxCompactPlan">{planLabel}</div>
                    </div>

                    <div className="ajxCompactGrid">
                      {quickActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className="ajxCompactToolBtn"
                          onClick={() => runQuickAction(action).catch(() => {})}
                        >
                          <span>{action.label}</span>
                          <b>→</b>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {messages.map((m, idx) => {
                  const isUser = m.role === "user";
                  const messageCopyKey = `msg-${m.ts}-${idx}`;
                  const messageTextForCopy = stripMarkdownImages(m.content || "");
                  const hasCopyableText = !!messageTextForCopy.trim();

                  return (
                    <div
                      key={`${m.ts}-${idx}`}
                      className={`${styles.msgRow} ${
                        isUser ? (styles as any).rowUser : (styles as any).rowAi
                      }`}
                    >
                      <div className={isUser ? styles.avatarUser : styles.avatarAi}>
                        {isUser ? "U" : "A"}
                      </div>

                      <div
                        className={`${styles.bubble} ${
                          isUser ? styles.bubbleUser : styles.bubbleAi
                        }`}
                        style={{
                          minWidth: 0,
                          maxWidth: "100%",
                          overflow: "hidden",
                        }}
                      >
                        {hasCopyableText ? (
                          <div className="ajxBubbleTop">
                            <button
                              type="button"
                              className="ajxCopyBtn"
                              onClick={() => handleCopy(messageTextForCopy, messageCopyKey)}
                              title={copyLabel(locale, copiedKey === messageCopyKey)}
                            >
                              {copyLabel(locale, copiedKey === messageCopyKey)}
                            </button>
                          </div>
                        ) : null}

                        {renderMessageContent(m.content, isUser)}
                        {renderImagesFromContent(m.content)}
                      </div>

                      <div className={styles.rightSlot} />
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {false && showQuickActions ? (
                <div className="ajxQuickActionsWrap">
                  <div className="ajxQuickActionsRow">
                    {quickActions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className={`ajxQuickActionBtn ${effectiveCanonical === "free" ? "ajxQuickActionLocked" : ""}`}
                        onClick={() => runQuickAction(action).catch(() => {})}
                      >
                        {effectiveCanonical === "free" ? `\uD83D\uDD12 ${action.label}` : action.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div
                ref={composerRef}
                className={styles.composer}
                data-ajx-themed="true"
                style={{
                  bottom: 0,
                  transition: "none",
                  zIndex: isMobile ? 40 : undefined,
                  paddingBottom: isMobile
                    ? "max(0px, env(safe-area-inset-bottom, 0px))"
                    : undefined,
                }}
              >
                <div className={styles.composerInner}>

                  <div className="ajxComposerActions">
                    <div className="ajxComposerLeft">
                      {canOpenPlusMenu ? (
                        <button
                          ref={plusBtnRef}
                          className={`${styles.btnGhost} ajxActionBtn`}
                          onClick={() => setPlusOpen((v) => !v)}
                          disabled={loading}
                          title={t(locale, "ui.plus")}
                          aria-label={t(locale, "ui.plus")}
                          type="button"
                        >
                          +
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="ajxToolsIconBtn"
                        onClick={() => setToolsOpen((v) => !v)}
                        title="Työkalut"
                        aria-label="Työkalut"
                      >
                        ✦
                      </button>

                      {showImageButton ? (
                        <div ref={imageButtonWrapRef} className="ajxImageButtonWrap">
                          <ImageButton
                            disabled={loading}
                            devPlan={devPlan}
                            getPrompt={() => input}
                            getSourceImage={() =>
                              canEditImages && firstPendingImage
                                ? {
                                    name: firstPendingImage.name,
                                    type: firstPendingImage.type,
                                    dataUrl: firstPendingImage.dataUrl,
                                  }
                                : null
                            }
                            clearPrompt={() => setInput("")}
                            onStatus={(txt) => {
                              const s = String(txt || "").trim();
                              if (!s) return;

                              const isMdImage = /!\[[^\]]*\]\(\s*([^)]+)\s*\)/.test(s);
                              const low = s.toLowerCase();

                              if (isMdImage) {
                                setImageStatus(
                                  locale === "fi"
                                    ? "âœ… Kuva luotu tai muokattu."
                                    : locale === "es"
                                      ? "âœ… Imagen creada o editada."
                                      : "âœ… Image created or edited."
                                );
                                appendAssistantMessage(s);
                                setManualImageIntent(null);
                                return;
                              }

                              setImageStatus(s);

                              if (
                                low.includes("http") ||
                                low.includes("data:image") ||
                                low.includes("virhe") ||
                                low.includes("error") ||
                                low.includes("kiintiÃ¶") ||
                                low.includes("pÃ¤ivitÃ¤") ||
                                low.includes("ei ole kÃ¤ytÃ¶ssÃ¤") ||
                                low.includes("quota")
                              ) {
                                appendAssistantMessage(s);
                              }
                            }}
                          />
                        </div>
                      ) : null}
                    </div>

                    <div className="ajxComposerCenter">
                      <textarea
                        ref={inputRef}
                        className={`${styles.input} ajxComposerText`}
                        value={input}
                        onChange={(e) => {
                          setInput(e.target.value);
                          const el = e.target;
                          el.style.height = "auto";
                          el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
                        }}
                        onFocus={() => {
                          setInputFocused(true);
                          if (isMobile) {
                            window.setTimeout(() => {
                              scrollToBottom(true);
                            }, 120);
                          }
                        }}
                        onBlur={() => {
                          setInputFocused(false);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder={composerTextPlaceholder}
                        rows={1}
                        disabled={loading}
                        enterKeyHint="send"
                      />
                    </div>

                    <div className="ajxComposerRight">
                      <button
                        type="button"
                        className="ajxToolsIconBtn"
                        onClick={() => setToolsOpen((v) => !v)}
                        title="Työkalut"
                        aria-label="Työkalut"
                      >
                        ⚡
                      </button>
                      <a
                        href={`/help?lang=${locale}`}
                        className="ajxHelpLink ajxComposerHelp"
                        title={helpLabel}
                      >
                        {helpLabel}
                      </a>

                      <button
                        className={`${styles.btnGhost} ajxActionBtn`}
                        type="button"
                        onClick={insertLineBreak}
                        disabled={loading}
                        title={
                          locale === "fi"
                            ? "LisÃ¤Ã¤ rivinvaihto"
                            : locale === "es"
                              ? "Insertar salto de lÃ­nea"
                              : "Insert line break"
                        }
                        aria-label={
                          locale === "fi"
                            ? "LisÃ¤Ã¤ rivinvaihto"
                            : locale === "es"
                              ? "Insertar salto de lÃ­nea"
                              : "Insert line break"
                        }
                      >
                        ↵
                      </button>

                      <button
                        className={`${styles.btnPrimarySmall} ajxActionBtn`}
                        onClick={() => sendMessage().catch(() => {})}
                        disabled={sendDisabled}
                        title={t(locale, "chat.send")}
                        aria-label={t(locale, "chat.send")}
                        type="button"
                      >
                        <span
                          style={{
                            display: "block",
                            lineHeight: 1,
                            fontSize: 18,
                            fontWeight: 900,
                            color: sendDisabled ? "#0b0d12" : "#ffffff",
                          }}
                        >
                          ➤
                        </span>
                      </button>
                    </div>
                  </div>

                  {toolsOpen ? (
                    <div className="ajxToolsDrawer ajxToolsDrawerMoved">
                      {quickActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className="ajxToolsDrawerBtn"
                          onClick={() => {
                            setToolsOpen(false);
                            runQuickAction(action).catch(() => {});
                          }}
                        >
                          <span>{action.label}</span>
                          <b>→</b>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {toolsOpen ? (
                    <div className="ajxToolsDrawer ajxToolsDrawerMoved">
                      {quickActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className="ajxToolsDrawerBtn"
                          onClick={() => {
                            setToolsOpen(false);
                            runQuickAction(action).catch(() => {});
                          }}
                        >
                          <span>{action.label}</span>
                          <b>→</b>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {hasPendingImage ? (
                    <div className="ajxImageIntentBar">
                      <div className="ajxImageIntentHint">{imageIntentHint}</div>

                      <button
                        type="button"
                        className={`ajxIntentBtn ${
                          effectiveImageIntent === "analyze" ? "ajxIntentBtnActive" : ""
                        }`}
                        onClick={() => setManualImageIntent("analyze")}
                      >
                        {locale === "fi"
                          ? "Analysoi kuva"
                          : locale === "es"
                            ? "Analizar imagen"
                            : "Analyze image"}
                      </button>

                      {canEditImages ? (
                        <button
                          type="button"
                          className={`ajxIntentBtn ${
                            effectiveImageIntent === "edit" ? "ajxIntentBtnActive" : ""
                          }`}
                          onClick={() => setManualImageIntent("edit")}
                        >
                          {locale === "fi"
                            ? "Muokkaa kuvaa"
                            : locale === "es"
                              ? "Editar imagen"
                              : "Edit image"}
                        </button>
                      ) : null}

                      {manualImageIntent ? (
                        <button
                          type="button"
                          className="ajxIntentBtn"
                          onClick={() => setManualImageIntent(null)}
                        >
                          Auto
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <input
                    ref={imgInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      try {
                        await addAttachmentFromFile(f, "image");
                      } catch (err: any) {
                        appendAssistantMessage(
                          err?.message
                            ? String(err.message)
                            : locale === "fi"
                              ? "Kuvan liittÃ¤minen epÃ¤onnistui."
                              : locale === "es"
                                ? "No se pudo adjuntar la imagen."
                                : "Failed to attach image."
                        );
                      } finally {
                        setPlusOpen(false);
                        focusInputSoon();
                      }
                    }}
                  />

                  <input
                    ref={fileInputRef}
                    type="file"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      try {
                        await addAttachmentFromFile(f, "file");
                      } catch (err: any) {
                        appendAssistantMessage(
                          err?.message
                            ? String(err.message)
                            : locale === "fi"
                              ? "Tiedoston liittÃ¤minen epÃ¤onnistui."
                              : locale === "es"
                                ? "No se pudo adjuntar el archivo."
                                : "Failed to attach file."
                        );
                      } finally {
                        setPlusOpen(false);
                        focusInputSoon();
                      }
                    }}
                  />

                  {pending.length > 0 ? (
                    <div className="ajxChips">
                      {pending.map((p) => (
                        <div key={p.id} className="ajxChip" title={p.type}>
                          <span>{p.kind === "image" ? "ðŸ–¼ï¸" : "ðŸ“Ž"}</span>
                          <span className="ajxChipName">{p.name}</span>
                          <button
                            className={styles.btnTinyDanger}
                            onClick={() => removeAttachmentChip(p.id)}
                            title={t(locale, "ui.attach_clear")}
                            style={{ padding: "4px 8px" }}
                            type="button"
                          >
                            Ã—
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {imageStatus ? <div className="ajxStatusNote">{imageStatus}</div> : null}
                  

                  <div className="ajxDisclaimerRow">
                    <span>{isMobile ? (locale === "es" ? "AJX AI puede cometer errores. Verifica siempre la información importante." : locale === "en" ? "AJX AI can make mistakes. Always verify important information." : "AJX AI voi tehdä virheitä. Tarkista tiedot aina.") : disclaimerText}</span>
                    <span className="ajxDisclaimerPlan">{planMiniText}</span>
                  </div>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>

      {plusOpen && plusMenuPos.open ? (
        <div
          ref={plusMenuRef}
          className="ajxMenuCard"
          style={{
            position: "fixed",
            left: plusMenuPos.left,
            top: plusMenuPos.top,
            zIndex: 9999,
            width: plusMenuPos.width,
            maxWidth: "calc(100vw - 24px)",
          }}
        >
          {canAttachImagesForAnalysis ? (
          <button
            className={`${styles.btnGhost} ajxMenuItem`}
            onClick={() => {
              setPlusOpen(false);
              requestAnimationFrame(() => imgInputRef.current?.click());
            }}
            type="button"
          >
            {t(locale, "ui.attach_image")}
          </button>
        ) : null}

          <button
            className={`${styles.btnGhost} ajxMenuItem`}
            onClick={() => {
              setPlusOpen(false);
              requestAnimationFrame(() => fileInputRef.current?.click());
            }}
            title={attachFileMenuLabel(locale)}
            type="button"
          >
            {attachFileMenuLabel(locale)}
          </button>

          {showWebButton ? (
            <button
              className={`${styles.btnGhost} ajxMenuItem`}
              onClick={() => {
                setPlusOpen(false);
                setForceWebNext(true);
                focusInputSoon();
              }}
              title={t(locale, "ui.web_search")}
              type="button"
            >
              ðŸŒ {t(locale, "ui.web_search")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}










































