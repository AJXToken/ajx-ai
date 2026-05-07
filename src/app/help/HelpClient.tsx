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
      "AJX AI on yrittäjän käytännön työpari. Se auttaa tekemään valmiita tarjouksia, mainoksia, myyntitekstejä, toimintasuunnitelmia, hinnoittelua, rahoituksen hakemisen pohjia ja yritysongelmien ratkaisuja.",
    backToChat: "← Takaisin chattiin",

    s1: "1. Mitä AJX AI tekee",
    s1items: [
      "tekee valmiita tekstejä, ei pelkkiä neuvoja",
      "auttaa tarjouksissa, mainoksissa, myynnissä, hinnoittelussa ja rahoituksessa",
      "kysyy tarvittaessa muutaman tarkentavan kysymyksen",
      "muuttaa vastauksesi valmiiksi tekstiksi, suunnitelmaksi tai toimintalistaksi",
      "auttaa jäsentämään päätöksiä, mutta ei tee päätöksiä puolestasi",
    ],

    s2: "2. Paras tapa käyttää",
    s2p1:
      "Kirjoita mitä haluat saada aikaan. Kerro toimiala, maa tai alue, tavoite, asiakas ja mahdolliset rajat. Mitä konkreettisempi pyyntö, sitä käyttökelpoisempi vastaus.",
    goodExample: "Hyvä esimerkki",
    badExample: "Heikompi esimerkki",
    goodExampleText:
      "Minulla on ilmanvaihtoalan yritys Costa Blancalla. Tee valmis Facebook-mainos kanavapuhdistuksesta. Ei terveysväitteitä, ei energiansäästöväitteitä, sävy suora ja paikallinen.",
    badExampleText: "Tee mainos.",

    s3: "3. Pikatoiminnot",
    s3items: [
      "Luo tarjous: tekee asiakkaalle lähetettävän tarjouksen",
      "Luo mainos: tekee valmiit mainosversiot",
      "Kasvata myyntiä: antaa käytännön myyntitoimet ja viestipohjat",
      "Hanki asiakkaita: etsii lähestymistavan ja tekee yhteydenottotekstit",
      "Paranna hinnoittelua: auttaa nostamaan katetta järkevästi",
      "Hanki tukia ja rahoitusta: jäsentää realistiset rahoituspolut",
      "Ratkaise yritysongelma: purkaa ongelman ja antaa seuraavat askeleet",
    ],

    s4: "4. Agentit",
    agents: [
      ["Yleinen", "Rento keskustelu, yleinen apu ja arjen sparraus."],
      ["Tiedonhaku", "Faktapainotteinen tapa selvittää, vertailla ja jäsentää tietoa."],
      ["Ideointi", "Ideat, kampanjat, sisällöt ja uudet kulmat."],
      ["Analysointi", "Vertailut, riskit, numerot ja johtopäätökset."],
      ["Strategia", "Suunta, priorisointi, kasvu ja päätöksenteon tuki."],
    ],

    s5: "5. Tasot ja ominaisuudet",
    plans: [
      ["Free", "10 viestiä päivässä. Sopii kokeiluun ja yleisiin kysymyksiin."],
      ["Plus", "Laajempi käyttö, parempi työmuisti ja yrittäjän pikatoiminnot."],
      ["Pro", "Laajemmat analyysit, web-haku ja vaativampi työskentely."],
      ["Company", "Laajin taso strategiaan, analyysiin ja yrityskäyttöön."],
    ],

    s6: "6. Esimerkkipyynnöt",
    prompts: [
      ["Tarjous", "Tee valmis tarjous ilmanvaihtokanavien puhdistuksesta. Asiakas on [asiakas], hinta on [hinta], työ tehdään [aikataulu]."],
      ["Mainos", "Tee kolme lyhyttä Facebook-mainosta palvelulle [palvelu] alueella [alue]. Kirjoita kuin paikallinen yrittäjä, ei markkinointihypeä."],
      ["Myynti", "Tee 7 päivän suunnitelma, jolla saan 20 uutta yrityskontaktia palvelulle [palvelu]. Lisää valmis viestipohja."],
      ["Hinnoittelu", "Auta hinnoittelemaan palvelu. Työ kestää [aika], kulut ovat [kulut], tavoitekate on [kate]."],
    ],

    s7: "7. Tärkeää",
    s7items: [
      "AJX AI voi tehdä virheitä.",
      "Tarkista tärkeät tiedot aina virallisista lähteistä.",
      "AJX AI ei korvaa juridista, taloudellista, verotuksellista, lääketieteellistä tai muuta ammattilaisen neuvontaa.",
      "Lopullinen vastuu päätöksistä on käyttäjällä.",
      "Rahoitukset, tuet, lait, verotus, hinnat ja ehdot voivat muuttua.",
    ],
  },

  en: {
    brand: "AJX AI",
    title: "Help",
    intro:
      "AJX AI is a practical work partner for entrepreneurs. It helps create ready-to-use offers, ads, sales texts, action plans, pricing drafts, funding paths, and business problem solutions.",
    backToChat: "← Back to chat",

    s1: "1. What AJX AI does",
    s1items: [
      "creates ready-to-use outputs, not just advice",
      "helps with offers, ads, sales, pricing, marketing, and funding",
      "asks a few clarifying questions when needed",
      "turns your answers into a finished text, plan, or action list",
      "supports decisions, but does not make decisions for you",
    ],

    s2: "2. Best way to use it",
    s2p1:
      "Write what you want to achieve. Mention your industry, country or area, goal, customer, and limits. The more concrete your request is, the more useful the answer will be.",
    goodExample: "Good example",
    badExample: "Weaker example",
    goodExampleText:
      "I run a ventilation business in Costa Blanca. Create a Facebook ad for duct cleaning. No health claims, no energy-saving claims, direct local tone.",
    badExampleText: "Make an ad.",

    s3: "3. Quick actions",
    s3items: [
      "Create offer: creates a customer-ready offer",
      "Create ad: creates ready ad versions",
      "Grow sales: gives practical sales actions and message templates",
      "Get customers: creates outreach paths and contact texts",
      "Improve pricing: helps improve margin realistically",
      "Find grants & funding: structures realistic funding paths",
      "Solve problem: breaks down the issue and gives next steps",
    ],

    s4: "4. Agents",
    agents: [
      ["General", "Relaxed conversation, general help, and everyday sparring."],
      ["Research", "Fact-focused help for finding, comparing, and structuring information."],
      ["Ideation", "Ideas, campaigns, content, and new angles."],
      ["Analysis", "Comparisons, risks, numbers, and conclusions."],
      ["Strategy", "Direction, prioritization, growth, and decision support."],
    ],

    s5: "5. Tasot ja ominaisuudet",
    plans: [
      ["Free", "10 messages per day. Good for testing and general questions."],
      ["Plus", "Broader usage, better working memory, and entrepreneur quick actions."],
      ["Pro", "Broader analysis, web search, and more demanding work."],
      ["Company", "The widest level for strategy, analysis, and business use."],
    ],

    s6: "6. Example prompts",
    prompts: [
      ["Offer", "Create a ready offer for duct cleaning. Customer is [customer], price is [price], work is done [schedule]."],
      ["Ad", "Create three short Facebook ads for [service] in [area]. Write like a local entrepreneur, no marketing hype."],
      ["Sales", "Create a 7-day plan to get 20 new business contacts for [service]. Add a ready message template."],
      ["Pricing", "Help price this service. Work takes [time], costs are [costs], target margin is [margin]."],
    ],

    s7: "7. Important",
    s7items: [
      "AJX AI can make mistakes.",
      "Always verify important information from official sources.",
      "AJX AI does not replace legal, financial, tax, medical, or other professional advice.",
      "Final responsibility for decisions remains with the user.",
      "Funding, grants, laws, taxes, prices, and terms can change.",
    ],
  },

  es: {
    brand: "AJX AI",
    title: "Ayuda",
    intro:
      "AJX AI es un compañero práctico para emprendedores. Ayuda a crear ofertas, anuncios, textos de venta, planes de acción, precios, financiación y soluciones de negocio listas para usar.",
    backToChat: "← Volver al chat",

    s1: "1. Qué hace AJX AI",
    s1items: [
      "crea resultados listos para usar, no solo consejos",
      "ayuda con ofertas, anuncios, ventas, precios, marketing y financiación",
      "hace algunas preguntas concretas cuando hace falta",
      "convierte tus respuestas en un texto, plan o lista de acciones",
      "apoya decisiones, pero no decide por ti",
    ],

    s2: "2. Mejor forma de usarlo",
    s2p1:
      "Escribe qué quieres conseguir. Indica sector, país o zona, objetivo, cliente y límites. Cuanto más concreta sea la petición, más útil será la respuesta.",
    goodExample: "Buen ejemplo",
    badExample: "Ejemplo más débil",
    goodExampleText:
      "Tengo una empresa de ventilación en Costa Blanca. Crea un anuncio de Facebook para limpieza de conductos. Sin promesas de salud, sin ahorro energético, tono local y directo.",
    badExampleText: "Haz un anuncio.",

    s3: "3. Acciones rápidas",
    s3items: [
      "Crear oferta: crea una oferta lista para enviar",
      "Crear anuncio: crea versiones de anuncio listas",
      "Aumentar ventas: da acciones prácticas y mensajes",
      "Conseguir clientes: crea textos de contacto y canales",
      "Mejorar precios: ayuda a mejorar margen de forma realista",
      "Buscar ayudas y financiación: ordena vías realistas",
      "Resolver problema: divide el problema y da próximos pasos",
    ],

    s4: "4. Agentes",
    agents: [
      ["General", "Conversación relajada, ayuda general y apoyo diario."],
      ["Búsqueda", "Ayuda basada en hechos para buscar, comparar y ordenar información."],
      ["Ideación", "Ideas, campañas, contenidos y nuevos enfoques."],
      ["Análisis", "Comparaciones, riesgos, números y conclusiones."],
      ["Estrategia", "Dirección, prioridades, crecimiento y apoyo en decisiones."],
    ],

    s5: "5. Tasot ja ominaisuudet",
    plans: [
      ["Free", "10 mensajes al día. Bueno para probar y preguntas generales."],
      ["Plus", "Más uso, mejor memoria de trabajo y acciones rápidas para emprendedores."],
      ["Pro", "Más análisis, búsqueda web y trabajo más exigente."],
      ["Company", "El nivel más amplio para estrategia, análisis y uso empresarial."],
    ],

    s6: "6. Ejemplos de prompts",
    prompts: [
      ["Oferta", "Crea una oferta lista para limpieza de conductos. Cliente: [cliente], precio: [precio], fecha: [fecha]."],
      ["Anuncio", "Crea tres anuncios cortos de Facebook para [servicio] en [zona]. Escribe como una empresa local, sin exageración."],
      ["Ventas", "Crea un plan de 7 días para conseguir 20 contactos empresariales para [servicio]. Añade un mensaje listo."],
      ["Precios", "Ayúdame a fijar el precio. El trabajo tarda [tiempo], costes [costes], margen objetivo [margen]."],
    ],

    s7: "7. Importante",
    s7items: [
      "AJX AI puede cometer errores.",
      "Verifica siempre la información importante desde fuentes oficiales.",
      "AJX AI no sustituye asesoramiento legal, financiero, fiscal, médico ni profesional.",
      "La responsabilidad final de las decisiones es del usuario.",
      "Financiación, ayudas, leyes, impuestos, precios y condiciones pueden cambiar.",
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
    <main style={mainStyle}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={topRowStyle}>
          <a href={chatHref} onClick={handleBack} style={topLinkStyle}>
            {c.backToChat}
          </a>
        </div>

        <div style={panelStyle}>
          <div style={{ marginBottom: 28 }}>
            <div style={brandStyle}>{c.brand}</div>
            <h1 style={h1Style}>{c.title}</h1>
            <p style={introStyle}>{c.intro}</p>
          </div>

          <Section title={c.s1}>
            <ul style={listStyle}>
              {c.s1items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>

          <Section title={c.s2}>
            <p style={pStyle}>{c.s2p1}</p>

            <div style={exampleBoxStyle}>
              <div style={exampleLabelStyle}>{c.goodExample}</div>
              <div style={exampleTextStyle}>{c.goodExampleText}</div>
            </div>

            <div style={exampleBoxStyle}>
              <div style={exampleLabelStyle}>{c.badExample}</div>
              <div style={exampleTextStyle}>{c.badExampleText}</div>
            </div>
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
              {c.agents.map(([title, text]) => (
                <InfoCard key={title} title={title} text={text} />
              ))}
            </div>
          </Section>

          <Section title={c.s5}>
            <div style={gridStyle}>
              {c.plans.map(([title, text]) => (
                <InfoCard key={title} title={title} text={text} />
              ))}
            </div>
          </Section>

          <Section title={c.s6}>
            <div style={gridStyle}>
              {c.prompts.map(([title, prompt]) => (
                <PromptCard key={title} title={title} prompt={prompt} />
              ))}
            </div>
          </Section>

          <Section title={c.s7}>
            <ul style={listStyle}>
              {c.s7items.map((item) => (
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
    <section style={{ marginTop: 30 }}>
      <h2 style={h2Style}>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div style={cardStyle}>
      <div style={cardTitleStyle}>{title}</div>
      <div style={cardTextStyle}>{text}</div>
    </div>
  );
}

function PromptCard({ title, prompt }: { title: string; prompt: string }) {
  return (
    <div style={cardStyle}>
      <div style={cardTitleStyle}>{title}</div>
      <div style={promptStyle}>{prompt}</div>
    </div>
  );
}

const mainStyle: React.CSSProperties = {
  minHeight: "100dvh",
  background: "linear-gradient(180deg, #f6f7fb 0%, #eef1f6 55%, #e8ebf2 100%)",
  color: "#0b0d12",
  padding: "24px",
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
};

const topRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  marginBottom: 16,
};

const panelStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.86)",
  border: "1px solid rgba(11,13,18,0.08)",
  borderRadius: 26,
  padding: 26,
  boxShadow: "0 28px 90px rgba(11,13,18,0.16)",
  backdropFilter: "blur(10px)",
};

const brandStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#15803d",
  marginBottom: 8,
};

