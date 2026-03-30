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
const MAX_NON_IMAGE_FILE_BYTES = 4_000_000;

// ====== Canonical plans (UI) ======
type CanonicalPlan = "free" | "basic" | "plus" | "pro" | "company";
const FREE_DISPLAY_LIMIT = 20;

type ImageIntentChoice = "analyze" | "edit" | null;

type QuickAction = {
  id: string;
  label: string;
  prompt: string;
  mode: AjxMode;
};

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
        <img key={`${u}-${i}`} src={u} alt="AJX Image" className={styles.inlineImage} />
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
  return /^(\-|\*|•)\s+/.test(line.trim());
}

function isOrderedLine(line: string) {
  return /^\d+[\.\)]\s+/.test(line.trim());
}

function isDividerLine(line: string) {
  return /^(-{3,}|—\s*—\s*—)$/.test(line.trim());
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
  return /[?？]$/.test(s);
}

function normalizeDetachedOrderedMarkers(text: string): string {
  if (!text) return "";

  return text.replace(/(^|\n)(\d+[\.\)])\s*\n+(?=\S)/g, "$1$2 ");
}

function normalizeInlineListSequences(text: string): string {
  if (!text) return "";

  return normalizeDetachedOrderedMarkers(text)
    .replace(/:\s+(\d+[\.\)]\s)/g, ":\n\n$1")
    .replace(/([?？!])\s+(\d+[\.\)]\s)/g, "$1\n\n$2")
    .replace(/([^\n])\s+(•\s)/g, "$1\n$2")
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
  return line.trim().replace(/^(\-|\*|•)\s+/, "");
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
    return cleaned === "yhteenveto" || cleaned === "tiivistelmä" || cleaned === "lyhyesti";
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
      s.startsWith("tiivistelmä:") ||
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

