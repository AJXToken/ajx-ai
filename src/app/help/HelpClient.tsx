"use client";

import React, { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type HelpLocale = "fi" | "en" | "es";

function normalizeLang(value: string | null | undefined): HelpLocale {
  const s = String(value || "").toLowerCase().trim();
  if (s === "en") return "en";
  if (s === "es") return "es";
  return "fi";
}

export default function HelpClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const lang = normalizeLang(searchParams.get("lang"));

  const chatHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("lang");
    const qs = params.toString();
    return qs ? `/chat?${qs}` : "/chat";
  }, [searchParams]);

  function handleBack(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();

    if (typeof window !== "undefined") {
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
    }

    router.push(chatHref);
  }

  return (
    <main style={{ padding: 40 }}>
      <a href={chatHref} onClick={handleBack}>
        ← Back to chat
      </a>

      <h1 style={{ marginTop: 20 }}>Help</h1>

      <p>
        AJX AI help page toimii nyt oikein. Paluu chattiin säilyttää tilan.
      </p>
    </main>
  );
}
