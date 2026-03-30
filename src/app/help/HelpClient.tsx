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

const copy = {
  fi: {
    brand: "AJX AI",
    title: "Ohjeet",
    intro:
      "AJX AI auttaa yrittäjiä ratkaisemaan ongelmia, kehittämään liiketoimintaa, luomaan sisältöä ja jäsentämään päätöksiä. Mitä tarkempi kysymys, sitä parempi vastaus.",
    backToChat: "← Takaisin chattiin",

    s1: "1. Miten aloittaa",
    s1p1: "Kirjoita chattiin mahdollisimman selkeästi mitä haluat saada aikaan.",
    goodExample: "Hyvä esimerkki",
    badExample: "Heikompi esimerkki",
    goodExampleText:
      "Minulla on ilmanvaihtoalan yritys Espanjassa. Anna 10 käytännön tapaa löytää uusia asiakkaita seuraavan 30 päivän aikana.",
    badExampleText: "Miten saan lisää asiakkaita?",

    s2: "2. Agentit",
    generalTitle: "Yleinen",
    generalText:
      "Rento keskustelu, yleiset kysymykset, luonnollinen apu ja arjen sparraus.",
    researchTitle: "Tiedonhaku",
    researchText:
      "Suora ja faktapainotteinen tapa etsiä tietoa, vertailla vaihtoehtoja ja selittää asioita selkeästi.",
    ideationTitle: "Ideointi",
    ideationText:
      "Innostava ja luova agentti ideoihin, markkinointiin, sisältöihin, kampanjoihin ja uusiin näkökulmiin.",
    analysisTitle: "Analysointi",
    analysisText:
      "Rauhallinen ja looginen agentti vertailuihin, numeroihin, riskeihin ja päätelmien tekemiseen.",
    strategyTitle: "Strategia",
    strategyText:
      "Suora ja liiketoimintakeskeinen agentti päätöksentukeen, suuntaan, priorisointiin ja kasvuun.",

    s3: "3. Mitä AJX AI:lla voi tehdä",
    s3items: [
      "kirjoittaa mainoksia ja myyntitekstejä",
      "luoda tarjouksia asiakkaille",
      "ideoida kampanjoita ja sisältöjä",
      "analysoida kilpailijoita",
      "jäsentää liiketoiminnan ongelmia",
      "pohtia hinnoittelua ja kasvua",
      "tiivistää pitkiä tekstejä ja aineistoja",
      "auttaa kuvien analysoinnissa",
    ],

    s4: "4. Promptivinkit",
    marketing: "Markkinointi",
    marketingPrompt:
      "Kirjoita Facebook-mainos ilmanvaihtoremontista Costa Blancan alueelle. Tee siitä selkeä, luotettava ja myyvä.",
    sales: "Myynti",
    salesPrompt:
      "Kirjoita asiakkaalle tarjous ilmanvaihtokartoituksesta. Sävy saa olla asiallinen mutta helposti lähestyttävä.",
    growth: "Kasvu",
    growthPrompt:
      "Anna 10 käytännön tapaa kasvattaa paikallisen palveluyrityksen myyntiä seuraavan 3 kuukauden aikana.",
    analysis: "Analyysi",
    analysisPrompt:
      "Vertaa kahta hinnoittelumallia ja kerro kummassa on parempi kate, parempi myyntipotentiaali ja pienempi riski.",

    s5: "5. Miten saada parempia vastauksia",
    s5items: [
      "kerro toimiala ja maa tai alue",
      "kerro mitä olet oikeasti yrittämässä saavuttaa",
      "anna tarvittaessa taustatiedot ja rajat",
      "pyydä vastaus tiettyyn muotoon, esimerkiksi 5 kohtaa tai valmis teksti",
      "jatka keskustelua tarkentamalla, älä aloita aina alusta",
    ],

    s6: "6. Huomioitavaa",
    s6items: [
      "AJX AI on työkalu, ei päätöksentekijä",
      "lopullinen vastuu liiketoiminta- ja investointipäätöksistä on aina käyttäjällä",
      "web-haku ja muut ominaisuudet riippuvat käytössä olevasta tasosta",
      "mitä parempi kysymys, sitä parempi lopputulos",
    ],
  },

  en: {
    brand: "AJX AI",
    title: "Help",
    intro:
      "AJX AI helps entrepreneurs solve problems, improve business, create content, and structure decisions. The more precise your question is, the better the answer will be.",
    backToChat: "← Back to chat",

    s1: "1. How to start",
    s1p1: "Write as clearly as possible what you want to achieve.",
    goodExample: "Good example",
    badExample: "Weaker example",
    goodExampleText:
      "I run a ventilation business in Spain. Give me 10 practical ways to find new customers during the next 30 days.",
    badExampleText: "How do I get more customers?",

    s2: "2. Agents",
    generalTitle: "General",
    generalText:
      "Relaxed conversation, general questions, natural help, and everyday sparring.",
    researchTitle: "Research",
    researchText:
      "A direct and fact-focused way to find information, compare options, and explain things clearly.",
    ideationTitle: "Ideation",
    ideationText:
      "An inspiring and creative agent for ideas, marketing, content, campaigns, and new angles.",
    analysisTitle: "Analysis",
    analysisText:
      "A calm and logical agent for comparisons, numbers, risks, and conclusions.",
    strategyTitle: "Strategy",
    strategyText:
      "A direct and business-focused agent for decision support, direction, prioritization, and growth.",

    s3: "3. What you can do with AJX AI",
    s3items: [
      "write ads and sales copy",
      "create offers for customers",
      "brainstorm campaigns and content",
      "analyze competitors",
      "structure business problems",
      "think through pricing and growth",
      "summarize long texts and materials",
      "help with image analysis",
    ],

    s4: "4. Prompt tips",
    marketing: "Marketing",
    marketingPrompt:
      "Write a Facebook ad for a ventilation renovation service in Costa Blanca. Make it clear, trustworthy, and persuasive.",
    sales: "Sales",
    salesPrompt:
      "Write a customer offer for a ventilation survey. The tone should be professional but approachable.",
    growth: "Growth",
    growthPrompt:
      "Give me 10 practical ways to grow the sales of a local service business over the next 3 months.",
    analysis: "Analysis",
    analysisPrompt:
      "Compare two pricing models and tell me which one has better margin, better sales potential, and lower risk.",

    s5: "5. How to get better answers",
    s5items: [
      "mention your industry and country or area",
      "say what you are actually trying to achieve",
      "give background details and limits when needed",
      "ask for a specific output format, for example 5 points or a ready-made text",
      "keep refining the discussion instead of always starting over",
    ],

    s6: "6. Important notes",
    s6items: [
      "AJX AI is a tool, not a decision-maker",
      "final responsibility for business and investment decisions always remains with the user",
      "web search and other features depend on your current plan",
      "the better the question, the better the result",
    ],
  },

  es: {
    brand: "AJX AI",
    title: "Ayuda",
    intro:
      "AJX AI ayuda a emprendedores a resolver problemas, desarrollar el negocio, crear contenido y estructurar decisiones. Cuanto más precisa sea tu pregunta, mejor será la respuesta.",
    backToChat: "← Volver al chat",

    s1: "1. Cómo empezar",
    s1p1: "Escribe lo más claramente posible lo que quieres conseguir.",
    goodExample: "Buen ejemplo",
    badExample: "Ejemplo más débil",
    goodExampleText:
      "Tengo una empresa de ventilación en España. Dame 10 formas prácticas de encontrar nuevos clientes durante los próximos 30 días.",
    badExampleText: "¿Cómo consigo más clientes?",

    s2: "2. Agentes",
    generalTitle: "General",
    generalText:
      "Conversación relajada, preguntas generales, ayuda natural y apoyo para el día a día.",
    researchTitle: "Búsqueda",
    researchText:
      "Una forma directa y orientada a hechos para buscar información, comparar opciones y explicar las cosas con claridad.",
    ideationTitle: "Ideación",
    ideationText:
      "Un agente inspirador y creativo para ideas, marketing, contenido, campañas y nuevos enfoques.",
    analysisTitle: "Análisis",
    analysisText:
      "Un agente tranquilo y lógico para comparaciones, cifras, riesgos y conclusiones.",
    strategyTitle: "Estrategia",
    strategyText:
      "Un agente directo y orientado al negocio para apoyo en decisiones, dirección, prioridades y crecimiento.",

    s3: "3. Qué puedes hacer con AJX AI",
    s3items: [
      "escribir anuncios y textos de venta",
      "crear ofertas para clientes",
      "idear campañas y contenido",
      "analizar competidores",
      "estructurar problemas del negocio",
      "reflexionar sobre precios y crecimiento",
      "resumir textos y materiales largos",
      "ayudar con el análisis de imágenes",
    ],

    s4: "4. Consejos para prompts",
    marketing: "Marketing",
    marketingPrompt:
      "Escribe un anuncio de Facebook para una reforma de ventilación en Costa Blanca. Hazlo claro, fiable y convincente.",
    sales: "Ventas",
    salesPrompt:
      "Escribe una oferta para un cliente sobre una inspección de ventilación. El tono debe ser profesional pero cercano.",
    growth: "Crecimiento",
    growthPrompt:
      "Dame 10 formas prácticas de aumentar las ventas de una empresa local de servicios durante los próximos 3 meses.",
    analysis: "Análisis",
    analysisPrompt:
      "Compara dos modelos de precios y dime cuál tiene mejor margen, mejor potencial de ventas y menor riesgo.",

    s5: "5. Cómo conseguir mejores respuestas",
    s5items: [
      "indica tu sector y el país o la zona",
      "explica qué estás intentando lograr realmente",
      "da contexto y límites cuando haga falta",
      "pide un formato concreto, por ejemplo 5 puntos o un texto listo para usar",
      "sigue afinando la conversación en lugar de empezar siempre desde cero",
    ],

    s6: "6. Importante",
    s6items: [
      "AJX AI es una herramienta, no un tomador de decisiones",
      "la responsabilidad final de las decisiones empresariales y de inversión siempre recae en el usuario",
      "la búsqueda web y otras funciones dependen del plan que estés usando",
      "cuanto mejor sea la pregunta, mejor será el resultado",
    ],
  },
};