function renderPlainRichText(text: string, locale: Locale) {
  const content = stripMarkdownImages(text || "");
  if (!content) return null;

  const normalized = normalizeInlineListSequences(
    content.replace(/\r\n/g, "\n").replace(/\n?---\n?/g, "\n— — —\n")
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
          }}
        >
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: "0 0 6px 0" }}>
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
          }}
        >
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: "0 0 6px 0" }}>
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
        items.push(candidate);
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
            }}
          >
            {items.map((item, idx) => (
              <div
                key={idx}
                className="ajxQuestionRow"
                style={{
                  lineHeight: 1.68,
                  fontWeight: 700,
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

  return <div className={styles.bubbleText}>{out}</div>;
}

function RichMessage({
  text,
  locale,
  onCopy,
  copiedKey,
}: {
  text: string;
  locale: Locale;
  onCopy: (value: string, key: string) => void;
  copiedKey: string;
}) {
  const content = stripMarkdownImages(text || "");
  if (!content) return null;

  const segments = parseCodeBlocks(content);

  return (
    <div className={styles.bubbleText}>
      {segments.map((segment, idx) => {
        if (segment.type === "text") {
          const rendered = renderPlainRichText(segment.value, locale);
          return <React.Fragment key={`seg-text-${idx}`}>{rendered}</React.Fragment>;
        }

        const langLabel = segment.language || "code";
        const copyKey = `code-${idx}-${langLabel}-${segment.code.length}`;

        return (
          <div key={`seg-code-${idx}`} className="ajxCodeBlockWrap">
            <div className="ajxCodeToolbar">
              <span className="ajxCodeLang">{langLabel}</span>
              <button
                type="button"
                className="ajxCopyBtn"
                onClick={() => onCopy(segment.code, copyKey)}
                title={copyLabel(locale, copiedKey === copyKey)}
              >
                {copyLabel(locale, copiedKey === copyKey)}
              </button>
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
    /\btee tästä\b/,
    /\bvaihda\b/,
    /\blisää\b/,
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
    /\bañade\b/,
    /\bquita\b/,
    /\brecorta\b/,
    /\bmejora\b/,
    /\ben blanco y negro\b/,
  ];

  const analyzePatterns = [
    /\bmitä kuvassa\b/,
    /\bmitä tässä\b/,
    /\bmitä näet\b/,
    /\banalysoi\b/,
    /\barvioi\b/,
    /\btunnista\b/,
    /\bmikä auto\b/,
    /\bmikä tämä on\b/,
    /\bkerro kuvasta\b/,
    /\bkuvaile\b/,
    /\bonko tämä\b/,
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
    /\bqué hay en la imagen\b/,
    /\bqué ves\b/,
    /\bque ves\b/,
    /\banaliza\b/,
    /\bdescribe\b/,
    /\bidentifica\b/,
    /\bqué coche\b/,
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
      {
        id: "offer",
        label: "Crear oferta",
        prompt: "Ayúdame a crear una oferta clara y convincente para un cliente.",
        mode: "research",
      },
      {
        id: "sales",
        label: "Aumentar ventas",
        prompt: "Ayúdame a encontrar formas prácticas de aumentar mis ventas.",
        mode: "analysis",
      },
      {
        id: "customers",
        label: "Encontrar clientes",
        prompt: "Ayúdame a encontrar clientes potenciales para mi negocio.",
        mode: "research",
      },
      {
        id: "marketing",
        label: "Mejorar marketing",
        prompt: "Ayúdame a mejorar mi marketing de forma práctica.",
        mode: "ideation",
      },
      {
        id: "pricing",
        label: "Mejorar precios",
        prompt: "Analiza mi pricing y ayúdame a mejorarlo.",
        mode: "analysis",
      },
      {
        id: "problem",
        label: "Resolver problema",
        prompt: "Ayúdame a resolver un problema de negocio paso a paso.",
        mode: "analysis",
      },
    ];
  }

  if (locale === "en") {
    return [
      {
        id: "offer",
        label: "Create offer",
        prompt: "Help me create a clear and convincing offer for a client.",
        mode: "research",
      },
      {
        id: "sales",
        label: "Grow sales",
        prompt: "Help me find practical ways to grow my sales.",
        mode: "analysis",
      },
      {
        id: "customers",
        label: "Find customers",
        prompt: "Help me find potential customers for my business.",
        mode: "research",
      },
      {
        id: "marketing",
        label: "Improve marketing",
        prompt: "Help me improve my marketing in a practical way.",
        mode: "ideation",
      },
      {
        id: "pricing",
        label: "Improve pricing",
        prompt: "Analyze my pricing and help me improve it.",
        mode: "analysis",
      },
      {
        id: "problem",
        label: "Solve problem",
        prompt: "Help me solve a business problem step by step.",
        mode: "analysis",
      },
    ];
  }

  return [
    {
      id: "offer",
      label: "Luo tarjous",
      prompt: "Auta minua luomaan selkeä ja myyvä tarjous asiakkaalle.",
      mode: "research",
    },
    {
      id: "sales",
      label: "Kasvata myyntiä",
      prompt: "Auta minua löytämään käytännöllisiä tapoja kasvattaa myyntiä.",
      mode: "analysis",
    },
    {
      id: "customers",
      label: "Löydä asiakkaita",
      prompt: "Auta minua löytämään potentiaalisia asiakkaita yritykselleni.",
      mode: "research",
    },
    {
      id: "marketing",
      label: "Paranna markkinointia",
      prompt: "Auta minua parantamaan markkinointia käytännöllisesti.",
      mode: "ideation",
    },
    {
      id: "pricing",
      label: "Paranna hinnoittelua",
      prompt: "Analysoi nykyinen hinnoitteluni ja auta parantamaan sitä.",
      mode: "analysis",
    },
    {
      id: "problem",
      label: "Ratkaise yritysongelma",
      prompt: "Auta minua ratkaisemaan yritysongelma askel askeleelta.",
      mode: "analysis",
    },
  ];
}

function quickActionQuestionInstruction(action: QuickAction, locale: Locale): string {
  if (locale === "es") {
    return [
      `MODO_PIKATOIMINTO: ${action.id}`,
      "No des una respuesta larga ni un plan final todavía.",
      "Haz primero exactamente 3–5 preguntas cortas y concretas para recopilar la información necesaria.",
      "Presenta solo esas preguntas, numeradas.",
      "No expliques tu razonamiento.",
      "No añadas resumen, introducción larga ni propuesta final todavía.",
      "Cuando el usuario responda, entonces crea la oferta, el plan o la solución basándote en sus respuestas.",
    ].join("\n");
  }

  if (locale === "en") {
    return [
      `QUICK_ACTION_MODE: ${action.id}`,
      "Do not give a long answer or a final plan yet.",
      "First ask exactly 3–5 short, concrete questions needed to complete the task.",
      "Output only those questions as a numbered list.",
      "Do not explain your reasoning.",
      "Do not add a summary, long intro, or final proposal yet.",
      "After the user answers, then create the offer, plan, or solution based on those answers.",
    ].join("\n");
  }

  return [
    `PIKATOIMINTO_TILA: ${action.id}`,
    "Älä anna vielä pitkää vastausta tai valmista suunnitelmaa.",
    "Kysy ensin täsmälleen 3–5 lyhyttä ja konkreettista kysymystä, joilla keräät tarvittavat tiedot.",
    "Tulosta vain nuo kysymykset numeroituna listana.",
    "Älä selitä ajatteluasi.",
    "Älä lisää yhteenvetoa, pitkää johdantoa tai lopullista tarjousta vielä.",
    "Kun käyttäjä vastaa, tee vasta sitten tarjous, suunnitelma tai ratkaisu vastausten perusteella.",
  ].join("\n");
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
      reject(new Error("Kuvan lukeminen epäonnistui."));
    };

    img.src = objectUrl;
  });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Kuvan pakkaus epäonnistui."));
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
      throw new Error("SVG-kuva on liian suuri. Käytä pienempää kuvaa.");
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
    throw new Error("Canvas ei ole käytettävissä.");
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
    throw new Error("Kuvan pakkaus epäonnistui.");
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

export default function ChatPage(): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>("fi");

  const titleDefault = useMemo(() => t(locale, "thread.title_default"), [locale]);
  const greeting = useMemo(() => t(locale, "chat.greeting"), [locale]);

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

  const [, setImageStatus] = useState<string>("");

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
  }, [input, pending.length, locale, loading, showQuickActions, keyboardInset, plan]);

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
        <div className={styles.bubbleText} style={{ whiteSpace: "pre-wrap" }}>
          {stripped || ""}
        </div>
      );
    }

    return (
      <RichMessage
        text={stripped}
        locale={locale}
        onCopy={handleCopy}
        copiedKey={copiedKey}
      />
    );
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
              ? "La imagen es demasiado grande. Elige una imagen más pequeña."
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

    const convoForBackend = buildBackendMessages(backendUserContent);

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
          stream: false,
          useWeb: useWebComputed,
          imagesRequested: 0,
          messages: convoForBackend,
          locale,
          rolesEnabled: true,
          role: modeToRole(usedMode),
          attachments: pending.map((p) => ({
            kind: p.kind,
            name: p.name,
            type: p.type,
            dataUrl: p.dataUrl,
          })),
        }),
      });

      const ct = res.headers.get("content-type") || "";

      setPending([]);
      setForceWebNext(false);
      setManualImageIntent(null);

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

      if (!ct.includes("application/json")) {
        const tt = await res.text().catch(() => "");
        const nextMsgs = [
          ...optimistic,
          {
            role: "assistant" as const,
            content: tt || "(Virhe: odotettiin JSON)",
            ts: nowTs(),
          },
        ];
        setMessages(nextMsgs);
        persistActive(nextMsgs);
        await fetchStats(devPlan).catch(() => {});
        return;
      }

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
      scrollToBottom();
      focusInputSoon();
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && pending.length === 0) || loading) return;

    if (hasPendingImage && text) {
      if (effectiveImageIntent === "edit") {
        const ok = triggerImageButton();
        if (!ok) {
          appendAssistantMessage(
            locale === "fi"
              ? "Kuvan muokkausnappia ei löytynyt. Kokeile painaa kuvan generointinappia kerran."
              : locale === "es"
                ? "No se encontró el botón de edición de imagen. Prueba a pulsar el botón de generación una vez."
                : "Image edit button was not found. Try pressing the image generation button once."
          );
        }
        return;
      }

      if (effectiveImageIntent === null) {
        appendAssistantMessage(
          locale === "fi"
            ? "Valitse ensin haluatko analysoida kuvan vai muokata sitä."
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
    setMode(action.mode);
    await sendTextDirect(
      action.prompt,
      action.mode,
      quickActionQuestionInstruction(action, locale)
    );
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
          ? "Interpretación: edición de imagen"
          : "Interpretation: image editing";
    }

    if (effectiveImageIntent === "analyze") {
      return locale === "fi"
        ? "Tulkinta: kuvan analyysi"
        : locale === "es"
          ? "Interpretación: análisis de imagen"
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
        .ajxTopControls {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
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
        }

        .ajxChips {
          margin-top: 8px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
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
          max-width: 420px;
        }

        .ajxChipName {
          max-width: 260px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
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
        }

        .ajxComposerLeft {
          grid-column: 1;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          align-self: end;
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
        }

        .ajxComposerText {
          width: 100%;
          min-width: 0;
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
        }

        .ajxHeadingBlock {
          margin: 18px 0 12px;
          font-size: 15px;
          font-weight: 950;
          line-height: 1.35;
        }

        .ajxRichList,
        .ajxRichListOrdered {
          margin: 0 0 16px 0;
          padding-left: 20px;
          line-height: 1.68;
        }

        .ajxRichList li,
        .ajxRichListOrdered li {
          margin: 0 0 6px 0;
        }

        .ajxQuestionList {
          margin: 0 0 16px 0;
        }

        .ajxQuestionRow {
          line-height: 1.68;
          font-weight: 700;
        }

        .ajxSummaryBox {
          margin: 4px 0 16px 0;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(11, 13, 18, 0.04);
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
          margin-bottom: 8px;
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
        }

        .ajxCodeToolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 10px;
          border-bottom: 1px solid rgba(11, 13, 18, 0.08);
          background: rgba(255, 255, 255, 0.5);
        }

        .ajxCodeLang {
          font-size: 11px;
          font-weight: 950;
          letter-spacing: 0.2px;
          opacity: 0.72;
          text-transform: uppercase;
        }

        .ajxCodePre {
          margin: 0;
          padding: 12px 14px;
          overflow-x: auto;
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

        .ajxImageIntentBar {
          margin-top: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }

        .ajxImageIntentHint {
          width: 100%;
          font-size: 12px;
          font-weight: 800;
          color: rgba(11, 13, 18, 0.68);
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
        }

        .ajxQuickActionsWrap {
          padding: 0 20px 12px 20px;
        }

        .ajxQuickActionsTitle {
          display: none;
        }

        .ajxQuickActionsRow {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          padding-bottom: 4px;
          scrollbar-width: thin;
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
        }

        @media (max-width: 980px) {
          .ajxTopControls {
            gap: 8px;
            width: 100%;
            justify-content: flex-start;
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

          .ajxTopHelp {
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
                    <span>•</span>
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
          <header className={styles.topbar}>
            <div className={styles.topLeft}>
              <button
                className={`${styles.btnGhost} ajxSidebarToggleBtn`}
                onClick={() => setSidebarOpen((v) => !v)}
                title={chatsLabel}
                aria-label={chatsLabel}
                type="button"
              >
                <span className="ajxSidebarToggleIcon">{sidebarOpen ? "✕" : "☰"}</span>
                <span className="ajxSidebarToggleText">{chatsLabel}</span>
              </button>

              <div className={styles.topTitle}>
                <div className={styles.title}>{activeTitle}</div>
              </div>
            </div>

            <div className="ajxTopControls">
              <a
                href={`/help?lang=${locale}`}
                className="ajxHelpLink ajxTopHelp"
                title={helpLabel}
              >
                {helpLabel}
              </a>

              <div className="ajxControlGroup" aria-label={t(locale, "ui.ajx_mode")}>
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
                  <span className="ajxChevron">▾</span>
                </div>
              </div>

              <div className="ajxControlGroup" aria-label={t(locale, "ui.language")}>
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
                  <span className="ajxChevron">▾</span>
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
                        WebkitOverflowScrolling: "touch",
                        paddingBottom:
                          composerHeight +
                          (showQuickActions ? 72 : 24) +
                          (keyboardInset > 0 ? 24 : 0),
                      }
                    : {
                        paddingBottom: composerHeight + (showQuickActions ? 72 : 24),
                      }
                }
              >
                {messages.map((m, idx) => {
                  const isUser = m.role === "user";
                  const messageCopyKey = `msg-${m.ts}-${idx}`;
                  const messageTextForCopy = stripMarkdownImages(m.content || "");

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
                      >
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

                        {renderMessageContent(m.content, isUser)}
                        {renderImagesFromContent(m.content)}
                      </div>

                      <div className={styles.rightSlot} />
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {showQuickActions ? (
                <div className="ajxQuickActionsWrap">
                  <div className="ajxQuickActionsRow">
                    {quickActions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className="ajxQuickActionBtn"
                        onClick={() => runQuickAction(action).catch(() => {})}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div
                ref={composerRef}
                className={styles.composer}
                style={{
                  bottom: 0,
                  transition: "none",
                  zIndex: isMobile ? 40 : undefined,
                  paddingBottom: isMobile ? "max(0px, env(safe-area-inset-bottom, 0px))" : undefined,
                }}
              >
                <div className={styles.composerInner}>
                  <div className="ajxComposerActions">
                    <div className="ajxComposerLeft">
                      <button
                        ref={plusBtnRef}
                        className={`${styles.btnGhost} ajxActionBtn`}
                        onClick={() => setPlusOpen((v) => !v)}
                        disabled={loading}
                        title={t(locale, "ui.plus")}
                        aria-label={t(locale, "ui.plus")}
                        type="button"
                      >
                        ＋
                      </button>

                      {showImageButton ? (
                        <div ref={imageButtonWrapRef} className="ajxImageButtonWrap">
                          <ImageButton
                            disabled={loading}
                            devPlan={devPlan}
                            getPrompt={() => input}
                            getSourceImage={() =>
                              firstPendingImage
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
                                    ? "✅ Kuva luotu tai muokattu."
                                    : locale === "es"
                                      ? "✅ Imagen creada o editada."
                                      : "✅ Image created or edited."
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
                                low.includes("kiintiö") ||
                                low.includes("päivitä") ||
                                low.includes("ei ole käytössä") ||
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
                            ? "Lisää rivinvaihto"
                            : locale === "es"
                              ? "Insertar salto de línea"
                              : "Insert line break"
                        }
                        aria-label={
                          locale === "fi"
                            ? "Lisää rivinvaihto"
                            : locale === "es"
                              ? "Insertar salto de línea"
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
                              ? "Kuvan liittäminen epäonnistui."
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
                              ? "Tiedoston liittäminen epäonnistui."
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
                          <span>{p.kind === "image" ? "🖼️" : "📎"}</span>
                          <span className="ajxChipName">{p.name}</span>
                          <button
                            className={styles.btnTinyDanger}
                            onClick={() => removeAttachmentChip(p.id)}
                            title={t(locale, "ui.attach_clear")}
                            style={{ padding: "4px 8px" }}
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="ajxDisclaimerRow">
                    <span>{disclaimerText}</span>
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
            type="button"
          >
            {t(locale, "ui.attach_file")}
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
              🌍 {t(locale, "ui.web_search")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}