const h1Style: React.CSSProperties = {
  margin: 0,
  fontSize: 36,
  lineHeight: 1.08,
  fontWeight: 950,
};

const h2Style: React.CSSProperties = {
  margin: "0 0 12px 0",
  fontSize: 22,
  lineHeight: 1.2,
  fontWeight: 950,
};

const introStyle: React.CSSProperties = {
  marginTop: 12,
  marginBottom: 0,
  fontSize: 16,
  lineHeight: 1.65,
  color: "rgba(11,13,18,0.74)",
  maxWidth: 800,
};

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
  color: "rgba(11,13,18,0.82)",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gap: 12,
};

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(11,13,18,0.08)",
  background: "rgba(255,255,255,0.78)",
  borderRadius: 18,
  padding: 16,
  marginBottom: 0,
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 950,
  marginBottom: 6,
};

const cardTextStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.6,
  color: "rgba(11,13,18,0.74)",
};

const promptStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: "rgba(11,13,18,0.80)",
  whiteSpace: "pre-wrap",
};

const exampleBoxStyle: React.CSSProperties = {
  border: "1px solid rgba(11,13,18,0.08)",
  background: "rgba(255,255,255,0.78)",
  borderRadius: 18,
  padding: 16,
  marginBottom: 12,
};

const exampleLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 950,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  color: "rgba(11,13,18,0.58)",
  marginBottom: 8,
};

const exampleTextStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.65,
  color: "rgba(11,13,18,0.84)",
};

const topLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid rgba(11,13,18,0.12)",
  background: "rgba(255,255,255,0.76)",
  color: "#0b0d12",
  textDecoration: "none",
  borderRadius: 14,
  padding: "10px 14px",
  fontSize: 14,
  fontWeight: 900,
  boxShadow: "0 10px 24px rgba(11,13,18,0.08)",
};