export default function HelpClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const lang = normalizeLang(searchParams.get("lang"));
  const c = copy[lang];

  const chatHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("lang");
    const qs = params.toString();
    return qs ? `/chat?${qs}` : "/chat";
  }, [searchParams]);

  function handleBack(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();

    if (typeof window !== "undefined") {
      try {
        const ref = document.referrer || "";
        const sameOrigin = ref.startsWith(window.location.origin);

        if (sameOrigin) {
          const refUrl = new URL(ref);
          if (refUrl.pathname === "/chat" && window.history.length > 1) {
            window.history.back();
            return;
          }
        }
      } catch {}
    }

    router.push(chatHref);
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        background:
          "linear-gradient(180deg, #f6f7fb 0%, #eef1f6 55%, #e8ebf2 100%)",
        color: "#0b0d12",
        padding: "24px",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
      }}
    >
      <div
        style={{
          maxWidth: 920,
          margin: "0 auto",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <a href={chatHref} onClick={handleBack} style={topLinkStyle}>
            {c.backToChat}
          </a>
        </div>

        <div
          style={{
            background: "rgba(255,255,255,0.82)",
            border: "1px solid rgba(11,13,18,0.08)",
            borderRadius: 24,
            padding: 24,
            boxShadow: "0 28px 90px rgba(11,13,18,0.16)",
            backdropFilter: "blur(10px)",
          }}
        >
          <div style={{ marginBottom: 28 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                opacity: 0.65,
                marginBottom: 8,
              }}
            >
              {c.brand}
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: 34,
                lineHeight: 1.1,
                fontWeight: 950,
              }}
            >
              {c.title}
            </h1>

            <p
              style={{
                marginTop: 12,
                marginBottom: 0,
                fontSize: 16,
                lineHeight: 1.65,
                color: "rgba(11,13,18,0.72)",
                maxWidth: 760,
              }}
            >
              {c.intro}
            </p>
          </div>

          <Section title={c.s1}>
            <p style={pStyle}>{c.s1p1}</p>

            <div style={exampleBoxStyle}>
              <div style={exampleLabelStyle}>{c.goodExample}</div>
              <div style={exampleTextStyle}>{c.goodExampleText}</div>
            </div>

            <div style={exampleBoxStyle}>
              <div style={exampleLabelStyle}>{c.badExample}</div>
              <div style={exampleTextStyle}>{c.badExampleText}</div>
            </div>
          </Section>

          <Section title={c.s2}>
            <InfoCard title={c.generalTitle} text={c.generalText} />
            <InfoCard title={c.researchTitle} text={c.researchText} />
            <InfoCard title={c.ideationTitle} text={c.ideationText} />
            <InfoCard title={c.analysisTitle} text={c.analysisText} />
            <InfoCard title={c.strategyTitle} text={c.strategyText} />
          </Section>

          <Section title={c.s3}>
            <ul style={listStyle}>
              {c.s3items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>

          <Section title={c.s4}>
            <div style={gridStyle}>
              <PromptCard title={c.marketing} prompt={c.marketingPrompt} />
              <PromptCard title={c.sales} prompt={c.salesPrompt} />
              <PromptCard title={c.growth} prompt={c.growthPrompt} />
              <PromptCard title={c.analysis} prompt={c.analysisPrompt} />
            </div>
          </Section>

          <Section title={c.s5}>
            <ul style={listStyle}>
              {c.s5items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>

          <Section title={c.s6}>
            <ul style={listStyle}>
              {c.s6items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2
        style={{
          margin: "0 0 12px 0",
          fontSize: 22,
          lineHeight: 1.2,
          fontWeight: 900,
        }}
      >
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div style={cardStyle}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 900,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 15,
          lineHeight: 1.6,
          color: "rgba(11,13,18,0.74)",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function PromptCard({ title, prompt }: { title: string; prompt: string }) {
  return (
    <div style={cardStyle}>
      <div
        style={{
          fontSize: 15,
          fontWeight: 900,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: "rgba(11,13,18,0.78)",
          whiteSpace: "pre-wrap",
        }}
      >
        {prompt}
      </div>
    </div>
  );
}

const pStyle: React.CSSProperties = {
  margin: "0 0 14px 0",
  fontSize: 15,
  lineHeight: 1.7,
  color: "rgba(11,13,18,0.78)",
};

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  lineHeight: 1.9,
  fontSize: 15,
  color: "rgba(11,13,18,0.8)",
};

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(11,13,18,0.08)",
  background: "rgba(255,255,255,0.72)",
  borderRadius: 18,
  padding: 16,
  marginBottom: 12,
};

const exampleBoxStyle: React.CSSProperties = {
  border: "1px solid rgba(11,13,18,0.08)",
  background: "rgba(255,255,255,0.72)",
  borderRadius: 18,
  padding: 16,
  marginBottom: 12,
};

const exampleLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 900,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  color: "rgba(11,13,18,0.58)",
  marginBottom: 8,
};

const exampleTextStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.65,
  color: "rgba(11,13,18,0.82)",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gap: 12,
};

const topLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid rgba(11,13,18,0.12)",
  background: "rgba(255,255,255,0.72)",
  color: "#0b0d12",
  textDecoration: "none",
  borderRadius: 14,
  padding: "10px 14px",
  fontSize: 14,
  fontWeight: 900,
  boxShadow: "0 10px 24px rgba(11,13,18,0.08)",
};