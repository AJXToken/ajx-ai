// src/lib/i18n.ts

export type Locale = "fi" | "en" | "es";

export function detectLocale(acceptLanguageHeader?: string | null): Locale {
  const h = (acceptLanguageHeader || "").toLowerCase();
  if (h.includes("es")) return "es";
  if (h.includes("en")) return "en";
  return "fi";
}

type Dict = Record<string, string>;

const FI: Dict = {
  "app.title": "AJX AI",
  "common.ok": "OK",
  "common.cancel": "Peruuta",

  "chat.greeting": "Moi! Miten voin auttaa tänään?",
  "chat.placeholder": "Kirjoita… (Enter = lähetä, Shift+Enter = uusi rivi)",
  "chat.streaming_toggle": "Streaming päälle/pois",
  "chat.send": "Lähetä",

  "usage.messages": "Viestit {used}/{limit}",
  "usage.images": "Kuvat {used}/{limit}",
  "usage.web": "Web {used}/{limit}",

  "image.generating": "🖼️ Generoin kuvaa: {prompt}",
  "image.prompt.ask": "Anna kuvaprompti:",

  "thread.rename": "Uusi nimi keskustelulle:",
  "thread.delete.confirm": "Poistetaanko tämä keskustelu?",
  "thread.title_default": "Keskustelu",

  "ui.new_chat": "+ Uusi keskustelu",
  "ui.rename": "Nimeä uudelleen",
  "ui.delete": "Poista",
  "ui.language": "Kieli",
  "ui.toggle_sidebar": "Avaa/sulje keskustelut",

  "ui.chats": "Keskustelut",
  "ui.msg": "viestiä",
  "ui.interface_2030": "Interface // 2030",

  // AJX Agents (localized)
  "ui.ajx_mode": "AJX-agentit",
  "mode.general": "Yleinen",
  "mode.research": "Tiedonhaku",
  "mode.ideation": "Ideointi",
  "mode.analysis": "Analysointi",
  "mode.strategy": "Strategia",

  // Attachments
  "ui.plus": "Lisää",
  "ui.attach": "Liitä",
  "ui.attach_image": "Liitä kuva",
  "ui.attach_file": "Liitä tiedosto",
  "ui.web_search": "Hae verkosta",
  "ui.attach_clear": "Poista liite",
  "ui.attachments": "Liitteet",

  "ui.create_images": "Luo kuvia",
  "ui.free_messages": "Ilmaiset viestit",
};

const EN: Dict = {
  "app.title": "AJX AI",
  "common.ok": "OK",
  "common.cancel": "Cancel",

  "chat.greeting": "Hi! How can I help today?",
  "chat.placeholder": "Type… (Enter = send, Shift+Enter = new line)",
  "chat.streaming_toggle": "Toggle streaming",
  "chat.send": "Send",

  "usage.messages": "Messages {used}/{limit}",
  "usage.images": "Images {used}/{limit}",
  "usage.web": "Web {used}/{limit}",

  "image.generating": "🖼️ Generating image: {prompt}",
  "image.prompt.ask": "Enter an image prompt:",

  "thread.rename": "New chat name:",
  "thread.delete.confirm": "Delete this chat?",
  "thread.title_default": "Chat",

  "ui.new_chat": "+ New chat",
  "ui.rename": "Rename",
  "ui.delete": "Delete",
  "ui.language": "Language",
  "ui.toggle_sidebar": "Toggle chats",

  "ui.chats": "Chats",
  "ui.msg": "msg",
  "ui.interface_2030": "Interface // 2030",

  // AJX Agents
  "ui.ajx_mode": "AJX Agents",
  "mode.general": "General",
  "mode.research": "Research",
  "mode.ideation": "Ideation",
  "mode.analysis": "Analysis",
  "mode.strategy": "Strategy",

  // Attachments
  "ui.plus": "Add",
  "ui.attach": "Attach",
  "ui.attach_image": "Attach image",
  "ui.attach_file": "Attach file",
  "ui.web_search": "Search the web",
  "ui.attach_clear": "Remove attachment",
  "ui.attachments": "Attachments",

  "ui.create_images": "Create images",
  "ui.free_messages": "Free messages",
};

const ES: Dict = {
  "app.title": "AJX AI",
  "common.ok": "OK",
  "common.cancel": "Cancelar",

  "chat.greeting": "¡Hola! ¿En qué puedo ayudarte hoy?",
  "chat.placeholder": "Escribe… (Enter = enviar, Shift+Enter = nueva línea)",
  "chat.streaming_toggle": "Activar/desactivar streaming",
  "chat.send": "Enviar",

  "usage.messages": "Mensajes {used}/{limit}",
  "usage.images": "Imágenes {used}/{limit}",
  "usage.web": "Web {used}/{limit}",

  "image.generating": "🖼️ Generando imagen: {prompt}",
  "image.prompt.ask": "Escribe un prompt de imagen:",

  "thread.rename": "Nuevo nombre del chat:",
  "thread.delete.confirm": "¿Eliminar este chat?",
  "thread.title_default": "Chat",

  "ui.new_chat": "+ Nuevo chat",
  "ui.rename": "Renombrar",
  "ui.delete": "Eliminar",
  "ui.language": "Idioma",
  "ui.toggle_sidebar": "Mostrar/ocultar chats",

  "ui.chats": "Chats",
  "ui.msg": "msg",
  "ui.interface_2030": "Interface // 2030",

  // AJX Agents
  "ui.ajx_mode": "Agentes AJX",
  "mode.general": "General",
  "mode.research": "Investigación",
  "mode.ideation": "Ideación",
  "mode.analysis": "Análisis",
  "mode.strategy": "Estrategia",

  // Attachments
  "ui.plus": "Añadir",
  "ui.attach": "Adjuntar",
  "ui.attach_image": "Adjuntar imagen",
  "ui.attach_file": "Adjuntar archivo",
  "ui.web_search": "Buscar en la web",
  "ui.attach_clear": "Quitar adjunto",
  "ui.attachments": "Adjuntos",

  "ui.create_images": "Crear imágenes",
  "ui.free_messages": "Mensajes gratis",
};

const DICTS: Record<Locale, Dict> = { fi: FI, en: EN, es: ES };

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[locale] || FI;
  let s = dict[key] ?? FI[key] ?? key;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}