"use client";

import { useState } from "react";

export default function TestPage() {
  const [message, setMessage] = useState("Sano moi ja kerro että AJX AI toimii.");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function send() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      setResult({ status: res.status, data });
    } catch (e: any) {
      setResult({ status: "NETWORK_ERROR", error: String(e?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 16, fontFamily: "system-ui" }}>
      <h1>AJX AI – Test</h1>

      <p>Kirjoita viesti ja lähetä /api/chat endpointille.</p>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        style={{ width: "100%", maxWidth: 720, padding: 8 }}
      />

      <div style={{ marginTop: 8 }}>
        <button onClick={send} disabled={loading} style={{ padding: "8px 12px" }}>
          {loading ? "Lähetetään..." : "Lähetä"}
        </button>
      </div>

      <pre style={{ marginTop: 16, background: "#f5f5f5", padding: 12, maxWidth: 720, overflow: "auto" }}>
        {result ? JSON.stringify(result, null, 2) : "Ei tulosta vielä."}
      </pre>
    </main>
  );
}
